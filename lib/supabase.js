const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing Supabase environment variables: SUPABASE_URL and SUPABASE_KEY are required');
}

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;
