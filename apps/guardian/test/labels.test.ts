/**
 * Encrypted notes, the guardian's store on its own (labels.ts): which copies belong to a wallet (its line back through
 * the recoveries the guardian adopted), which are stray, an upload left unfinished, and a damaged file refused.
 */
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64urlnopad, hex } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { LabelsVault, UPLOAD_IDLE_MS, labelLine, strayLabelIds, type WalletLineSource } from '../src/labels.js';

const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccc';
const D = 'dddddddddddddddd';

function engine(active: string | undefined, retired: { id: string; reason: 'recovered' | 'retired'; successor?: string }[]): WalletLineSource {
  return {
    registration: () => (active ? { walletId: active } : undefined),
    retiredWallets: () => retired.map((r) => ({ registration: { walletId: r.id }, retirement: { reason: r.reason, ...(r.successor ? { successorWalletId: r.successor } : {}) } })),
  };
}

describe('a wallet\'s line', () => {
  it('is the active wallet, then each wallet a recovery swept into it, back to the first', () => {
    const e = engine(C, [
      { id: A, reason: 'recovered', successor: B },
      { id: B, reason: 'recovered', successor: C },
      { id: D, reason: 'retired' },
    ]);
    expect(labelLine(e)).toEqual([C, B, A]);
    expect(strayLabelIds(e)).toEqual([D]);
  });

  it('a recovery to another guardian leaves the swept wallet out of the line: its copy is stray', () => {
    const e = engine(B, [{ id: A, reason: 'recovered' }]);
    expect(labelLine(e)).toEqual([B]);
    expect(strayLabelIds(e)).toEqual([A]);
  });

  it('a retired wallet with nothing active: no line, every copy stray', () => {
    const e = engine(undefined, [
      { id: A, reason: 'recovered', successor: B },
      { id: B, reason: 'retired' },
    ]);
    expect(labelLine(e)).toEqual([]);
    expect(strayLabelIds(e)).toEqual([A, B]);
  });
});

describe('the store', () => {
  const part = (blob: Uint8Array, upload: string) => ({ upload, part: 0, parts: 1, bytes: blob.length, sha256: hex.encode(sha256(blob)), data: base64urlnopad.encode(blob) });

  it('drops an upload left unfinished, and one that another upload replaced', async () => {
    let now = 1_000_000;
    const v = new LabelsVault(await mkdtemp(join(tmpdir(), 'trikey-labels-')), () => now);
    const big = new Uint8Array(30_000).fill(3);
    const sha = hex.encode(sha256(big));
    const first = { upload: '01'.repeat(16), part: 0, parts: 2, bytes: big.length, sha256: sha, data: base64urlnopad.encode(big.subarray(0, 24_576)) };
    expect(await v.put(A, first)).toEqual({ walletId: A, received: 1 });
    now += UPLOAD_IDLE_MS + 1;
    // The rest of it, too late: it starts over with only this part.
    expect(await v.put(A, { ...first, part: 1, data: base64urlnopad.encode(big.subarray(24_576)) })).toEqual({ walletId: A, received: 1 });
    // Another upload replaces it.
    const small = new Uint8Array(10).fill(4);
    expect((await v.put(A, part(small, '02'.repeat(16)))).stored).toMatchObject({ bytes: 10 });
    expect((await v.versions(A)).map((x) => x.bytes)).toEqual([10]);
  });

  it('refuses a damaged file instead of overwriting it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'trikey-labels-'));
    await mkdir(join(dir, 'labels'));
    await writeFile(join(dir, 'labels', `${A}.json`), '{"version":2}');
    const v = new LabelsVault(dir, () => 1);
    await expect(v.versions(A)).rejects.toThrow(/invalid/);
    await expect(v.put(A, part(new Uint8Array(4), '03'.repeat(16)))).rejects.toThrow(/invalid/);
  });

  it('never reads or writes outside its directory', async () => {
    const v = new LabelsVault(await mkdtemp(join(tmpdir(), 'trikey-labels-')), () => 1);
    await expect(v.versions('../../etc/passwd')).rejects.toThrow(/not a wallet id/);
    await expect(v.deleteIds(['../x'])).rejects.toThrow(/not a wallet id/);
  });
});
