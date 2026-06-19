const express = require('express');
const multer = require('multer');
const { verifyToken } = require('../middleware/auth');
const supabase = require('../lib/supabase');
const { createJob, getJob, processVoiceUpload } = require('../lib/voice-processor');

const router = express.Router();

// 500MB max file size for Instagram data exports
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed' ||
        file.originalname.endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('Only .zip files are accepted'));
    }
  },
});

/**
 * Helper: get brand_id for authenticated user
 */
async function getBrandId(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('brand_id')
    .eq('id', userId)
    .single();

  if (error || !data) return null;
  return data.brand_id;
}

// ─── POST /api/voice/upload ─────────────────────────────────────────
// Accepts multipart form with zip file + brand_id, returns job_id
router.post('/upload', verifyToken, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File too large. Maximum size is 500MB.' });
      }
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No zip file uploaded.' });
    }

    const brandId = await getBrandId(req.user.user_id);
    if (!brandId) {
      return res.status(400).json({ error: 'Brand not found for user.' });
    }

    // Create job and start async processing
    const jobId = createJob(brandId);

    // Fire-and-forget — processing runs in the background
    processVoiceUpload(req.file.buffer, brandId, jobId);

    return res.json({ job_id: jobId });
  } catch (err) {
    console.error('Voice upload error:', err);
    return res.status(500).json({ error: 'Failed to start voice processing.' });
  }
});

// ─── GET /api/voice/status/:job_id ──────────────────────────────────
// Returns processing status and progress
router.get('/status/:job_id', verifyToken, (req, res) => {
  const job = getJob(req.params.job_id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found.' });
  }

  const response = {
    status: job.status,
    progress: job.progress,
  };

  if (job.status === 'failed' && job.error) {
    response.error = job.error;
  }

  return res.json(response);
});

// ─── GET /api/voice/profile/:brand_id ───────────────────────────────
// Returns the analyzed voice profile for a brand
router.get('/profile/:brand_id', verifyToken, async (req, res) => {
  try {
    // Verify user belongs to this brand
    const userBrandId = await getBrandId(req.user.user_id);
    if (userBrandId !== req.params.brand_id) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const { data, error } = await supabase
      .from('voice_profiles')
      .select('*')
      .eq('brand_id', req.params.brand_id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'No voice profile found for this brand.' });
    }

    return res.json(data);
  } catch (err) {
    console.error('Get voice profile error:', err);
    return res.status(500).json({ error: 'Failed to fetch voice profile.' });
  }
});

// ─── PATCH /api/voice/profile/:brand_id ─────────────────────────────
// Updates fields the user edited/approved in the voice profile
router.patch('/profile/:brand_id', verifyToken, async (req, res) => {
  try {
    const userBrandId = await getBrandId(req.user.user_id);
    if (userBrandId !== req.params.brand_id) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const updates = req.body;
    if (!updates || Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No updates provided.' });
    }

    // Fetch current profile
    const { data: existing, error: fetchError } = await supabase
      .from('voice_profiles')
      .select('profile')
      .eq('brand_id', req.params.brand_id)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({ error: 'No voice profile found for this brand.' });
    }

    // Merge updates into existing profile
    const mergedProfile = { ...existing.profile, ...updates };

    const { data, error } = await supabase
      .from('voice_profiles')
      .update({
        profile: mergedProfile,
        updated_at: new Date().toISOString(),
      })
      .eq('brand_id', req.params.brand_id)
      .select()
      .single();

    if (error) {
      console.error('Update voice profile error:', error);
      return res.status(500).json({ error: 'Failed to update voice profile.' });
    }

    return res.json(data);
  } catch (err) {
    console.error('Patch voice profile error:', err);
    return res.status(500).json({ error: 'Failed to update voice profile.' });
  }
});

// ─── POST /api/voice/profile/:brand_id/activate ─────────────────────
// Marks the profile as active so it gets injected into Luna's system prompt
router.post('/profile/:brand_id/activate', verifyToken, async (req, res) => {
  try {
    const userBrandId = await getBrandId(req.user.user_id);
    if (userBrandId !== req.params.brand_id) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    // Check profile exists
    const { data: existing, error: fetchError } = await supabase
      .from('voice_profiles')
      .select('id')
      .eq('brand_id', req.params.brand_id)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({ error: 'No voice profile found for this brand.' });
    }

    const { data, error } = await supabase
      .from('voice_profiles')
      .update({
        is_active: true,
        updated_at: new Date().toISOString(),
      })
      .eq('brand_id', req.params.brand_id)
      .select()
      .single();

    if (error) {
      console.error('Activate voice profile error:', error);
      return res.status(500).json({ error: 'Failed to activate voice profile.' });
    }

    return res.json({ message: 'Voice profile activated.', data });
  } catch (err) {
    console.error('Activate voice profile error:', err);
    return res.status(500).json({ error: 'Failed to activate voice profile.' });
  }
});

// ─── POST /api/voice/profile/:brand_id/deactivate ───────────────────
// Marks the profile as inactive
router.post('/profile/:brand_id/deactivate', verifyToken, async (req, res) => {
  try {
    const userBrandId = await getBrandId(req.user.user_id);
    if (userBrandId !== req.params.brand_id) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const { data: existing, error: fetchError } = await supabase
      .from('voice_profiles')
      .select('id')
      .eq('brand_id', req.params.brand_id)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({ error: 'No voice profile found for this brand.' });
    }

    const { data, error } = await supabase
      .from('voice_profiles')
      .update({
        is_active: false,
        updated_at: new Date().toISOString(),
      })
      .eq('brand_id', req.params.brand_id)
      .select()
      .single();

    if (error) {
      console.error('Deactivate voice profile error:', error);
      return res.status(500).json({ error: 'Failed to deactivate voice profile.' });
    }

    return res.json({ message: 'Voice profile deactivated.', data });
  } catch (err) {
    console.error('Deactivate voice profile error:', err);
    return res.status(500).json({ error: 'Failed to deactivate voice profile.' });
  }
});

module.exports = router;
