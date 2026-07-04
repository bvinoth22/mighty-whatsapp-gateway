import { initAuthCreds, proto, type AuthenticationState } from 'baileys';
import type { SessionData, SessionStore } from './sessionStore.js';

/**
 * Baileys auth-state backed by a pluggable SessionStore (Supabase in prod,
 * in-memory in dev). This replaces `useMultiFileAuthState` so nothing is
 * written to disk.
 */
export async function useSessionAuthState(
  store: SessionStore,
  accountId: string,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const loaded = await store.load(accountId);
  const data: SessionData = loaded ?? { creds: initAuthCreds(), keys: {} };

  const persist = () => store.save(accountId, data);

  const state: AuthenticationState = {
    creds: data.creds,
    keys: {
      get: (type, ids) => {
        const bucket = data.keys[type] || {};
        const result: Record<string, any> = {};
        for (const id of ids) {
          let value = bucket[id];
          if (value && type === 'app-state-sync-key') {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          if (value !== undefined) result[id] = value;
        }
        return result;
      },
      set: async (update) => {
        for (const type of Object.keys(update)) {
          const category = (update as any)[type];
          data.keys[type] = data.keys[type] || {};
          for (const id of Object.keys(category)) {
            const value = category[id];
            if (value) data.keys[type][id] = value;
            else delete data.keys[type][id];
          }
        }
        await persist();
      },
    },
  };

  return { state, saveCreds: persist };
}
