/**
 * Encrypted notes on the wire (PROTOCOL.md, "Encrypted notes"): the `labels_backup` feature, `labels.put` in parts,
 * `labels.get`, `labels.list` and `labels.delete`, and the size of a part: a full one, as a request and as an answer,
 * fits one gift wrap (NIP-44 encrypts at most 65,535 bytes, and the rumor is encrypted twice).
 */
import { base64urlnopad } from '@scure/base';
import { describe, expect, it } from 'vitest';
import {
  GUARDIAN_FEATURES,
  LABELS_PART_BYTES,
  LABELS_VERSIONS_KEPT,
  MAX_LABELS_BYTES,
  MAX_LABELS_PARTS,
  generateMessageId,
  methods,
  unwrapMessage,
  wrapMessage,
  type Message,
} from '../src/index.js';
import { keypair } from './helpers.js';

const NOW = 1_800_000_000;
const phone = keypair();
const guardian = keypair();
const WALLET_ID = '0123456789abcdef';
const SHA = 'ab'.repeat(32);
const UPLOAD = 'cd'.repeat(16);
const fullPart = () => base64urlnopad.encode(new Uint8Array(LABELS_PART_BYTES).fill(0xa5));

describe('labels: the feature and the limits', () => {
  it('is announced as `labels_backup`', () => {
    expect(GUARDIAN_FEATURES.labelsBackup).toBe('labels_backup');
  });

  it('a blob is at most 512 KiB and its padding overhead, in parts of 24 KiB; three versions are kept', () => {
    expect(MAX_LABELS_BYTES).toBe(512 * 1024 + 1024);
    expect(LABELS_PART_BYTES).toBe(24 * 1024);
    expect(MAX_LABELS_PARTS).toBe(22);
    expect(LABELS_VERSIONS_KEPT).toBe(3);
  });
});

describe('labels.put', () => {
  const p = methods['labels.put'].params;
  const ok = { walletId: WALLET_ID, upload: UPLOAD, part: 0, parts: 1, bytes: 100, sha256: SHA, data: 'AAAA' };

  it('takes one part of a blob with its upload id, place, size and hash', () => {
    expect(p.safeParse(ok).success).toBe(true);
    expect(p.safeParse({ ...ok, part: 1, parts: 2, bytes: LABELS_PART_BYTES + 1 }).success).toBe(true);
  });

  it('needs the wallet id: the blob is encrypted for one wallet', () => {
    const { walletId: _, ...rest } = ok;
    expect(p.safeParse(rest).success).toBe(false);
  });

  it('refuses a part past the end, a part count that does not match the size, a blob too large and anything that is not base64url', () => {
    expect(p.safeParse({ ...ok, part: 1 }).success).toBe(false);
    expect(p.safeParse({ ...ok, parts: 2 }).success).toBe(false);
    expect(p.safeParse({ ...ok, bytes: MAX_LABELS_BYTES + 1, parts: MAX_LABELS_PARTS }).success).toBe(false);
    expect(p.safeParse({ ...ok, data: 'AA==' }).success).toBe(false);
    expect(p.safeParse({ ...ok, data: 'A'.repeat(Math.ceil((LABELS_PART_BYTES * 4) / 3) + 1) }).success).toBe(false);
    expect(p.safeParse({ ...ok, upload: 'nope' }).success).toBe(false);
    expect(p.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });

  it('answers how many parts it holds, and the version once stored', () => {
    const r = methods['labels.put'].result;
    expect(r.safeParse({ walletId: WALLET_ID, received: 1 }).success).toBe(true);
    expect(r.safeParse({ walletId: WALLET_ID, received: 2, stored: { at: NOW * 1000, bytes: 4200, sha256: SHA } }).success).toBe(true);
  });
});

describe('labels.get, labels.list, labels.delete', () => {
  it('labels.get names the copy (`of`), the version and the part; all optional', () => {
    const p = methods['labels.get'].params;
    expect(p.safeParse({}).success).toBe(true);
    expect(p.safeParse({ walletId: WALLET_ID, of: 'fedcba9876543210', version: 2, part: 3 }).success).toBe(true);
    expect(p.safeParse({ version: LABELS_VERSIONS_KEPT }).success).toBe(false);
    const r = methods['labels.get'].result;
    expect(r.safeParse({ of: WALLET_ID, versions: [] }).success).toBe(true);
    expect(r.safeParse({ of: WALLET_ID, versions: [{ at: 1, bytes: 10, sha256: SHA }], part: { version: 0, index: 0, parts: 1, data: 'AAAA' } }).success).toBe(true);
  });

  it('labels.list lists the copies of the wallet and its earlier wallets; labels.delete names what went', () => {
    expect(methods['labels.list'].params.safeParse({}).success).toBe(true);
    expect(methods['labels.list'].result.safeParse({ copies: [{ of: WALLET_ID, versions: [{ at: 1, bytes: 10, sha256: SHA }] }] }).success).toBe(true);
    expect(methods['labels.list'].result.safeParse({ copies: [{ of: WALLET_ID, versions: [] }] }).success).toBe(false);
    expect(methods['labels.delete'].params.safeParse({ walletId: WALLET_ID }).success).toBe(true);
    expect(methods['labels.delete'].result.safeParse({ deleted: [WALLET_ID] }).success).toBe(true);
  });
});

describe('labels: a full part fits one gift wrap', () => {
  it('as a request', () => {
    const msg: Message = {
      id: generateMessageId(),
      method: 'labels.put',
      params: { walletId: WALLET_ID, upload: UPLOAD, part: MAX_LABELS_PARTS - 1, parts: MAX_LABELS_PARTS, bytes: MAX_LABELS_BYTES, sha256: SHA, data: fullPart() },
    };
    const { wrap } = wrapMessage(msg, { senderSecretKey: phone.secretKey, recipient: guardian.pubkey, now: NOW });
    const back = unwrapMessage(wrap, { recipientSecretKey: guardian.secretKey, expectedPeer: phone.pubkey, now: NOW });
    expect(back.message).toEqual(msg);
  });

  it('as an answer', () => {
    const msg: Message = {
      id: generateMessageId(),
      result: {
        of: WALLET_ID,
        versions: Array.from({ length: LABELS_VERSIONS_KEPT }, (_, i) => ({ at: NOW * 1000 + i, bytes: MAX_LABELS_BYTES, sha256: SHA })),
        part: { version: LABELS_VERSIONS_KEPT - 1, index: MAX_LABELS_PARTS - 1, parts: MAX_LABELS_PARTS, data: fullPart() },
      },
    };
    const { wrap } = wrapMessage(msg, { senderSecretKey: guardian.secretKey, recipient: phone.pubkey, now: NOW });
    const back = unwrapMessage(wrap, { recipientSecretKey: phone.secretKey, expectedPeer: guardian.pubkey, now: NOW });
    expect(back.message).toEqual(msg);
    expect(methods['labels.get'].result.safeParse((back.message as { result: unknown }).result).success).toBe(true);
  });
});
