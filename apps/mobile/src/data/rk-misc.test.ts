/**
 * The small pieces of Recovery Key mode that need no chain: the server address, the routing between the two kinds of
 * wallet, the sheet's series of confirmations, and the demo's version of the actions.
 */
import { describe, expect, it } from 'vitest';
import { SoftwareHardwareSigner, MemoryKeyValueStore } from '@trikey/wallet/testing';
import { DevicePromptStore, withDevicePrompts } from './device';
import { WalletServiceError } from './errors';
import { createMockWalletService } from './mock';
import { checkKitProof, wordMatches } from './kit-proof';
import { nextRefillHint, nextRefillText } from './rk-format';
import { kindPrefKey, createRoutedWalletService, pickInitialKind } from './routed';
import { isPrivateHost, parseServerUrl } from './rk-server';
import type { WalletService } from './service';
import type { RecoveryKit, WalletState } from './types';

describe('parseServerUrl', () => {
  it('cleans an address into the base URL the chain client wants', () => {
    expect(parseServerUrl(' https://mempool.space/signet/api/ ')).toBe('https://mempool.space/signet/api');
    expect(parseServerUrl('mempool.example.org/api')).toBe('https://mempool.example.org/api');
    expect(parseServerUrl('http://umbrel.local:3006/api')).toBe('http://umbrel.local:3006/api');
    expect(parseServerUrl('192.168.1.5:3002')).toBe('http://192.168.1.5:3002');
    expect(parseServerUrl('localhost:3002')).toBe('http://localhost:3002');
  });

  it('says what is wrong in words', () => {
    const bad = (s: string) => {
      try {
        parseServerUrl(s);
      } catch (e) {
        expect(e).toBeInstanceOf(WalletServiceError);
        return (e as Error).message;
      }
      throw new Error(`expected ${s} to be refused`);
    };
    expect(bad('')).toMatch(/Enter the address/);
    expect(bad('ftp://x.org')).toMatch(/https/);
    expect(bad('http://mempool.space/api')).toMatch(/own network/);
    expect(bad('https://user:pass@mempool.space')).toMatch(/passwords/);
    expect(bad('https://mempool.space/api?x=1')).toMatch(/after the path/);
  });

  it('knows which hosts are on the person’s own network', () => {
    for (const h of ['localhost', '127.0.0.1', '10.0.0.2', '172.16.5.5', '172.31.0.1', '192.168.0.9', 'umbrel.local', 'node.lan', 'abc.onion']) expect(isPrivateHost(h), h).toBe(true);
    for (const h of ['mempool.space', '8.8.8.8', '172.32.0.1', '192.169.0.1', 'local.example.com']) expect(isPrivateHost(h), h).toBe(false);
  });
});

