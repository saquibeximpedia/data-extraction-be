import { createClient } from '@supabase/supabase-js';
import { env } from './env';

/**
 * Server-side Supabase client with the service role key: verifies users' tokens, manages
 * accounts (admin only) and reads/writes the Storage bucket. Never sent to browsers.
 */
export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export type Role = 'admin' | 'user';

/** Roles live in app_metadata, which only the service role can change (users can't promote themselves) */
export function roleOf(user: { app_metadata?: Record<string, unknown> } | null | undefined): Role {
  return user?.app_metadata?.role === 'admin' ? 'admin' : 'user';
}
