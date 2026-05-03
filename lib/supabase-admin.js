const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.error('⚠️  SUPABASE_SERVICE_ROLE_KEY is missing — luna_usage_logs inserts will fail');
}

const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey || '', {
  auth: { persistSession: false }
});

module.exports = supabaseAdmin;
