import { base64 } from '@scure/base';
import { getPublicKey, generateSecretKey } from 'nostr-tools/pure';
import type { Policy } from '../src/index.js';

export function keypair() {
  const secretKey = generateSecretKey();
  return { secretKey, pubkey: getPublicKey(secretKey) };
}

/** A structurally valid (magic + filler) PSBT; the protocol layer never parses past the magic. */
export function fakePsbt(seed = 1, size = 200): string {
  const bytes = new Uint8Array(size);
  bytes.set([0x70, 0x73, 0x62, 0x74, 0xff]);
  for (let i = 5; i < size; i++) bytes[i] = (i * 31 + seed) & 0xff;
  return base64.encode(bytes);
}

export const XPUB =
  'xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz';

export const keyOrigin = { fingerprint: 'deadbeef', path: "m/48'/0'/0'/2'", xpub: XPUB };

export const policy: Policy = { dailyLimitSats: 500_000, recoveryDelayDays: 7 };

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await sleep(10);
  }
}
