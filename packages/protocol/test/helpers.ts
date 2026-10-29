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

export const CONTACT_A = 'a1'.repeat(32);
export const CONTACT_B = '0b'.repeat(32);

export const policy: Policy = {
  dailyLimitSats: 500_000,
  recoveryDelayDays: 7,
  alertContacts: [CONTACT_B, CONTACT_A],
  sweepFeeCapSats: 50_000,
};

export const WALLET_ID = '0123456789abcdef';

/** A well-formed BIP 137 signature (header byte 31, filler body): the protocol layer only checks the shape. */
export const fakeSignature = Buffer.from([31, ...new Uint8Array(64).fill(7)]).toString('base64');

export const approval = { kind: 'bip137' as const, sequence: 3, expiresAt: 1_900_000_000, signature: fakeSignature };

export const accessApproval = { kind: 'bip137' as const, expiresAt: 1_900_000_000, signature: fakeSignature };

/** Shaped like a raw transaction (the protocol only checks it is bounded lowercase hex). */
export const RAW_TX = '02000000' + 'ab'.repeat(80);

export const hardwareAuth = { pubkey: `02${'ab'.repeat(32)}`, path: "m/48'/0'/0'/2'/0/0" };

export const pairParams = {
  pairingSecret: 'A'.repeat(43),
  deviceName: 'Pixel',
  network: 'bitcoin' as const,
  phoneKey: keyOrigin,
  descriptor: 'wsh(sortedmulti(2,A,B,C))',
  phoneNostrPubkey: 'cd'.repeat(32),
  hardwareAuth,
  hardwareAuthProof: fakeSignature,
  rules: policy,
};

export const recovery = {
  recoveryId: '1-0123456789ab',
  state: 'pending' as const,
  survivingRole: 'hardware' as const,
  startedAt: 1_800_000_000,
  readyAt: 1_800_000_000 + 7 * 86_400,
  delayDays: 7 as const,
  sweepTxid: 'ef'.repeat(32),
  destinationWalletId: 'fedcba9876543210',
  amountSats: 1_000_000,
  feeSats: 2_000,
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await sleep(10);
  }
}
