// Sultini Express — Supabase connection
// This file is safe to be public: the anon key only allows what our
// Row Level Security policies permit (e.g. anyone can view approved
// vendors, but only a logged-in customer can see their own orders).
// NEVER put the service_role key in this file or any file that ships
// to the browser.

const SUPABASE_URL = "https://ogekcyveflfmqltolwka.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_rLOgFT8UMefg1rWbLGWe4A_geEZ5Wz4";

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
