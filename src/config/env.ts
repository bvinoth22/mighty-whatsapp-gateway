import 'dotenv/config';

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export const env = {
  port: Number(process.env.PORT ?? 3000),
  provider: (process.env.PROVIDER ?? 'baileys').toLowerCase(),

  targetGroupName: process.env.TARGET_GROUP_NAME ?? '',
  targetGroupJid: process.env.TARGET_GROUP_JID ?? '',
  botPhoneNumber: (process.env.BOT_PHONE_NUMBER ?? '').replace(/\D/g, ''),

  mightyApiUrl: (process.env.MIGHTY_API_URL ?? 'http://localhost:3001').replace(/\/$/, ''),

  supabaseUrl: process.env.SUPABASE_URL ?? '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',

  devFallbackUserId: process.env.DEV_FALLBACK_USER_ID ?? 'U_1',
  devFallbackSubscriptionActive: bool(process.env.DEV_FALLBACK_SUBSCRIPTION_ACTIVE, true),

  // When true, only an explicit feature_subscriptions row (whatsapp_bot) grants
  // access. When false, an active species subscription also counts (convenient
  // while migrating to the dedicated entitlement).
  strictSubscription: bool(process.env.STRICT_SUBSCRIPTION, false),

  // Testing aid: when true, the bot also answers messages sent from its own
  // linked number (so you can test from the same phone). Echo suppression
  // prevents it from reacting to its own replies.
  allowSelfMessages: bool(process.env.ALLOW_SELF_MESSAGES, false),

  speciesId: process.env.SPECIES_ID ?? 'S_1',

  // ── Daily alerts ──────────────────────────────────────────────
  // A once-daily digest (nearing/overdue eggs, ring reminders, idle pairs, …)
  // posted to the target group. Runs on ALERT_TIME in ALERT_TZ.
  alertsEnabled: bool(process.env.ALERTS_ENABLED, true),
  alertTime: process.env.ALERT_TIME ?? '06:00', // 24h HH:mm
  alertTz: process.env.ALERT_TZ ?? 'Asia/Kolkata',
  // Whose aviary to scan for the scheduled digest (single-tenant deployment).
  alertUserId: process.env.ALERT_USER_ID ?? process.env.DEV_FALLBACK_USER_ID ?? 'U_1',

  logLevel: process.env.LOG_LEVEL ?? 'info',
};

/** True when real Supabase credentials are present. */
export const hasSupabase = Boolean(env.supabaseUrl && env.supabaseServiceKey);
