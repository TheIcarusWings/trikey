/**
 * Coin control in the app (`WalletService.coins`), from the real wallet service against the real guardian in-process
 * (regtest, throwaway keys; DESIGN.md, "Coin control"): the coin list, a label and a freeze (and the backup line that
 * follows them), Send max without the frozen coin, a manual pick with the mixed-labels warning, "Consolidate" counting
 * only the fee, Savings' coins and consolidation, and BIP 329 export and import through the platform's file functions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GuardianRig } from '@trikey/guardian/testing';
import { MemoryCloudBackupStore, MemoryKeyValueStore, MemoryPasskeyPrf, MemorySecureKeyStore, SoftwareHardwareSigner } from '@trikey/wallet/testing';
import type { HardwareKind, HardwareProvider, HardwareSigner } from '@trikey/wallet';
import { createRealWalletService, type RealWalletService } from './real';

const key1 = new SoftwareHardwareSigner({ mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow', network: 'regtest', kind: 'ledger', model: 'Simulated device' });
const second = new SoftwareHardwareSigner({ mnemonic: 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong', network: 'regtest', kind: 'coldcard', model: 'Second simulated device' });

class SimDevices implements HardwareProvider {
  readonly kinds: readonly HardwareKind[] = ['ledger', 'trezor', 'coldcard', 'bitbox02', 'jade', 'qr'];
  async isAvailable() {
    return true;
  }
  async connect(opts: { kind?: HardwareKind } = {}): Promise<HardwareSigner> {
    return opts.kind === 'coldcard' ? second : key1;
  }
}

const cloud = new MemoryCloudBackupStore();
const passkey = new MemoryPasskeyPrf();
passkey.supported = false;
const shared: { name: string; text: string }[] = [];
let toPick: { name: string; bytes: Uint8Array } | null = null;
let rig: GuardianRig;
let svc: RealWalletService;
const funded: string[] = [];

beforeAll(async () => {
  rig = await GuardianRig.start();
  svc = await createRealWalletService({
    mode: 'simulator',
    platform: { os: 'ios', isSecure: true, secureKeys: new MemorySecureKeyStore(), kv: new MemoryKeyValueStore(), cloudBackups: [cloud], passkeys: passkey },
    hardware: () => [new SimDevices()],
    clock: rig.clock,
    rpcTimeoutMs: 5000,
    rpcRetryIntervalMs: 0,
    syncIntervalMs: 0,
    syncJoinMs: 0,
    yieldToUi: async () => {},
    recoveryCodeKdf: { m: 64, t: 1, p: 1 },
    secondDeviceKind: 'coldcard',
    shareLabelsFile: async (name, text) => void shared.push({ name, text }),
    pickLabelsFile: async () => toPick,
  });
  await svc.connectHardware('simulated');
  await svc.pairGuardian(rig.pairingUri());
  await svc.setUpRules(100_000, 7);
  for (const [i, sats] of [60_000, 45_000, 30_000, 5_000].entries()) {
    const f = rig.fund(svc.wallet!.multisig().derive(0, i).script, BigInt(sats));
    funded.push(`${f.txid}:${f.vout}`);
  }
  await svc.sync();
  await svc.idle();
}, 60_000);

afterAll(async () => {
  await svc?.close();
  await rig?.stop();
});

describe('coin control in the app', { timeout: 120_000 }, () => {
  it('lists the coins of Spending; Savings has none before it exists', () => {
    const list = svc.coins!.list('spending')!;
    expect(list.coins.map((c) => c.outpoint).sort()).toEqual([...funded].sort());
    expect(list.coins.every((c) => c.source.kind === 'received' && !c.change && c.confirmations > 0)).toBe(true);
    expect(list.totals).toMatchObject({ count: 4, totalSats: 140_000, frozenSats: 0 });
    expect(svc.coins!.list('savings')).toBeNull();
  });

  it('a label and a freeze: the state moves on (screens read again), and the backup is older than them', async () => {
    await svc.createBackup('file');
    expect(svc.getState().backup?.labelsNewer).toBeUndefined();
    const v = svc.getState().labelsVersion ?? 0;
    rig.clock.advance(1_000);
    await svc.coins!.setLabel('spending', funded[0]!, 'Salary');
    await svc.coins!.setLabel('spending', funded[1]!, 'Exchange');
    await svc.coins!.setFrozen('spending', funded[3]!, true);
    expect(svc.getState().labelsVersion).toBeGreaterThanOrEqual(v + 3);
    expect(svc.getState().backup?.labelsNewer).toBe(true);
    const list = svc.coins!.list('spending')!;
    expect(list.coins.find((c) => c.outpoint === funded[3])).toMatchObject({ frozen: true });
    expect(list.coins.find((c) => c.outpoint === funded[0])).toMatchObject({ label: 'Salary' });
    await expect(svc.coins!.setLabel('spending', 'not a coin', 'x')).rejects.toMatchObject({ kind: 'invalid_input' });
  });

  it('Send max leaves the frozen coin; its error says so when nothing else is left to pay', () => {
    const q = svc.quoteSendMax({ address: 'bcrt1qq6hag67dl53wl99vzg42z8eyzfz2xlkvwk6f7m', speed: 'normal' });
    if (!q.ok) throw new Error(q.message);
    expect(q.quote.totalSats).toBe(135_000);
    const tooMuch = svc.quoteSend({ address: 'bcrt1qq6hag67dl53wl99vzg42z8eyzfz2xlkvwk6f7m', amountSats: 136_000, speed: 'normal' });
    expect(tooMuch).toMatchObject({ ok: false, problem: 'insufficient_funds', message: expect.stringContaining('5,000 sats are in frozen coins') });
  });

  it('a manual pick: the quote carries the coins and the mixed-labels warning; a frozen coin is refused in words', async () => {
    const q = svc.quoteSend({ address: 'bcrt1qq6hag67dl53wl99vzg42z8eyzfz2xlkvwk6f7m', amountSats: 10_000, speed: 'normal', coins: [funded[0]!, funded[1]!] });
    if (!q.ok) throw new Error(q.message);
    expect(q.quote.request.coins).toEqual([funded[0], funded[1]]);
    expect(q.quote.mixesLabels).toEqual(['Salary', 'Exchange']);
    const frozen = svc.quoteSend({ address: 'bcrt1qq6hag67dl53wl99vzg42z8eyzfz2xlkvwk6f7m', amountSats: 1_000, speed: 'normal', coins: [funded[3]!] });
    expect(frozen).toMatchObject({ ok: false, message: expect.stringMatching(/is frozen\. Unfreeze it to spend it/) });
    const tx = await svc.sendPayment(q.quote);
    expect(tx).toMatchObject({ kind: 'sent', amountSats: 10_000, signedBy: 'phone+guardian' });
    const list = svc.coins!.list('spending')!;
    expect(list.coins.some((c) => c.outpoint === funded[0] || c.outpoint === funded[1])).toBe(false);
    expect(list.coins.find((c) => c.txid === tx.txid)).toMatchObject({ change: true, unconfirmed: true, source: { kind: 'payment', amountSats: 10_000 } });
  });

  it('Consolidate: the quote says only the fee counts; sent, the guardian counted the fee alone; Activity shows it as that', async () => {
    await rig.mine();
    await svc.sync();
    await svc.idle();
    const before = svc.getState().dailyLimit.usedSats;
    const q = svc.coins!.quoteConsolidate('spending', {});
    if (!q.ok) throw new Error(q.message);
    expect(q.quote).toMatchObject({ wallet: 'spending', speed: 'slow', plan: { signer: 'phone+guardian' } });
    expect(q.quote.coins).toHaveLength(2);
    expect(q.quote.amountSats).toBe(q.quote.inputSats - q.quote.feeSats);
    expect(q.quote.remainingAfterSats).toBe(100_000 - before - q.quote.feeSats);
    const guardianBefore = rig.guardian.engine.status().dailyLimit!.used;
    const r = await svc.coins!.consolidate(q.quote);
    expect(r).toMatchObject({ signedBy: 'phone+guardian', amountSats: q.quote.amountSats, feeSats: q.quote.feeSats });
    expect(rig.guardian.engine.status().dailyLimit!.used - guardianBefore).toBe(BigInt(q.quote.feeSats));
    await svc.sync();
    await svc.idle();
    const item = svc.getState().activity.find((a) => a.type === 'payment' && a.tx.txid === r.txid);
    expect(item).toMatchObject({ tx: { kind: 'sent', consolidated: true, amountSats: q.quote.feeSats, consolidatedSats: q.quote.amountSats } });
    const after = svc.coins!.list('spending')!;
    expect(after.coins.filter((c) => !c.frozen)).toHaveLength(1);
    // Fewer than two coins left that are not frozen: said in words.
    expect(svc.coins!.quoteConsolidate('spending', {})).toMatchObject({ ok: false, message: expect.stringMatching(/at least 2 coins/) });
  });

  it("exports Spending's labels as a BIP 329 file to the share sheet, and imports one back", async () => {
    await svc.coins!.exportLabels('spending');
    const file = shared.at(-1)!;
    expect(file.name).toMatch(/^trikey-wallet-labels-\d{4}-\d{2}-\d{2}\.jsonl$/);
    const lines = file.text.trim().split('\n').map((l) => JSON.parse(l) as { type: string; ref: string; label?: string; spendable?: boolean });
    expect(lines).toContainEqual(expect.objectContaining({ type: 'output', ref: funded[3], spendable: false }));
    expect(lines).toContainEqual(expect.objectContaining({ type: 'output', ref: funded[0], label: 'Salary' }));
    toPick = null;
    expect(await svc.coins!.importLabels('spending')).toBeNull();
    toPick = {
      name: 'sparrow.jsonl',
      bytes: new TextEncoder().encode(
        [JSON.stringify({ type: 'output', ref: funded[3], label: 'Dust from nobody' }), JSON.stringify({ type: 'tx', ref: 'ab'.repeat(32), label: 'x', origin: "wpkh([d34db33f/84'/0'/0'])" }), 'not json'].join('\n'),
      ),
    };
    const r = await svc.coins!.importLabels('spending');
    expect(r).toMatchObject({ coinLabels: 1, otherWallet: 1, errorCount: 1, firstError: expect.stringMatching(/^line 3/) });
    expect(svc.coins!.list('spending')!.coins.find((c) => c.outpoint === funded[3])).toMatchObject({ label: 'Dust from nobody', frozen: true });
  });

  it("Savings: its own coins, and a consolidation with two of its keys shows in Savings' activity as the fee", async () => {
    const sv = svc.savings!;
    await sv.start();
    await sv.connectHardware();
    await sv.connectRecoveryKey('simulated');
    await sv.finish();
    const w = svc.wallet!;
    for (const [i, sats] of [20_000, 15_000].entries()) rig.fund(w.savingsWallet()!.derive(0, i).script, BigInt(sats));
    await svc.sync();
    await svc.idle();
    const list = svc.coins!.list('savings')!;
    expect(list.totals).toMatchObject({ count: 2, totalSats: 35_000 });
    const q = svc.coins!.quoteConsolidate('savings', {});
    if (!q.ok) throw new Error(q.message);
    expect(q.quote.plan).toBeUndefined();
    const r = await svc.coins!.consolidate(q.quote, { signers: 'phone+hardware' });
    expect(r.signedBy).toBe('phone+hardware');
    await svc.sync();
    await svc.idle();
    expect(svc.getState().savings.activity.find((a) => a.txid === r.txid)).toMatchObject({ kind: 'consolidated', amountSats: q.quote.feeSats });
  });
});
