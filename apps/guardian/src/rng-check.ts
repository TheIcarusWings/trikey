/**
 * The guardian's start-up check of its random source and its crypto (`@trikey/core/random-health`): a
 * short health test of fresh throwaway blocks, and known answers for HMAC-SHA512, SHA-256, secp256k1,
 * BIP 39 and BIP 32. `main.ts` runs it before it opens anything; `Guardian.open` runs it again, so no
 * other way of starting the service skips it.
 *
 * On failure `main.ts` logs `rng.selftest_failed` (the name of the failed test and counts, never bytes)
 * and exits with `EXIT_RNG`, so Umbrel shows the app as failing and no key is made from a weak source.
 */
import { RandomSourceError } from '@trikey/core/random';
import { assertRandomSourceHealthy } from '@trikey/core/random-health';
import type { Logger } from './log.js';

/** `EX_SOFTWARE` (sysexits.h): an internal software error. Distinct from 78 (bad config) and 1 (anything else). */
export const EXIT_RNG = 70;

/** Runs the check; returns true when it passed. Logs one line either way. Never throws. */
export function checkRandomSource(log: Logger): boolean {
  const t0 = Date.now();
  try {
    assertRandomSourceHealthy('guardian start');
    log.info('rng.selftest_ok', { ms: Date.now() - t0 });
    return true;
  } catch (e) {
    const code = e instanceof RandomSourceError ? e.code : 'error';
    const reason = e instanceof Error ? e.message : String(e);
    log.error('rng.selftest_failed', { code, reason, action: 'refusing to start; no key was made' });
    return false;
  }
}
