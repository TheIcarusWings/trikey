/**
 * Encrypted notes (DESIGN.md, "Notes that survive recovery"; PROTOCOL.md, "Encrypted notes"): the phone's labels of
 * each own wallet, as ciphertext only that wallet's hardware wallet can open again, so they survive losing the phone and
 * its backup. The guardian never holds the key; it keeps the blobs and hands them back.
 *
 * - **Where:** `labels/<walletId>.json` under the data directory (mode 0600, like every file here): the newest
 *   `LABELS_VERSIONS_KEPT` versions, newest first, each with when it was stored, its size and its sha256. Keyed by the
 *   wallet id the phone encrypted it for; a recovery's new wallet gets its own copy, and the swept wallet's stays for
 *   the phone that recovered it to bring back.
 * - **Uploads come in parts** (`labels.put`, `LABELS_PART_BYTES` each), held in memory until the last one arrives and
 *   the whole matches its size and hash; a new upload drops one that never finished, and one left for
 *   `UPLOAD_IDLE_MS` is dropped. A restart drops it too: the phone sends it again.
 * - **Replace-only**, with a short history: a new version is put first and the oldest beyond three goes. One stored
 *   within `COALESCE_MS` of the newest replaces it, so a burst of edits leaves one version, not three.
 * - **Limits:** `MAX_LABELS_BYTES` per blob (the protocol's), `DEFAULT_LABELS_UPLOAD_LIMIT` uploads per wallet per hour
 *   (`RateLimited` past it), and the parts' own count and size.
 * - **Gone with the wallet:** retiring a wallet, a recovery that leaves this guardian, and a reset delete its copies
 *   (`deleteIds`, `deleteAll`).
 *
 * Nothing here is announced on the alert channels (frequent and harmless); the box's Activity gets one line a day per
 * wallet at most ("Encrypted notes updated", the caller asks `shouldLog`).
 */
import { mkdir, readdir, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64, base64urlnopad, hex } from '@scure/base';
import { ErrorCode, LABELS_PART_BYTES, LABELS_VERSIONS_KEPT, MAX_LABELS_BYTES, RpcError, type LabelsVersionInfo, type Params, type Result } from '@trikey/protocol';
import { Mutex, readJsonFile, writeFileAtomic } from './files.js';
import { SlidingWindowLimiter, type RateLimitOptions } from './rate-limit.js';

export const LABELS_DIR = 'labels';
/** Uploads (new versions) per wallet within an hour. The phone uploads at most every 30 s while the owner edits. */
export const DEFAULT_LABELS_UPLOAD_LIMIT: RateLimitOptions = { max: 30, windowMs: 3_600_000 };
/** A version stored within this long of the newest replaces it (ms). */
export const COALESCE_MS = 10 * 60_000;
/** An upload whose next part does not come within this long is dropped (ms). */
export const UPLOAD_IDLE_MS = 10 * 60_000;
/** The Activity line ("Encrypted notes updated") at most this often per wallet (ms). */
export const LOG_EVERY_MS = 24 * 3_600_000;

interface StoredVersion extends LabelsVersionInfo {
  /** The blob, base64. */
  data: string;
}

interface LabelsFile {
  version: 1;
  walletId: string;
  /** Newest first. */
  versions: StoredVersion[];
  /** When an update was last written to the Activity log (ms). */
  loggedAt?: number;
}

interface Upload {
  id: string;
  parts: number;
  bytes: number;
  sha256: string;
  received: Map<number, Uint8Array>;
  touchedAt: number;
}

const WALLET_ID = /^[0-9a-f]{16}$/;

function info(v: StoredVersion): LabelsVersionInfo {
  return { at: v.at, bytes: v.bytes, sha256: v.sha256 };
}

function invalid(message: string, reason: string, data: Record<string, unknown> = {}): RpcError {
  return new RpcError(ErrorCode.InvalidParams, message, { reason, ...data });
}

function isLabelsFile(v: unknown, walletId: string): v is LabelsFile {
  const f = v as LabelsFile;
  return (
    !!f &&
    f.version === 1 &&
    f.walletId === walletId &&
    Array.isArray(f.versions) &&
    f.versions.every((x) => typeof x?.at === 'number' && typeof x.bytes === 'number' && typeof x.sha256 === 'string' && typeof x.data === 'string')
  );
}

