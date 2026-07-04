import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env, hasSupabase } from './env.js';
import { logger } from './logger.js';

/**
 * Supabase client used ONLY for identity, subscription gating and session
 * persistence. All aviary operations go through the MightyVisionWeb API,
 * not directly here. Returns null in DEV mode (no credentials), and the rest
 * of the app falls back to in-memory/dev behaviour.
 */
export const supabase: SupabaseClient | null = hasSupabase
  ? createClient(env.supabaseUrl, env.supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

if (!supabase) {
  logger.warn('Supabase not configured — running in DEV mode (in-memory session, dev tenant).');
}
