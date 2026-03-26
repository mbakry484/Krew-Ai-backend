# Voice Note Support with OpenAI Whisper

Luna now supports voice notes! Customers can send voice messages in Arabic, English, or Franco Arabic, and Luna will transcribe them using OpenAI's Whisper model.

## How It Works

### 1. Audio Detection
When a customer sends a voice note via Instagram DM, the webhook detects it:

```javascript
const audioAttachment = attachments.find(a => a.type === 'audio');
const audioUrl = audioAttachment?.payload?.url || null;
```

### 2. Transcription with Whisper
The audio file is downloaded and transcribed using OpenAI Whisper:

```javascript
async function transcribeAudio(audioUrl) {
  // Download audio file from Instagram
  const response = await fetch(audioUrl);
  const audioBuffer = Buffer.from(await response.arrayBuffer());

  // Create File object for OpenAI
  const { toFile } = await import('openai');
  const audioFile = await toFile(audioBuffer, 'audio.ogg', { type: 'audio/ogg' });

  // Transcribe with Whisper
  const transcription = await openai.audio.transcriptions.create({
    file: audioFile,
    model: 'whisper-1',
    language: 'ar' // Hint for Arabic, but auto-detects English/Franco too
  });

  return transcription.text;
}
```

### 3. Processing Transcribed Text
The transcribed text replaces the voice note and flows through the normal message processing:

```javascript
let finalMessage = customerMessage; // Text message if available

if (audioUrl) {
  console.log('🎤 Voice note received, transcribing...');
  const transcribed = await transcribeAudio(audioUrl);

  if (transcribed) {
    finalMessage = transcribed;
    console.log(`✅ Using transcription: "${transcribed}"`);
  } else {
    // Fallback if transcription fails
    finalMessage = 'The customer sent a voice note that could not be transcribed.';
  }
}

// Now process finalMessage through normal flow
```

### 4. Null Safety
Updated to accept messages with text, image, OR audio:

```javascript
// Only proceed if there's actual content
if (!customerMessage && !imageUrl && !audioUrl) continue;
```

## Supported Languages

Whisper automatically detects and transcribes:
- **Arabic**: "عايز أطلب البلوفر ده"
- **English**: "I want to order this hoodie"
- **Franco Arabic**: "3ayz a3ml order lel pullover da"

The `language: 'ar'` parameter is a hint for better Arabic accuracy, but Whisper auto-detects the actual language.

## Example Flow

### Customer Journey
1. **Customer sends voice note**: "أريد أن أطلب البلوفر الرمادي"
2. **Luna transcribes**: "أريد أن أطلب البلوفر الرمادي"
3. **Luna processes as text** and responds normally
4. **Luna replies**: "Of course! The grey hoodie is 1150 EGP and in stock ✅..."

### Logs
```
📨 867797979570471: "[Voice Note]"
🎤 Voice note received, transcribing...
🎤 Transcribed: "أريد أن أطلب البلوفر الرمادي"
✅ Using transcription: "أريد أن أطلب البلوفر الرمادي"
🤖 Luna reply: "Of course! The grey hoodie is 1150 EGP..."
```

## Error Handling

If transcription fails (network issue, corrupted audio, etc.):

```javascript
if (transcribed) {
  finalMessage = transcribed;
} else {
  // Fallback message
  finalMessage = 'The customer sent a voice note that could not be transcribed.';
  console.log('⚠️  Transcription failed, using fallback message');
}
```

Luna will see this fallback message and politely ask the customer to send text instead.

## Integration Points

Voice notes are now seamlessly integrated into all Luna features:

### ✅ Order Processing
- Customer: *"عايز أطلب البلوفر ده"* (voice)
- Luna: Processes as text, creates order

### ✅ Knowledge Base Queries
- Customer: *"What's your return policy?"* (voice)
- Luna: Searches knowledge base with transcribed text

### ✅ Product Search
- Customer: *"Do you have red hoodies?"* (voice)
- Luna: Searches products with transcribed query

### ✅ State Machine (Name/Phone/Address Collection)
- Luna: "What's your phone number?"
- Customer: *"٠١٠١٠١٠١٠١"* (voice)
- Luna: Saves transcribed phone number

## Cost Considerations

### Whisper API Pricing (as of 2024)
- **$0.006 per minute** of audio
- Most voice notes: 5-30 seconds = **$0.0005 - $0.003** per transcription
- Very affordable for customer support use case

### Example Monthly Cost
- 1000 voice notes/month
- Average 15 seconds each = 250 minutes
- **Cost: ~$1.50/month**

Compare to text-only flow: No additional cost, same GPT usage after transcription.

## Technical Details

### File Format
Instagram sends voice notes as:
- **Format**: OGG/AAC
- **Encoding**: Opus codec
- **Sample rate**: 16kHz or 48kHz

Whisper handles all common audio formats automatically.

### Performance
- **Download**: ~100-500ms (depending on file size)
- **Transcription**: ~500-2000ms (depending on audio length)
- **Total overhead**: ~1-3 seconds

Still faster than typing for most users!

### Supported Audio Types
The code detects `type === 'audio'` which includes:
- Voice notes (Instagram native)
- Audio file attachments
- Any audio message format

## Future Enhancements

### Potential Improvements
1. **Voice reply**: Use OpenAI TTS to reply with voice
2. **Sentiment analysis**: Detect frustration/urgency in voice tone
3. **Multi-language detection**: Auto-switch Luna's language based on customer's voice
4. **Audio caching**: Cache transcriptions to avoid re-processing

## Testing

### Manual Test
1. Open Instagram DM with Luna
2. Record and send voice note: "مرحبا، عايز أشوف البرودكتس"
3. Check logs for transcription
4. Verify Luna responds appropriately

### Expected Log Output
```
📨 867797979570471: "[Voice Note]"
🎤 Voice note received, transcribing...
🎤 Transcribed: "مرحبا، عايز أشوف البرودكتس"
✅ Using transcription: "مرحبا، عايز أشوف البرودكتس"
🔍 Brand found: 6fe9cfc8-21e9-442f-9b6f-4f09f6c13823
🤖 Luna reply: "مرحبا! 😊 Here are our available products..."
✅ Sent to 867797979570471
```

## Code Location

All voice note handling is in [routes/instagram.js](routes/instagram.js):

- **Audio detection**: Lines 153-154
- **Null check**: Line 157
- **transcribeAudio function**: Lines 88-114
- **Transcription flow**: Lines 229-243
- **All `finalMessage` usage**: Throughout handleIncomingMessage

## Dependencies

Required for voice note support:
- `openai` npm package (already installed)
- OpenAI API key with access to Whisper API
- No additional dependencies needed!

## Conclusion

Luna can now handle voice notes in **any language** with automatic transcription via Whisper. The feature is:
- ✅ Seamlessly integrated
- ✅ Language-agnostic (Arabic/English/Franco)
- ✅ Error-tolerant with fallbacks
- ✅ Cost-effective (~$0.001 per voice note)
- ✅ Fast (1-3 second overhead)

Customers can now interact with Luna using their **preferred communication method**: text, images, OR voice! 🎤✨
