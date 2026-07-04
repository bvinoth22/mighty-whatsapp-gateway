import { BufferJSON } from 'baileys';
import { supabase } from '../../config/supabase.js';
import { logger } from '../../config/logger.js';

/**
 * Persisted Baileys auth material for one linked account.
 * `creds` is the credential object; `keys` is a map of signal key categories.
 */
export interface SessionData {
  creds: any;
  keys: Record<string, Record<string, any>>;
}

export interface SessionStore {
  load(accountId: string): Promise<SessionData | null>;
  save(accountId: string, data: SessionData): Promise<void>;
  clear(accountId: string): Promise<void>;
}

/** Round-trips an object through BufferJSON so Buffers survive JSONB storage. */
function encode(value: any): any {
  return JSON.parse(JSON.stringify(value, BufferJSON.replacer));
}
function decode<T>(value: any): T {
  return JSON.parse(JSON.stringify(value), BufferJSON.reviver) as T;
}

/**
 * Stores the session in Supabase (`whatsapp_sessions` table). No SQLite, no
 * loose files — the session survives restarts/redeploys and is the same source
 * of truth as the rest of the system.
 *
 * Expected table:
 *   create table whatsapp_sessions (
 *     account_id text primary key,
 *     creds jsonb,
 *     keys jsonb,
 *     updated_at timestamptz default now()
 *   );
 */
export class SupabaseSessionStore implements SessionStore {
  async load(accountId: string): Promise<SessionData | null> {
    if (!supabase) return null;
    const { data, error } = await supabase
      .from('whatsapp_sessions')
      .select('creds, keys')
      .eq('account_id', accountId)
      .single();
    if (error) {
      if (error.code !== 'PGRST116') logger.error({ err: error.message }, 'session load failed');
      return null;
    }
    if (!data?.creds) return null;
    return { creds: decode(data.creds), keys: decode(data.keys ?? {}) };
  }

  async save(accountId: string, data: SessionData): Promise<void> {
    if (!supabase) return;
    const { error } = await supabase.from('whatsapp_sessions').upsert(
      {
        account_id: accountId,
        creds: encode(data.creds),
        keys: encode(data.keys),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'account_id' },
    );
    if (error) logger.error({ err: error.message }, 'session save failed');
  }

  async clear(accountId: string): Promise<void> {
    if (!supabase) return;
    await supabase.from('whatsapp_sessions').delete().eq('account_id', accountId);
  }
}

/** Dev-only store used when Supabase is not configured. */
export class InMemorySessionStore implements SessionStore {
  private map = new Map<string, SessionData>();
  async load(accountId: string): Promise<SessionData | null> {
    return this.map.get(accountId) ?? null;
  }
  async save(accountId: string, data: SessionData): Promise<void> {
    this.map.set(accountId, data);
  }
  async clear(accountId: string): Promise<void> {
    this.map.delete(accountId);
  }
}

export function createSessionStore(): SessionStore {
  return supabase ? new SupabaseSessionStore() : new InMemorySessionStore();
}
