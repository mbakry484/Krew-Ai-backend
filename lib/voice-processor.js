const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { client: openai } = require('./ai-provider');
const supabase = require('./supabase');

// In-memory job store (sufficient for single-instance deployment)
const jobs = new Map();

/**
 * Create a new processing job
 * @param {string} brandId
 * @returns {string} jobId
 */
function createJob(brandId) {
  const jobId = `voice_${brandId}_${Date.now()}`;
  jobs.set(jobId, {
    brandId,
    status: 'processing',
    progress: 0,
    error: null,
  });
  return jobId;
}

/**
 * Get job status
 * @param {string} jobId
 * @returns {object|null}
 */
function getJob(jobId) {
  return jobs.get(jobId) || null;
}

/**
 * Decode double-encoded UTF-8 text (Instagram export encodes Arabic/unicode twice)
 * Equivalent to Python: text.encode('latin-1').decode('utf-8')
 * @param {string} text
 * @returns {string}
 */
function decodeDoubleEncodedUtf8(text) {
  try {
    // Convert each character to its latin-1 byte value, then decode as UTF-8
    const bytes = Buffer.from(text, 'latin1');
    return bytes.toString('utf8');
  } catch {
    return text;
  }
}

/**
 * Check if a message is just emojis, stickers, or reactions (should be skipped)
 * @param {string} content
 * @returns {boolean}
 */
function isSkippableMessage(content) {
  if (!content || typeof content !== 'string') return true;
  const trimmed = content.trim();
  if (trimmed.length === 0) return true;

  // Remove all emoji characters and whitespace — if nothing remains, it's emoji-only
  const withoutEmojis = trimmed.replace(/[\p{Emoji_Presentation}\p{Emoji}\u200d\ufe0f\u20e3\u{1f3fb}-\u{1f3ff}]/gu, '').trim();
  if (withoutEmojis.length === 0) return true;

  // Skip common reaction/sticker patterns from Instagram exports
  const skipPatterns = [
    /^liked a message$/i,
    /^reacted .+ to your message$/i,
    /^sent an attachment\.?$/i,
    /^you sent an attachment\.?$/i,
  ];
  return skipPatterns.some((p) => p.test(trimmed));
}

/**
 * Extract and process Instagram chat export zip
 * @param {Buffer} zipBuffer - The uploaded zip file buffer
 * @param {string} brandId
 * @param {string} jobId
 */
