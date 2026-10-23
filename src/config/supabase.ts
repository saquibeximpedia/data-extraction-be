import { createClient } from '@supabase/supabase-js';
import { env } from './env';

/**
 * Server-side Supabase client with the service role key: verifies callers' tokens, records runs
 * and month status, and writes extracted files to the Storage bucket. Never sent to browsers.
 */
export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
