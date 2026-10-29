/**
 * Entry point (packaging contract): `node --import tsx apps/guardian/src/main.ts`.
 *
 * Reads the configuration from the environment (config.ts), opens the engine
 * and the service state in TRIKEY_DATA_DIR, starts HTTP on PORT, nostr and
 * Electrs, and shuts down cleanly on SIGTERM / SIGINT. The guardian always
 * starts locked. One log line per event on stdout; no secrets, no bodies.
 */
// First: pin the random source before any module can draw from or replace it.
import './pin-random.js';
import { loadConfig } from './config.js';
import { Guardian } from './guardian.js';
import { createLogger, errorText } from './log.js';

const log = createLogger({ level: process.env['TRIKEY_LOG_LEVEL'] === 'debug' ? 'debug' : 'info' });

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (e) {
    log.error('config.invalid', { error: errorText(e) });
    process.exit(78); // EX_CONFIG
  }

  let guardian: Guardian;
  try {
    guardian = await Guardian.open({ config, log });
    await guardian.start();
  } catch (e) {
    log.error('guardian.start_failed', { error: errorText(e) });
    process.exit(1);
  }

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('guardian.shutdown', { signal });
    const force = setTimeout(() => {
      log.error('guardian.shutdown_timeout');
      process.exit(1);
    }, 10_000);
    force.unref();
    guardian.stop().then(
      () => process.exit(0),
      (e: unknown) => {
        log.error('guardian.shutdown_failed', { error: errorText(e) });
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => log.error('unhandled_rejection', { error: errorText(e) }));
  process.on('uncaughtException', (e) => {
    log.error('uncaught_exception', { error: errorText(e) });
    shutdown('uncaughtException');
  });
}

void main();
