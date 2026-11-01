/**
 * The notification channels' secrets at rest: the SMTP app password, ntfy topics and access tokens, webhook URLs and
 * signing secrets (docs/design/notifications.md, "Secrets").
 *
 * **They must work while the guardian is locked.** The guardian is locked after every restart (a power cut), and that
 * is exactly when a "recovery started" alert may be due: a thief who unplugs the box and then starts a recovery from a
 * stolen phone must not also silence the email. So these secrets are NOT under the unlock passphrase that guards key 3
 * (keystore.ts); they get the same trade-off as the guardian's nostr key (identity.ts) and the silent payment scan key
 * (silent/service.ts): each is sealed with XChaCha20-Poly1305 under a random 32-byte key kept in its own file,
 * `notifications-key.json` (mode 0600), next to `notifications.json`. The associated data binds each ciphertext to
 * its place (`smtp.password`, `<channel id>.topic`, ...), so one cannot be moved into another.
 *
 * What that buys: a copy of `notifications.json` alone (a backup, a support bundle, a screenshot of the file)
 * reveals no secret. What it does not: someone who reads the whole data directory (the box's disk, root on the box)
 * gets the app password and can send mail as the owner, as they could read the nostr key today. That is why the web UI
 * asks for an app password (revocable, mail only) and never the account's own password, and the docs say to revoke it
 * if the box is lost. Secrets are write-only over the API: they are never sent back, only "set" and short hints.
 */
import { join } from 'node:path';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { hex } from '@scure/base';
import { secureRandomBytes } from '@trikey/core/random';
import { readJsonFile, writeFileAtomic } from '../files.js';

export const NOTIFY_KEY_FILE = 'notifications-key.json';

/** A sealed secret: nonce and ciphertext (with its tag), hex. */
export interface Sealed {
  n: string;
  c: string;
}

export function isSealed(v: unknown): v is Sealed {
  const s = v as Sealed;
  return !!s && typeof s === 'object' && typeof s.n === 'string' && /^[0-9a-f]{48}$/.test(s.n) && typeof s.c === 'string' && /^([0-9a-f]{2}){16,8192}$/.test(s.c);
}

const aad = (field: string) => utf8ToBytes(JSON.stringify(['trikey-notify-secret', 1, field]));

/** Seals and opens the channel secrets under the key in `notifications-key.json` (created on first use). */
export class SecretBox {
  private key?: Uint8Array;

  constructor(
    private readonly dataDir: string,
    private readonly now: () => number = Date.now,
  ) {}

  get path(): string {
    return join(this.dataDir, NOTIFY_KEY_FILE);
  }

  private async fileKey(create: boolean): Promise<Uint8Array | undefined> {
    if (this.key) return this.key;
    const raw = (await readJsonFile(this.path)) as { version?: number; key?: string } | undefined;
    if (raw !== undefined) {
      if (raw.version !== 1 || typeof raw.key !== 'string' || !/^[0-9a-f]{64}$/.test(raw.key)) throw new Error('invalid notification key file');
      this.key = hex.decode(raw.key);
      return this.key;
    }
    if (!create) return undefined;
    const key = secureRandomBytes(32);
    try {
      await writeFileAtomic(this.path, `${JSON.stringify({ version: 1, key: hex.encode(key), createdAt: new Date(this.now()).toISOString() })}\n`, { overwrite: false });
    } catch (e) {
      // Lost a race with another writer: use theirs.
      const again = (await readJsonFile(this.path)) as { key?: string } | undefined;
      if (again?.key && /^[0-9a-f]{64}$/.test(again.key)) {
        this.key = hex.decode(again.key);
        return this.key;
      }
      throw e;
    }
    this.key = key;
    return key;
  }

  /** Loads the key file if there is one (so a broken one is reported at start, not at the first alert). */
  async load(): Promise<void> {
    await this.fileKey(false);
  }

  async seal(field: string, secret: string): Promise<Sealed> {
    const key = (await this.fileKey(true))!;
    const nonce = secureRandomBytes(24);
    const c = xchacha20poly1305(key, nonce, aad(field)).encrypt(utf8ToBytes(secret));
    return { n: hex.encode(nonce), c: hex.encode(c) };
  }

  /** Throws when the key file is missing or the ciphertext does not belong to `field` under this key. */
  async open(field: string, sealed: Sealed): Promise<string> {
    const key = await this.fileKey(false);
    if (!key) throw new Error('the notification key file is missing');
    const plain = xchacha20poly1305(key, hex.decode(sealed.n), aad(field)).decrypt(hex.decode(sealed.c));
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(plain);
    } finally {
      plain.fill(0);
    }
  }
}
