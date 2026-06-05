const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
// Use the service role key so the backend bypasses RLS.
// NEVER expose this key to the frontend or public clients.
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Environment check:');
  console.error('SUPABASE_URL:', supabaseUrl ? 'SET' : 'MISSING');
  console.error('SUPABASE_SERVICE_ROLE_KEY:', process.env.SUPABASE_SERVICE_ROLE_KEY ? 'SET' : 'MISSING');
  console.error('SUPABASE_KEY (fallback):', process.env.SUPABASE_KEY ? 'SET' : 'MISSING');
  throw new Error('Missing Supabase environment variables: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
}

console.log('[supabase] using key type:', process.env.SUPABASE_SERVICE_ROLE_KEY ? 'service_role' : 'anon');

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    // Disable auto session management — this is a server-side client
    persistSession: false,
    autoRefreshToken: false,
  },
});

module.exports = supabase;
