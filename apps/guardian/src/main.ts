/**
 * Entry point (packaging contract): `node --import tsx apps/guardian/src/main.ts`.
 *
 * Reads the configuration from the environment (config.ts), opens the engine
 * and the service state in TRIKEY_DATA_DIR, starts HTTP on PORT, nostr and
 * Electrs, and shuts down cleanly on SIGTERM / SIGINT. The guardian always
 * starts locked. One log line per event on stdout; no secrets, no bodies.
 * Before it opens anything it tests the random source and the crypto (rng-check.ts) and exits 70 if either fails.
 */
// First: pin the random source before any module can draw from or replace it.
import './pin-random.js';
import { loadConfig } from './config.js';
import { Guardian } from './guardian.js';
import { createLogger, errorText } from './log.js';
import { EXIT_RNG, checkRandomSource } from './rng-check.js';

const log = createLogger({ level: process.env['TRIKEY_LOG_LEVEL'] === 'debug' ? 'debug' : 'info' });

async function main(): Promise<void> {
  // Before anything is opened, made or unlocked: the random source and the crypto must pass their start-up tests.
  if (!checkRandomSource(log)) process.exit(EXIT_RNG);

  let config;
  try {
    config = loadConfig(process.env);
    // Read once into the config; worker threads (the silent payment scanner) need not inherit it.
    delete process.env['TRIKEY_EXTRA_ENTROPY'];
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
  // `code` is the exit code after a clean stop: 0 when asked to stop (SIGTERM, SIGINT), 1 after a crash,
  // so a supervisor that restarts on failure (Umbrel: `restart: on-failure`) brings the guardian back.
  const shutdown = (signal: string, code = 0) => {
    if (stopping) return;
    stopping = true;
    log.info('guardian.shutdown', { signal, exitCode: code });
    const force = setTimeout(() => {
      log.error('guardian.shutdown_timeout');
      process.exit(1);
    }, 10_000);
    force.unref();
    guardian.stop().then(
      () => process.exit(code),
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
    shutdown('uncaughtException', 1);
  });
}

void main();
