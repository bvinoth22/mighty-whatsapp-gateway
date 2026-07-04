import { supabase } from '../config/supabase.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

export interface Tenant {
  userId: string;
  displayName: string;
  subscriptionActive: boolean;
}

const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');

/**
 * Resolves a WhatsApp sender phone to a MightyVision tenant and checks whether
 * the WhatsApp feature subscription is active.
 *
 * Identity is derived ONLY from the verified sender phone — never from message
 * content — so a tenant can only ever act on their own data.
 *
 * In DEV mode (no Supabase) it returns a configurable fallback tenant so the
 * full flow can be tested offline.
 */
export async function resolveTenant(senderPhone: string): Promise<Tenant | null> {
  if (!supabase) {
    return {
      userId: env.devFallbackUserId,
      displayName: 'Dev User',
      subscriptionActive: env.devFallbackSubscriptionActive,
    };
  }

  const phone = digits(senderPhone);
  const local10 = phone.slice(-10);

  const { data: users, error } = await supabase
    .from('users')
    .select('id, first_name, last_name, username, country_code, phone_number, is_active')
    .ilike('phone_number', `%${local10}%`);

  if (error) {
    logger.error({ err: error.message }, 'tenant lookup failed');
    return null;
  }

  const user = (users ?? []).find((u) => {
    const full = digits(`${u.country_code ?? ''}${u.phone_number ?? ''}`);
    const local = digits(u.phone_number);
    return full === phone || phone.endsWith(local) || local.endsWith(local10);
  });

  if (!user || user.is_active === false) return null;

  const displayName =
    [user.first_name, user.last_name].filter(Boolean).join(' ').trim() ||
    user.username ||
    user.id;

  return {
    userId: user.id,
    displayName,
    subscriptionActive: await isSubscriptionActive(user.id),
  };
}

/**
 * Subscription gate. Prefers a dedicated `feature_subscriptions` row for the
 * 'whatsapp_bot' feature; if that table does not exist yet, falls back to the
 * existing species subscription as the entitlement.
 */
async function isSubscriptionActive(userId: string): Promise<boolean> {
  if (!supabase) return env.devFallbackSubscriptionActive;

  const feature = await supabase
    .from('feature_subscriptions')
    .select('is_active, expires_at')
    .eq('user_id', userId)
    .eq('feature', 'whatsapp_bot')
    .maybeSingle();

  if (!feature.error && feature.data) {
    const notExpired = !feature.data.expires_at || new Date(feature.data.expires_at) > new Date();
    return Boolean(feature.data.is_active) && notExpired;
  }

  // In strict mode, a missing whatsapp_bot entitlement means no access.
  if (env.strictSubscription) return false;

  // Otherwise: any active species subscription counts as entitled.
  const species = await supabase
    .from('user_species_subscriptions')
    .select('is_active')
    .eq('user_id', userId)
    .eq('is_active', true)
    .limit(1);

  return !species.error && (species.data?.length ?? 0) > 0;
}
