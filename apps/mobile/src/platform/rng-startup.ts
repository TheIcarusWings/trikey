// The app's start-up check of its random source and its crypto: a short health test of fresh throwaway
// blocks and known answers for HMAC-SHA512, SHA-256, secp256k1, BIP 39 and BIP 32
// (packages/core/src/random-health.ts, the same function the guardian runs). `bootWallet` calls it once
// before the real or simulated wallet is built; it is also run again before every new key
// (`newMnemonic`, the Recovery Key, the recovery code, the backup).
//
// A failure does not stop the app, so the person can still read their wallet: it latches in
// `@trikey/core/random`, so every later draw is refused, and the next attempt to make a key (or talk to
// the guardian) fails with a `WalletServiceError` the screens already show (see `mapError`). Nothing here
// logs bytes: the message holds the name of the failed test and counts.

import { RandomSourceError } from '@trikey/core/random';
import { assertRandomSourceHealthy } from '@trikey/core/random-health';

export interface StartupRandomCheck {
  ok: boolean;
  /** Why it failed, in words with no bytes. */
  reason?: string;
  code?: string;
}

/** Runs the check once; never throws. A failure is latched and logged as one warning line. */
export function runStartupRandomCheck(warn: (line: string) => void = (l) => console.warn(l)): StartupRandomCheck {
  try {
    assertRandomSourceHealthy('app start');
    return { ok: true };
  } catch (e) {
    const code = e instanceof RandomSourceError ? e.code : 'error';
    const reason = e instanceof Error ? e.message : String(e);
    warn(`rng.selftest_failed code=${code} reason=${JSON.stringify(reason)} action="no keys will be made"`);
    return { ok: false, reason, code };
  }
}