export class LabelsVault {
  private readonly uploads = new Map<string, Upload>();
  private readonly limiter: SlidingWindowLimiter;
  private readonly mutex = new Mutex();

  constructor(
    private readonly dataDir: string,
    private readonly now: () => number,
    limit: RateLimitOptions = DEFAULT_LABELS_UPLOAD_LIMIT,
  ) {
    this.limiter = new SlidingWindowLimiter(limit);
  }

  get dir(): string {
    return join(this.dataDir, LABELS_DIR);
  }

  private path(walletId: string): string {
    if (!WALLET_ID.test(walletId)) throw new Error(`not a wallet id: ${walletId}`);
    return join(this.dir, `${walletId}.json`);
  }

  private async write(file: LabelsFile): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.path(file.walletId), `${JSON.stringify(file)}\n`);
  }

  private async read(walletId: string): Promise<LabelsFile | undefined> {
    const raw = await readJsonFile(this.path(walletId));
    if (raw === undefined) return undefined;
    if (!isLabelsFile(raw, walletId)) throw new Error(`invalid ${LABELS_DIR}/${walletId}.json`);
    return raw;
  }

  /** The stored versions of `walletId`'s notes, newest first (empty: none). */
  async versions(walletId: string): Promise<LabelsVersionInfo[]> {
    return ((await this.read(walletId))?.versions ?? []).map(info);
  }

  /**
   * One part of a new version (`labels.put`). Stores the version once every part arrived and the whole matches its
   * size and hash. Throws `RpcError`: `RateLimited` past the hourly uploads, `InvalidParams` for a part that does not
   * fit its upload.
   */
  async put(walletId: string, p: Omit<Params<'labels.put'>, 'walletId'>): Promise<Result<'labels.put'>> {
    const now = this.now();
    for (const [k, u] of this.uploads) if (u.touchedAt < now - UPLOAD_IDLE_MS) this.uploads.delete(k);
    let up = this.uploads.get(walletId);
    if (!up || up.id !== p.upload) {
      // A new upload: counted against the hourly limit, and it drops one that never finished.
      const verdict = this.limiter.take(walletId, now);
      if (!verdict.ok) {
        const retryAfterSeconds = Math.ceil(verdict.retryAfterMs / 1000);
        throw new RpcError(ErrorCode.RateLimited, `Your notes changed too often: the guardian takes them again in ${retryAfterSeconds} s.`, { retryAfterSeconds });
      }
      up = { id: p.upload, parts: p.parts, bytes: p.bytes, sha256: p.sha256, received: new Map(), touchedAt: now };
      this.uploads.set(walletId, up);
    }
    if (up.parts !== p.parts || up.bytes !== p.bytes || up.sha256 !== p.sha256) throw invalid('This part names another size or hash than the rest of its upload.', 'labels_upload_mismatch');
    if (p.bytes > MAX_LABELS_BYTES) throw invalid(`Notes are at most ${MAX_LABELS_BYTES} bytes.`, 'labels_too_large', { max: MAX_LABELS_BYTES });
    let data: Uint8Array;
    try {
      data = base64urlnopad.decode(p.data);
    } catch {
      throw invalid('A part must be base64url without padding.', 'labels_upload_mismatch');
    }
    const want = p.part === p.parts - 1 ? p.bytes - LABELS_PART_BYTES * (p.parts - 1) : LABELS_PART_BYTES;
    if (data.length !== want) throw invalid(`Part ${p.part} must be ${want} bytes.`, 'labels_upload_mismatch');
    up.received.set(p.part, data);
    up.touchedAt = now;
    if (up.received.size < up.parts) return { walletId, received: up.received.size };

    this.uploads.delete(walletId);
    const blob = new Uint8Array(up.bytes);
    for (let i = 0; i < up.parts; i++) blob.set(up.received.get(i)!, i * LABELS_PART_BYTES);
    if (hex.encode(sha256(blob)) !== up.sha256) throw invalid('The parts do not add up to the hash they named: send the notes again.', 'labels_hash_mismatch');
    const stored: StoredVersion = { at: now, bytes: blob.length, sha256: up.sha256, data: base64.encode(blob) };
    await this.mutex.run(async () => {
      const file = (await this.read(walletId)) ?? { version: 1 as const, walletId, versions: [] };
      const [newest, ...older] = file.versions;
      const keep = newest && now - newest.at < COALESCE_MS ? older : file.versions;
      file.versions = [stored, ...keep].slice(0, LABELS_VERSIONS_KEPT);
      await this.write(file);
    });
    return { walletId, received: up.parts, stored: info(stored) };
  }

  /** Whether an update of `walletId` should go to the Activity log now (at most once a day), and records that it did. */
  async shouldLog(walletId: string): Promise<boolean> {
    const now = this.now();
    return this.mutex.run(async () => {
      const file = await this.read(walletId);
      if (!file || (file.loggedAt !== undefined && now - file.loggedAt < LOG_EVERY_MS && file.loggedAt <= now)) return false;
      file.loggedAt = now;
      await this.write(file);
      return true;
    });
  }

  /** One part of a stored version (`labels.get`): version 0 is the newest. */
  async get(walletId: string, version = 0, part = 0): Promise<Result<'labels.get'>> {
    const file = await this.read(walletId);
    const versions = file?.versions ?? [];
    const v = versions[version];
    if (!v) return { of: walletId, versions: versions.map(info) };
    const blob = base64.decode(v.data);
    const parts = Math.ceil(blob.length / LABELS_PART_BYTES);
    if (part >= parts) throw invalid(`That version has ${parts} part${parts === 1 ? '' : 's'}.`, 'labels_no_such_part', { parts });
    const data = base64urlnopad.encode(blob.subarray(part * LABELS_PART_BYTES, (part + 1) * LABELS_PART_BYTES));
    return { of: walletId, versions: versions.map(info), part: { version, index: part, parts, data } };
  }

  /** Deletes the copies of these wallets; returns the ids that had one. */
  async deleteIds(walletIds: readonly string[]): Promise<string[]> {
    const deleted: string[] = [];
    await this.mutex.run(async () => {
      for (const id of new Set(walletIds)) {
        this.uploads.delete(id);
        try {
          await unlink(this.path(id));
          deleted.push(id);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
      }
    });
    return deleted;
  }

  /** Every wallet id with a copy here. */
  async ids(): Promise<string[]> {
    try {
      return (await readdir(this.dir)).filter((n) => /^[0-9a-f]{16}\.json$/.test(n)).map((n) => n.slice(0, 16));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }

  /** A reset: every copy goes. */
  async deleteAll(): Promise<void> {
    this.uploads.clear();
    await this.mutex.run(() => rm(this.dir, { recursive: true, force: true }));
  }
}

/** What `labelLine` reads of a wallet's engine. */
export interface WalletLineSource {
  registration(): { walletId: string } | undefined;
  retiredWallets(): readonly { registration: { walletId: string }; retirement: { reason: string; successorWalletId?: string } }[];
}

/**
 * The wallets whose notes belong to the wallet a runtime guards now: its own id first, then the wallet a recovery swept
 * into it, and so on back (each retired by a recovery whose successor the guardian adopted). Empty while it guards none.
 * A phone of that wallet may read every copy of the line (the one it recovered from included); nothing else.
 */
export function labelLine(engine: WalletLineSource): string[] {
  const active = engine.registration()?.walletId;
  if (!active) return [];
  const line = [active];
  const retired = engine.retiredWallets();
  for (let cur = active; ; ) {
    const prev = retired.find((r) => r.retirement.reason === 'recovered' && r.retirement.successorWalletId === cur);
    if (!prev || line.includes(prev.registration.walletId)) break;
    cur = prev.registration.walletId;
    line.push(cur);
  }
  return line;
}

/** Copies a runtime's engine keeps for wallets outside its line (retired, or swept to another guardian): to delete. */
export function strayLabelIds(engine: WalletLineSource): string[] {
  const line = labelLine(engine);
  return engine.retiredWallets().map((r) => r.registration.walletId).filter((id) => !line.includes(id));
}
