/**
 * The guardian's nostr identity: a random secp256k1 key, separate from key 3.
 *
 * Trade-off (DESIGN.md, "Keeps key 3 only in memory"): this key is stored
 * UNENCRYPTED (mode 0600 in the data directory). It has to work while key 3 is
 * locked, right after a restart, so the guardian can answer `guardian.status`,
 * receive `guardian.unlock` from the paired phone, keep delivering recovery
 * alerts and accept cancels. Encrypting it under the unlock passphrase would
 * make a locked guardian deaf and mute.
 *
 * What someone who copies this file can do: read and send messages as the
 * guardian. They could impersonate the guardian towards the phone (for example
 * answer `guardian.status` falsely, or send fake alerts) and read requests sent
 * to it (PSBTs and the policy, which the phone and guardian hold anyway). They
 * cannot sign bitcoin transactions: key 3 stays encrypted, and the
 * policy engine, not this key, decides what gets co-signed. If the box is
 * compromised, use "Replace guardian" (sweep to a new wallet with a new guardian).
 */
import { hex } from '@scure/base';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { npubEncode } from 'nostr-tools/nip19';
import { readJsonFile, writeFileAtomic } from './files.js';

export interface GuardianIdentity {
  secretKey: Uint8Array;
  /** x-only hex. */
  pubkey: string;
  npub: string;
}

interface IdentityFile {
  version: 1;
  secretKey: string;
  createdAt: string;
}

function fromSecret(secretKey: Uint8Array): GuardianIdentity {
  const pubkey = getPublicKey(secretKey);
  return { secretKey, pubkey, npub: npubEncode(pubkey) };
}

export async function loadIdentity(path: string): Promise<GuardianIdentity | undefined> {
  const raw = (await readJsonFile(path)) as Partial<IdentityFile> | undefined;
  if (raw === undefined) return undefined;
  if (raw.version !== 1 || typeof raw.secretKey !== 'string' || !/^[0-9a-f]{64}$/.test(raw.secretKey))
    throw new Error('invalid nostr identity file');
  return fromSecret(hex.decode(raw.secretKey));
}

/** Loads the identity, creating it on first use. */
export async function loadOrCreateIdentity(path: string): Promise<GuardianIdentity> {
  const existing = await loadIdentity(path);
  if (existing) return existing;
  const secretKey = generateSecretKey();
  const file: IdentityFile = { version: 1, secretKey: hex.encode(secretKey), createdAt: new Date().toISOString() };
  try {
    await writeFileAtomic(path, `${JSON.stringify(file)}\n`, { overwrite: false });
  } catch (e) {
    // Lost a race with another writer: use theirs.
    const again = await loadIdentity(path);
    if (again) return again;
    throw e;
  }
  return fromSecret(secretKey);
}
