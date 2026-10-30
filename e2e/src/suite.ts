/** Suites that run only when TRIKEY_E2E selects a chain (see config.ts), with the reason in the name of the ones that do not. */
import { describe } from 'vitest';
import { SKIP_NOTE, e2eMode } from './config.js';

export const mode = e2eMode();

/** An end-to-end suite: runs on the real stack (`TRIKEY_E2E=1`) and on the dry-run fakes (`TRIKEY_E2E=fake`). */
export function describeE2e(name: string, fn: () => void, timeoutMs = 180_000): void {
  describe.skipIf(!mode)(mode ? name : `${name} (${SKIP_NOTE})`, { timeout: timeoutMs }, fn);
}

/** Runs only against the real stack: what needs a real node's opinion. */
export function describeReal(name: string, fn: () => void, timeoutMs = 180_000): void {
  describe.skipIf(mode !== 'regtest')(mode === 'regtest' ? name : `${name} (needs the real regtest stack: TRIKEY_E2E=1)`, { timeout: timeoutMs }, fn);
}