describe('checking the proof of a new kit on the screen', () => {
  const kit: RecoveryKit = {
    kind: 'seed',
    html: '',
    qrText: 'TRIKEYKIT1:ABC',
    recoveryWords: ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'],
    mapWords: [],
    fingerprint: '0000 0000 0000 0000',
    network: 'regtest',
    date: '',
    challenge: [2, 5, 11],
  };
  const fails = (proof: Parameters<typeof checkKitProof>[1]) => {
    try {
      checkKitProof(kit, proof);
    } catch (e) {
      expect(e).toMatchObject({ kind: 'kit_invalid' });
      return (e as Error).message;
    }
    return undefined;
  };

  it('takes the words asked for, in full or by their first four letters', () => {
    expect(fails({ words: { 2: 'ability', 5: 'ABOVE', 11: ' access ' } })).toBeUndefined();
    expect(fails({ words: { 2: 'abil', 5: 'abov', 11: 'acce' } })).toBeUndefined();
    expect(fails({ words: { 2: 'ability', 5: 'above', 11: 'accident' } })).toMatch(/Word 11/);
    expect(fails({ words: { 2: 'abi', 5: 'above', 11: 'access' } })).toMatch(/Word 2/);
    expect(fails({ words: { 5: 'above', 11: 'access' } })).toMatch(/Word 2/);
  });

  it('takes a scan of the same kit, and nothing else', () => {
    expect(fails({ scanned: 'TRIKEYKIT1:ABC' })).toBeUndefined();
    expect(fails({ scanned: 'TRIKEYKIT1:XYZ' })).toMatch(/isn't the kit/);
    expect(fails({ mapSaved: true })).toMatch(/words/);
    expect(checkKitProof({ ...kit, kind: 'xpub', challenge: [] }, { mapSaved: true })).toBeUndefined();
  });

  it('matches words like the wallet does', () => {
    expect(wordMatches('zoo', 'zoo')).toBe(true);
    expect(wordMatches('zo', 'zoo')).toBe(false);
    expect(wordMatches('', 'zoo')).toBe(false);
  });
});

describe('DevicePromptStore: a series of confirmations', () => {
  const device = new SoftwareHardwareSigner({ mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow', network: 'regtest', kind: 'ledger' });

  it('numbers each confirmation and shows the text announced for it', async () => {
    const store = new DevicePromptStore();
    const titles: string[] = [];
    const details: (string | undefined)[] = [];
    store.subscribe(() => {
      const p = store.getSnapshot();
      if (p) (titles.push(p.title), details.push(p.detail));
    });
    // A device that signs nothing: the sheet is what is under test.
    const inner = { kinds: ['ledger' as const], isAvailable: async () => true, connect: async () => ({ ...device, info: device.info, signPsbt: async (p: string) => p, close: async () => {} }) as never };
    const signer = await withDevicePrompts(inner, store, { network: 'regtest' }).connect();
    store.queueDetail('Refill 1 of 2 · 200000 sats', 1, 2);
    store.queueDetail('Refill 2 of 2 · 200000 sats', 2, 2);
    await signer.signPsbt('AA==', { name: 'x', descriptor: 'y' });
    await signer.signPsbt('AA==', { name: 'x', descriptor: 'y' });
    expect(titles).toEqual(['Confirm on your device (1 of 2)', 'Confirm on your device (2 of 2)']);
    expect(details).toEqual(['Refill 1 of 2 · 200000 sats', 'Refill 2 of 2 · 200000 sats']);
    // A single payment keeps the plain title, and a stale queue can be dropped.
    store.pendingDetail = 'Send 1000 sats';
    await signer.signPsbt('AA==', { name: 'x', descriptor: 'y' });
    expect(titles[2]).toBe('Confirm on your device');
    store.queueDetail('left over', 1, 3);
    store.clearQueue();
    expect(store.takeDetail()).toEqual({ text: undefined });
  });
});

/** A stand-in for one kind of wallet: just what the routing looks at. */
function member(state: Partial<WalletState>) {
  const calls: string[] = [];
  let current = { onboarded: false, recovering: false, mode: 'guardian', network: 'testnet', ...state } as WalletState;
  const listeners = new Set<() => void>();
  const svc = {
    calls,
    getState: () => current,
    subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
    setNetwork: (n: string) => void calls.push(`network:${n}`),
    setUnit: (u: string) => void calls.push(`unit:${u}`),
    setTheme: (t: string) => void calls.push(`theme:${t}`),
    sync: async () => void calls.push('sync'),
    close: async () => void calls.push('close'),
    rk: state.mode === 'recoveryKey' ? { vaultAddress: () => 'bcrt1qvault' } : undefined,
    set(patch: Partial<WalletState>) {
      current = { ...current, ...patch };
      listeners.forEach((l) => l());
    },
  };
  return svc as unknown as WalletService & { close(): Promise<void>; calls: string[]; set(p: Partial<WalletState>): void };
}

describe('routing between a guardian wallet and a Recovery Key wallet', () => {
  it('opens the kind that has a finished wallet, else the last pick, else the guardian', async () => {
    const kv = new MemoryKeyValueStore();
    const pick = (g: Partial<WalletState>, r: Partial<WalletState>) => pickInitialKind({ mode: 'real', kv, guardian: member(g), recoveryKey: member({ mode: 'recoveryKey', ...r }) });
    expect(await pick({}, {})).toBe('guardian');
    expect(await pick({ onboarded: true }, {})).toBe('guardian');
    expect(await pick({}, { onboarded: true })).toBe('recoveryKey');
    expect(await pick({ recovering: true }, {})).toBe('guardian');
    await kv.set(kindPrefKey('real'), 'recoveryKey');
    expect(await pick({}, {})).toBe('recoveryKey');
    expect(await pick({ onboarded: true }, {})).toBe('guardian'); // a finished wallet beats a half-made choice
    expect(await pick({ onboarded: true }, { onboarded: true })).toBe('recoveryKey'); // both finished (never made by the app): the last pick
  });

  it('hands every call to the kind in use, and lets onboarding pick before a wallet exists only', async () => {
    const kv = new MemoryKeyValueStore();
    const guardian = member({ mode: 'guardian' });
    const recoveryKey = member({ mode: 'recoveryKey' });
    const routed = createRoutedWalletService({ mode: 'real', kv, guardian, recoveryKey, initial: 'guardian' });
    let notified = 0;
    routed.subscribe(() => notified++);
    expect(routed.getState().mode).toBe('guardian');
    expect(routed.rk).toBeUndefined();

    // "No home server?" at onboarding.
    routed.setMode('recoveryKey');
    expect(notified).toBe(1);
    expect(routed.getState().mode).toBe('recoveryKey');
    expect(routed.rk?.vaultAddress()).toBe('bcrt1qvault');
    expect(await kv.get(kindPrefKey('real'))).toBe('recoveryKey');
    await routed.sync();
    expect(recoveryKey.calls).toContain('sync');
    expect(guardian.calls).not.toContain('sync');

    // Back out to the guardian path.
    routed.setMode('guardian');
    expect(routed.getState().mode).toBe('guardian');

    // Preferences and the network go to both: either may be the one in use after a restart.
    routed.setUnit('btc');
    routed.setNetwork('signet');
    expect(guardian.calls).toEqual(expect.arrayContaining(['unit:btc', 'network:signet']));
    expect(recoveryKey.calls).toEqual(expect.arrayContaining(['unit:btc', 'network:signet']));

    // Once the wallet is finished the phone keeps it.
    routed.setMode('recoveryKey');
    recoveryKey.set({ onboarded: true });
    routed.setMode('guardian');
    expect(routed.getState().mode).toBe('recoveryKey');
    await routed.close();
    expect(guardian.calls).toContain('close');
    expect(recoveryKey.calls).toContain('close');
  });
});

describe('where the next refill stands, in words', () => {
  const now = new Date('2026-10-29T15:20:00Z');
  const at = (ms: number) => new Date(now.getTime() + ms).toISOString();
  const DAY = 86_400_000;

  it('says ready, arriving, how long it waits, and what it waits for', () => {
    expect(nextRefillText({ index: 1, amountSats: 200_000, status: 'ready' }, now)).toBe('+200,000 ready');
    expect(nextRefillText({ index: 1, amountSats: 200_000, status: 'arriving' }, now)).toBe('+200,000 arriving');
    expect(nextRefillText({ index: 4, amountSats: 200_000, status: 'waiting', etaAt: at(3 * DAY - 3_600_000) }, now)).toBe('+200,000 in 3 days');
    expect(nextRefillText({ index: 4, amountSats: 200_000, status: 'waiting', etaAt: at(5 * 3_600_000 + 20 * 60_000) }, now)).toBe('+200,000 in 5 h 20 min');
    expect(nextRefillText({ index: 4, amountSats: 200_000, status: 'pending', inBlocks: 1008 }, now)).toBe('+200,000 after refill 3 confirms');
    expect(nextRefillText({ index: 1, amountSats: 100_000, status: 'pending' }, now)).toBe('+100,000 after the last transaction confirms');
  });

  it('explains each state under it', () => {
    expect(nextRefillHint({ index: 2, amountSats: 1, status: 'ready' })).toMatch(/sends it when the spending balance runs low/);
    expect(nextRefillHint({ index: 2, amountSats: 1, status: 'waiting' })).toMatch(/None can arrive early/);
    expect(nextRefillHint({ index: 2, amountSats: 1, status: 'arriving' })).toMatch(/waiting for the network/);
    expect(nextRefillHint({ index: 2, amountSats: 1, status: 'pending' })).toMatch(/Refill 2 waits/);
  });
});

describe('the demo’s Recovery Key actions', () => {
  it('walks the whole creation: kit, proof, refills', async () => {
    const wallet = createMockWalletService({ deviceDelayMs: 0, networkDelayMs: 0 });
    const rk = wallet.rk!;
    expect(rk.keyOptions().find((o) => o.kind === 'nfc')).toMatchObject({ available: false });
    wallet.setRecoveryKeyKind('paper');
    const kit = await rk.makeKit();
    expect(kit.html).toMatch(/demo/i);
    expect(kit.challenge).toHaveLength(3);
    await expect(rk.confirmKit({ words: { [kit.challenge[0]!]: 'nope' } })).rejects.toMatchObject({ kind: 'kit_invalid' });
    await rk.confirmKit({ words: Object.fromEntries(kit.challenge.map((p) => [p, kit.recoveryWords[p - 1]!])) });
    const preview = await rk.previewRefills({ amountSats: 100_000, count: 4 });
    expect(preview).toMatchObject({ mode: 'fresh', amountSats: 100_000, count: 4, confirmations: 4 });
    expect(preview.schedule[0]!.today).toBe(true);
    await rk.approveRefills({ amountSats: 100_000, count: 4 });
    expect(wallet.getState().recoveryKey).toMatchObject({ refillsLeft: 4, refillAmountSats: 100_000, stage: 'ready' });
    expect((await rk.testServer('mempool.example/api')).ok).toBe(true);
    await rk.setServer('mempool.example/api');
    expect(wallet.getState().recoveryKey.server).toEqual({ url: 'https://mempool.example/api', isDefault: false });
  });

  it('shows the home of the designs: 5 of 8 refills left, the next in 3 days', () => {
    const rk = createMockWalletService().getState().recoveryKey;
    expect(rk).toMatchObject({ spendingSats: 180_000, vaultSats: 4_030_000, refillsLeft: 5, refillsTotal: 8, next: { index: 4, amountSats: 200_000, status: 'waiting' } });
  });
});