async function processVoiceUpload(zipBuffer, brandId, jobId) {
  const job = jobs.get(jobId);
  let tempDir = null;

  try {
    // Step 1 — Extract zip to temp directory
    job.progress = 5;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-'));
    const zip = new AdmZip(zipBuffer);
    zip.extractAllTo(tempDir, true);
    job.progress = 15;

    // Step 2 — Recursively find all message_*.json files under messages/inbox/
    const messageFiles = findMessageFiles(tempDir);
    if (messageFiles.length === 0) {
      job.status = 'failed';
      job.error = 'No chat history detected — could not find any message files in the Instagram export.';
      job.progress = 100;
      return;
    }
    job.progress = 25;

    // Step 3 — Parse messages and identify brand sender
    const allBrandMessages = [];
    const senderCounts = {};

    for (const filePath of messageFiles) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(raw);
        if (!data.messages || !Array.isArray(data.messages)) continue;

        // Count sender frequency across all files to identify brand account
        for (const msg of data.messages) {
          if (msg.sender_name) {
            const decoded = decodeDoubleEncodedUtf8(msg.sender_name);
            senderCounts[decoded] = (senderCounts[decoded] || 0) + 1;
          }
        }
      } catch {
        // Skip unparseable files
      }
    }

    // The brand's sender_name is the one that appears most frequently
    const brandSender = Object.entries(senderCounts)
      .sort((a, b) => b[1] - a[1])[0]?.[0];

    if (!brandSender) {
      job.status = 'failed';
      job.error = 'Could not identify brand account in chat history.';
      job.progress = 100;
      return;
    }
    job.progress = 35;

    // Step 3 continued — Extract brand messages with decoded content
    for (const filePath of messageFiles) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(raw);
        if (!data.messages || !Array.isArray(data.messages)) continue;

        for (const msg of data.messages) {
          const sender = decodeDoubleEncodedUtf8(msg.sender_name || '');
          if (sender !== brandSender) continue;

          const content = msg.content ? decodeDoubleEncodedUtf8(msg.content) : '';
          if (isSkippableMessage(content)) continue;

          allBrandMessages.push({
            content,
            timestamp_ms: msg.timestamp_ms || 0,
          });
        }
      } catch {
        // Skip unparseable files
      }
    }

    if (allBrandMessages.length === 0) {
      job.status = 'failed';
      job.error = 'No usable brand messages found in the chat history.';
      job.progress = 100;
      return;
    }
    job.progress = 50;

    // Step 4 — Sort by timestamp descending and cap at 300 most recent
    allBrandMessages.sort((a, b) => b.timestamp_ms - a.timestamp_ms);
    const recentMessages = allBrandMessages.slice(0, 300);
    const corpus = recentMessages.map((m) => m.content).join('\n---\n');
    const sampleSize = recentMessages.length;

    job.progress = 60;

    // Step 5 — Send to GPT-4o for voice analysis
    const analysisPrompt = `You are analyzing real customer service replies from a brand's Instagram DM history. Extract their voice profile. Return ONLY valid JSON matching this schema:

{
  "tone": ["string (3-5 keywords like 'friendly', 'direct', 'warm')"],
  "greeting_style": { "example": "string", "notes": "string" },
  "closing_style": { "example": "string", "notes": "string" },
  "complaint_handling": { "approach": "string", "example": "string" },
  "order_status_replies": { "example": "string", "notes": "string" },
  "emoji_usage": "none | light | moderate | heavy",
  "language_mix": { "english": 0, "arabic": 0, "franco_arabic": 0 },
  "signature_phrases": ["string (5-10 recurring phrases)"],
  "formality": "very_casual | casual | neutral | formal",
  "message_length": "short | medium | long",
  "summary": "string (2-3 sentence overview of voice)"
}

Here are the brand's most recent ${sampleSize} customer service messages:

${corpus}`;

    let profile = null;
    let attempts = 0;
    const maxAttempts = 2;

    while (attempts < maxAttempts && !profile) {
      attempts++;
      try {
        const completion = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: analysisPrompt }],
          max_tokens: 2000,
          temperature: 0.3,
          response_format: { type: 'json_object' },
        });

        const raw = completion.choices[0].message.content;
        profile = JSON.parse(raw);
      } catch (err) {
        console.error(`Voice analysis GPT attempt ${attempts} failed:`, err.message);
        if (attempts >= maxAttempts) {
          job.status = 'failed';
          job.error = 'Voice analysis failed after retrying. Please try again later.';
          job.progress = 100;
          return;
        }
      }
    }

    job.progress = 85;

    // Step 6 — Save to Supabase voice_profiles table
    const { error: upsertError } = await supabase
      .from('voice_profiles')
      .upsert(
        {
          brand_id: brandId,
          profile,
          is_active: false,
          sample_size: sampleSize,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'brand_id' }
      );

    if (upsertError) {
      console.error('Failed to save voice profile:', upsertError);
      job.status = 'failed';
      job.error = 'Failed to save voice profile to database.';
      job.progress = 100;
      return;
    }

    job.status = 'ready';
    job.progress = 100;
    console.log(`✅ Voice profile ready for brand ${brandId} (${sampleSize} messages analyzed)`);
  } catch (err) {
    console.error('Voice processing error:', err);
    job.status = 'failed';
    job.error = err.message || 'Unexpected error during voice processing.';
    job.progress = 100;
  } finally {
    // Clean up temp directory
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

/**
 * Recursively find all message_*.json files under any messages/inbox/ directory
 * @param {string} dir - Root directory to search
 * @returns {string[]} Array of file paths
 */
function findMessageFiles(dir) {
  const results = [];

  function walk(currentDir) {
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        // Match message_*.json files that live under a messages/inbox/ parent
        const normalized = fullPath.replace(/\\/g, '/');
        if (
          /messages\/inbox\//i.test(normalized) &&
          /^message_\d+\.json$/i.test(entry.name)
        ) {
          results.push(fullPath);
        }
      }
    }
  }

  walk(dir);
  return results;
}

/**
 * Get the active voice profile for a brand (used at runtime for prompt injection)
 * @param {string} brandId
 * @returns {object|null} The voice profile or null
 */
async function getActiveVoiceProfile(brandId) {
  const { data, error } = await supabase
    .from('voice_profiles')
    .select('profile')
    .eq('brand_id', brandId)
    .eq('is_active', true)
    .single();

  if (error || !data) return null;
  return data.profile;
}

module.exports = {
  createJob,
  getJob,
  processVoiceUpload,
  getActiveVoiceProfile,
};
