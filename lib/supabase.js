const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Environment check:');
  console.error('SUPABASE_URL:', supabaseUrl ? 'SET' : 'MISSING');
  console.error('SUPABASE_KEY:', supabaseKey ? 'SET' : 'MISSING');
  console.error('All env vars:', Object.keys(process.env).filter(k => k.includes('SUPABASE')));
  throw new Error('Missing Supabase environment variables: SUPABASE_URL and SUPABASE_KEY are required');
}

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;
