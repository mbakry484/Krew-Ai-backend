const OpenAI = require('openai');

const provider = (process.env.AI_PROVIDER || 'openai').toLowerCase();
//ok
let client;
let defaultModel;
let visionModel;

if (provider === 'groq') {
  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is required when AI_PROVIDER=groq');
  }
  client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY.trim(),
    baseURL: 'https://api.groq.com/openai/v1',
  });
  // Change these to whichever Groq model you want to test
  defaultModel = 'llama-3.3-70b-versatile';
  visionModel = 'meta-llama/llama-4-scout-17b-16e-instruct';
  console.log(`✅ AI Provider: Groq (model: ${defaultModel})`);
} else {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required when AI_PROVIDER=openai');
  }
  const apiKey = process.env.OPENAI_API_KEY.trim();
  if (apiKey.length < 20 || apiKey.includes('\n') || apiKey.includes('\r')) {
    throw new Error('OPENAI_API_KEY is malformed');
  }
  client = new OpenAI({ apiKey });
  defaultModel = 'gpt-4.1';
  visionModel = 'gpt-4o';
  console.log(`✅ AI Provider: OpenAI (model: ${defaultModel})`);
}

module.exports = { client, defaultModel, visionModel, provider };
