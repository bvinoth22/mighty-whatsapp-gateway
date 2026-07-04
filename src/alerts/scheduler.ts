import cron, { type ScheduledTask } from 'node-cron';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { connectionManager } from '../manager/connectionManager.js';
import { buildDailyDigest } from './dailyAlerts.js';

let task: ScheduledTask | null = null;

/** Build and post the daily digest right now (used by the scheduler and on-demand). */
export async function runDailyAlertsNow(): Promise<boolean> {
  const text = await buildDailyDigest(env.alertUserId);
  const ok = await connectionManager.sendToTargetGroup(text);
  logger.info({ ok, userId: env.alertUserId }, 'daily digest dispatched');
  return ok;
}

/** Schedule the daily digest at ALERT_TIME in ALERT_TZ (idempotent). */
export function startAlertScheduler(): void {
  if (!env.alertsEnabled) {
    logger.info('Daily alerts disabled (ALERTS_ENABLED=false).');
    return;
  }
  const [hh, mm] = env.alertTime.split(':').map((n) => Number(n));
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh > 23 || mm > 59) {
    logger.warn({ alertTime: env.alertTime }, 'Invalid ALERT_TIME; scheduler not started.');
    return;
  }
  const expr = `${mm} ${hh} * * *`;
  if (!cron.validate(expr)) {
    logger.warn({ expr }, 'Invalid cron expression; scheduler not started.');
    return;
  }
  task?.stop();
  task = cron.schedule(
    expr,
    () => {
      runDailyAlertsNow().catch((err) => logger.error({ err: err.message }, 'daily alerts failed'));
    },
    { timezone: env.alertTz },
  );
  logger.info({ at: env.alertTime, tz: env.alertTz }, '🚨 Daily alert scheduler started');
}
