import { env, hasSupabase } from './config/env.js';
import { logger } from './config/logger.js';
import { startHttpServer } from './server/httpServer.js';
import { connectionManager } from './manager/connectionManager.js';
import { startAlertScheduler } from './alerts/scheduler.js';

async function main(): Promise<void> {
  // Boot the gateway: HTTP setup server + restore any saved WhatsApp session.
  logger.info('─'.repeat(48));
  logger.info('  MightyVision WhatsApp Gateway');
  logger.info(`  Provider:  ${env.provider}`);
  logger.info(`  Mighty API: ${env.mightyApiUrl}`);
  logger.info(`  Supabase:  ${hasSupabase ? 'configured' : 'DEV mode (in-memory)'}`);
  logger.info('─'.repeat(48));

  await startHttpServer();

  // Always attempt to restore a saved session on boot. If creds are already
  // registered, this reconnects with no pairing code. If there's no session,
  // the setup UI lets you link with a phone-number pairing code.
  logger.info('Restoring saved session (if any)…');
  connectionManager.connect().catch((err) => logger.error({ err: err.message }, 'connect failed'));

  // Schedule the once-daily aviary digest (6 AM by default, in ALERT_TZ).
  startAlertScheduler();
}

main().catch((err) => {
  logger.error({ err: err.message }, 'fatal');
  process.exit(1);
});
