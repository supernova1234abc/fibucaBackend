// supabaseClient.js
const { createClient } = require('@supabase/supabase-js');

// ✅ Use your environment variables
const supabaseUrl = process.env.VITE_APP_SUPABASE_URL;
const supabaseKey = process.env.VITE_APP_SUPABASE_ANON_KEY; // use service role key on backend

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    'Supabase config missing. Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env'
  );
}

// ✅ Create client instance
const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;
