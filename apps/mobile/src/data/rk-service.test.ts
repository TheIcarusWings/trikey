/**
 * Recovery Key mode's `WalletService` against the simulated chain (see ./rk-test-support.ts): creating the wallet,
 * approving refills, the scheduler, sending and paying from the vault. Recovery, the chain server and the background
 * task are in rk-recovery.test.ts. Inside a `describe` the tests run in order, like a person's first weeks.
 */
import { describe, expect, it } from 'vitest';
import { EsploraClient, RecoveryKeyWallet } from '@trikey/recovery-key';
import { simFetch } from '@trikey/recovery-key/testing';
import { WalletServiceError } from './errors';
import { PERIOD, closeServicesAfterAll, externalAddress, failure, setUp, wordsProof, world } from './rk-test-support';

closeServicesAfterAll();

describe('creating the wallet (RK-Create)', () => {
  it('starts empty, creates the phone key when key 1 connects, and offers a kit and a second hardware wallet', async () => {
    const w = world();
    const { svc, secure } = await w.phone();
    expect(svc.getState()).toMatchObject({
      backing: 'simulator',
      network: 'regtest',
      mode: 'recoveryKey',
      onboarded: false,
      balanceSats: 0,
      capabilities: { recoveryKey: true },
      recoveryKey: { stage: 'new', savedKey: null, refillsStatus: 'none' },
    });
    expect(svc.rk!.keyOptions()).toEqual([
      { kind: 'paper', available: true },
      { kind: 'nfc', available: false, unavailableReason: expect.stringMatching(/later/i) },
      { kind: 'hardware', available: true },
    ]);
    expect(await failure(svc.rk!.makeKit())).toMatchObject({ kind: 'wrong_state' });

    const seen: (string | null)[] = [];
    svc.subscribe(() => seen.push(svc.getState().progress));
    const hw = await svc.connectHardware('simulated');
    expect(hw).toMatchObject({ kind: 'simulated', brand: 'simulated device' });
    expect(seen).toContain('Creating your phone key');
    expect(svc.getState().recoveryKey.stage).toBe('hardware');
    expect(svc.getState().onboarded).toBe(false);
    expect([...secure.items.values()].filter((i) => i.requireBiometrics)).toHaveLength(1); // key 2
  });

  it('refuses the NFC card in words, and never a fake success', async () => {
    const w = world();
    const { svc } = await w.phone();
    await svc.connectHardware('simulated');
    svc.setRecoveryKeyKind('nfc');
    expect(await failure(svc.rk!.makeKit())).toMatchObject({ kind: 'not_available' });
  });

  it('prints a kit with a challenge, refuses a wrong word, then builds the vault and forgets key 3', async () => {
    const w = world();
    const { svc, kv, prompts } = await w.phone();
    await svc.connectHardware('simulated');
    const kit = await svc.rk!.makeKit();
    expect(kit).toMatchObject({ kind: 'seed', network: 'regtest' });
    expect(kit.challenge).toHaveLength(3);
    expect(kit.recoveryWords).toHaveLength(12);
    expect(kit.html).toContain(kit.fingerprint);
    expect(kit.qrText.startsWith('TRIKEYKIT1:')).toBe(true);

    const wrong = wordsProof(kit) as { words: Record<number, string> };
    wrong.words[kit.challenge[0]!] = kit.recoveryWords[kit.challenge[0]! - 1] === 'zoo' ? 'abandon' : 'zoo';
    expect(await failure(svc.rk!.confirmKit(wrong))).toMatchObject({ kind: 'kit_invalid', message: expect.stringMatching(/does not match/) });
    expect(svc.getState().onboarded).toBe(false);

    const done = await svc.rk!.confirmKit(wordsProof(kit));
    expect(done.fingerprint).toBe(kit.fingerprint);
    const s = svc.getState();
    expect(s).toMatchObject({ onboarded: true, addressVerified: true, recoveryKey: { stage: 'ready', savedKey: 'kit', fingerprint: kit.fingerprint } });
    expect(prompts.map((p) => p.title)).toContain('Check the address on your device');

    // Key 3 is gone from the phone: nothing the app stored holds the kit's words or QR.
    const stored = [...kv.data.values()].join('\n');
    // (A single word can be anywhere: "model" is a BIP 39 word and a field name. Four in a row are the key.)
    for (let i = 0; i + 4 <= kit.recoveryWords.length; i++) expect(stored).not.toContain(kit.recoveryWords.slice(i, i + 4).join(' '));
    expect(stored).not.toContain(kit.qrText.slice(11, 60));
    expect(Object.keys(JSON.parse(kv.data.get('trikey.rk.simulator.regtest.app')!))).not.toContain('html');
    expect(await failure(svc.rk!.confirmKit(wordsProof(kit)))).toMatchObject({ kind: 'wrong_state' });
  });

  it('takes a scan of the printed QR as the proof too', async () => {
    const w = world();
    const { svc } = await w.phone();
    await svc.connectHardware('simulated');
    const first = await svc.rk!.makeKit();
    const second = await svc.rk!.makeKit(); // asking again makes a new key 3
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(await failure(svc.rk!.confirmKit({ scanned: first.qrText }))).toMatchObject({ kind: 'kit_invalid' });
    await svc.rk!.confirmKit({ scanned: second.qrText });
    expect(svc.getState().recoveryKey.fingerprint).toBe(second.fingerprint);
  });

  it('can use a second hardware wallet as the Recovery Key: a wallet map to print, no secret', async () => {
    const w = world();
    const { svc } = await w.phone();
    await svc.connectHardware('simulated');
    svc.setRecoveryKeyKind('hardware');
    const kit = await svc.rk!.makeKit();
    expect(kit).toMatchObject({ kind: 'xpub', challenge: [], device: expect.any(String) });
    await svc.rk!.confirmKit({ mapSaved: true });
    expect(svc.getState().recoveryKey).toMatchObject({ stage: 'ready', savedKey: 'hardware' });
  });

  it('never leaves the test networks', async () => {
    const w = world();
    const { svc } = await w.phone();
    expect(() => svc.setNetwork('bitcoin')).toThrow(WalletServiceError);
    expect(svc.getState().network).toBe('regtest');
  });
});

describe('refills (RK-Refills)', () => {
  it('previews amount, count and schedule, then signs every refill with one confirmation each and one Face ID', async () => {
    const w = world();
    const { p } = await setUp(w, 5_000_000n, { approve: false });
    const { svc, secure, prompts } = p;
    const preview = await svc.rk!.previewRefills();
    expect(preview).toMatchObject({ mode: 'fresh', amountSats: 200_000, count: 8, periodDays: 7, totalSats: 1_600_000, vaultSats: 5_000_000, confirmations: 8 });
    expect(preview.maxCount).toBeGreaterThanOrEqual(8);
    expect(preview.schedule).toHaveLength(8);
    expect(preview.schedule[0]).toMatchObject({ index: 1, today: true });
    expect(preview.schedule[1]!.today).toBe(false);
    expect(new Date(preview.schedule[1]!.at).getTime() - new Date(preview.schedule[0]!.at).getTime()).toBe(PERIOD * 600_000);

    const edited = await svc.rk!.previewRefills({ amountSats: 300_000, count: 3 });
    expect(edited).toMatchObject({ amountSats: 300_000, count: 3, totalSats: 900_000, confirmations: 3 });
    expect((await svc.rk!.previewRefills({ count: 500 })).count).toBe(preview.maxCount);

    const before = prompts.length;
    const loads = secure.loads.length;
    const res = await svc.rk!.approveRefills();
    expect(res).toEqual({ from: 1, to: 8 });
    // The device asks eight times, and the sheet says which one; the phone asks once.
    const asked = prompts.slice(before).filter((x) => x.title.startsWith('Confirm on your device ('));
    expect(asked.map((x) => x.title)).toEqual(Array.from({ length: 8 }, (_, i) => `Confirm on your device (${i + 1} of 8)`));
    expect(asked[0]!.detail).toMatch(/refill/i);
    expect(secure.loads.slice(loads).filter((l) => l.biometric)).toHaveLength(1);
    expect(svc.getState().recoveryKey).toMatchObject({ refillsLeft: 8, refillsTotal: 8, refillsStatus: 'live', needsApproval: false });
    expect(svc.getState().recoveryKey.next).toMatchObject({ index: 1, status: 'ready', amountSats: 200_000 });
  });

  it('keeps the defaults the person sets for the next batch', async () => {
    const w = world();
    const { p } = await setUp(w, 5_000_000n, { approve: false });
    p.svc.rk!.setRefillDefaults({ amountSats: 100_000, count: 4 });
    expect(p.svc.getState().recoveryKey).toMatchObject({ refillAmountSats: 100_000, refillCount: 4 });
    expect(await p.svc.rk!.previewRefills()).toMatchObject({ amountSats: 100_000, count: 4 });
    await p.svc.rk!.approveRefills();
    expect(p.svc.getState().recoveryKey.refillsTotal).toBe(4);
  });

  it('"Approve more" continues the running chain at its own amount, whatever the defaults say', async () => {
    const w = world();
    const { p } = await setUp(w, 5_000_000n);
    await p.svc.sync();
    w.chain.mine(1);
    await p.svc.sync();
    // A deposit after the batch stays in the vault; the new links hang off the chain's last refill.
    w.fund(p.svc.rk!.vaultAddress(), 700_000n);
    p.svc.rk!.setRefillDefaults({ amountSats: 100_000, count: 4 });
    const preview = await p.svc.rk!.previewRefills({ amountSats: 100_000, count: 4 });
    expect(preview).toMatchObject({ mode: 'extend', amountSats: 200_000, count: 4 });
    expect(preview.schedule[0]!.index).toBe(9);
    expect(preview.schedule[0]!.today).toBe(false);
    expect(await p.svc.rk!.approveRefills({ amountSats: 100_000, count: 4 })).toEqual({ from: 9, to: 12 });
    await p.svc.sync();
    expect(p.svc.getState().recoveryKey).toMatchObject({ refillsTotal: 12, refillsLeft: 11, refillsStatus: 'live' });
  }, 90_000);
});

describe('home, the scheduler and sending (RK-Home)', () => {
  it('sends refill 1 when refills are approved, holds refill 2 until 1,008 blocks have passed, then tops up when the balance is low', async () => {
    const w = world();
    const { p } = await setUp(w);
    const { svc } = p;
    // Approving ran the scheduler (it runs whenever the app syncs): refill 1 is already on its way, and counts as soon as it is seen.
    expect(svc.getState().recoveryKey).toMatchObject({ spendingSats: 200_000, next: { index: 1, status: 'arriving' } });
    expect(w.chain.mempool()).toHaveLength(1);
    // Opening the app runs it again and finds nothing more to send.
    await svc.sync();
    expect(w.chain.mempool()).toHaveLength(1);
    w.chain.mine(1);
    await svc.sync();
    let rk = svc.getState().recoveryKey;
    expect(rk).toMatchObject({ spendingSats: 200_000, refillsLeft: 7, refillsTotal: 8 });
    expect(svc.getState().balanceSats).toBe(rk.spendingSats + rk.vaultSats);
    expect(rk.next).toMatchObject({ index: 2, status: 'waiting', inBlocks: PERIOD - 1 });
    expect(new Date(rk.next!.etaAt!).getTime()).toBeGreaterThan(svc.now().getTime());
    expect(rk.activity[0]).toMatchObject({ type: 'payment', tx: { kind: 'refill', refillIndex: 1, amountSats: 200_000, status: 'confirmed', signedBy: 'phone+hardware' } });

    // Not before 1,008 blocks: the scheduler leaves it alone.
    w.chain.mine(PERIOD - 2);
    await svc.sync();
    expect(svc.getState().recoveryKey.next).toMatchObject({ index: 2, status: 'waiting', inBlocks: 1 });
    expect(w.chain.mempool()).toHaveLength(0);
    // Unlocked, but the balance is full: nothing is sent.
    w.chain.mine(1);
    await svc.sync();
    expect(svc.getState().recoveryKey.next).toMatchObject({ index: 2, status: 'ready' });
    expect(w.chain.mempool()).toHaveLength(0);

    // Spend most of the balance with Face ID alone: the next sync sends refill 2.
    const out = await svc.quoteSend({ address: externalAddress(), amountSats: 150_000, speed: 'normal' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const refined = await svc.refineQuote!(out.quote);
    expect(refined.ok && refined.quote.estimate).toBe(false);
    if (!refined.ok) return;
    const tx = await svc.sendPayment(refined.quote);
    expect(tx).toMatchObject({ kind: 'sent', amountSats: 150_000, status: 'pending', signedBy: 'phone', address: externalAddress() });
    expect(w.chain.inMempool(tx.txid)).toBe(true);
    await svc.sync();
    expect(w.chain.mempool()).toHaveLength(2); // the payment and refill 2
    w.chain.mine(1);
    await svc.sync();
    rk = svc.getState().recoveryKey;
    expect(rk).toMatchObject({ refillsLeft: 6, spendingSats: 200_000 - 150_000 - tx.feeSats! + 200_000 });
    const sent = rk.activity.find((a) => a.type === 'payment' && a.tx.txid === tx.txid);
    expect(sent).toMatchObject({ tx: { kind: 'sent', amountSats: 150_000, address: externalAddress(), status: 'confirmed' } });
  }, 60_000);

  it('quotes in words: a bad address, an amount too small, a payment from the spending balance, one that needs the vault', async () => {
    const w = world();
    const { p } = await setUp(w);
    await p.svc.sync();
    w.chain.mine(1);
    await p.svc.sync();
    const q = (address: string, amountSats: number, extra: object = {}) => p.svc.quoteSend({ address, amountSats, speed: 'normal', ...extra });
    expect(q('nonsense', 10_000)).toMatchObject({ ok: false, problem: 'invalid_address' });
    expect(q(externalAddress(), 0)).toMatchObject({ ok: false, problem: 'amount_too_small' });
    expect(q(externalAddress(), 100)).toMatchObject({ ok: false, problem: 'amount_too_small' });
    const small = q(externalAddress(), 20_000);
    expect(small).toMatchObject({ ok: true, quote: { plan: { signer: 'phone' }, estimate: true } });
    const big = q(externalAddress(), 300_000);
    expect(big).toMatchObject({ ok: true, quote: { plan: { signer: 'hardware', reason: 'over-spending-balance' } } });
    expect(q(externalAddress(), 20_000, { signer: 'hardware' })).toMatchObject({ ok: true, quote: { plan: { signer: 'hardware', reason: 'requested' } } });
    expect(q(externalAddress(), 90_000_000)).toMatchObject({ ok: false, problem: 'insufficient_funds' });
  }, 60_000);

  it('shows the spending address and a vault address without using them up, and checks the vault address on the device', async () => {
    const w = world();
    const { p } = await setUp(w, 1_000_000n, { approve: false });
    const spend = p.svc.getState().receiveAddress;
    expect(spend).toMatch(/^bcrt1q/);
    expect((await p.svc.receiveAddress()).address).toBe(spend);
    expect(await failure(p.svc.receiveAddress({ verifyOnDevice: true }))).toMatchObject({ kind: 'invalid_input' });
    const vault = p.svc.rk!.vaultAddress();
    expect(p.svc.rk!.vaultAddress()).toBe(vault);
    const verified = await p.svc.rk!.verifyVaultAddress();
    expect(verified).toEqual({ address: vault, verifiedOnDevice: true });
    expect(p.svc.rk!.vaultAddress()).not.toBe(vault); // that one is used now
    // A payment to the spending address shows up as the next address moves on.
    w.fund(spend, 40_000n);
    await p.svc.sync();
    expect(p.svc.getState().recoveryKey.spendingSats).toBe(40_000);
    expect(p.svc.getState().receiveAddress).not.toBe(spend);
  }, 60_000);

  it('pays from the vault with the hardware wallet, warns when it ends the refills, and says so afterwards', async () => {
    const w = world();
    const { p } = await setUp(w, 3_000_000n);
    const { svc } = p;
    await svc.sync();
    w.chain.mine(1);
    await svc.sync();
    // A deposit the refills do not use: a payment from it leaves them alone, with no warning.
    w.fund(svc.rk!.vaultAddress(), 1_000_000n);
    await svc.sync();
    const modest = svc.quoteSend({ address: externalAddress(3), amountSats: 500_000, speed: 'normal', signer: 'hardware' });
    expect(modest).toMatchObject({ ok: true, quote: { plan: { signer: 'hardware', reason: 'requested' } } });
    expect(modest.ok && modest.quote.warning).toBeUndefined();

    // Bigger than the coins outside the refills: it must say so before the device is asked.
    const big = svc.quoteSend({ address: externalAddress(4), amountSats: 3_300_000, speed: 'normal' });
    expect(big).toMatchObject({ ok: true, quote: { plan: { signer: 'hardware', reason: 'over-spending-balance' }, warning: expect.stringMatching(/refills? still to come would stop/) } });
    if (!big.ok) return;
    const before = p.prompts.length;
    const tx = await svc.sendPayment(big.quote);
    expect(tx).toMatchObject({ kind: 'sent', signedBy: 'phone+hardware', fromVault: true, amountSats: 3_300_000, status: 'pending' });
    expect(p.prompts.slice(before).some((x) => x.title.startsWith('Confirm on your device') && /3300000|3,300,000/.test(x.detail ?? ''))).toBe(true);
    w.chain.mine(1);
    await svc.sync();
    const rk = svc.getState().recoveryKey;
    expect(rk).toMatchObject({ refillsStatus: 'invalidated', needsApproval: true, refillsLeft: 0, invalidatedBy: { byThisPhone: true } });
    expect(rk.notices).toEqual([]); // our own payment is not an alarm
    const entry = rk.activity.find((a) => a.type === 'payment' && a.tx.txid === tx.txid);
    expect(entry).toMatchObject({ tx: { fromVault: true, status: 'confirmed', address: externalAddress(4) } });
  }, 90_000);

  it('reports a refill this phone did not send, once, until it is dismissed', async () => {
    const w = world();
    const { p } = await setUp(w);
    w.chain.mine(1);
    await p.svc.sync(); // refill 1 (this phone's own) confirms
    w.chain.mine(PERIOD);
    // A thief copies the phone's storage and sends refill 2 from another phone, the moment it unlocks.
    const stolen = await RecoveryKeyWallet.open({
      network: 'regtest',
      secureStore: p.secure,
      store: p.kv,
      storageKey: 'trikey.rk.simulator.regtest',
      esplora: new EsploraClient({ baseUrl: 'sim://thief', fetch: simFetch(w.chain) }),
    });
    const refill = stolen!.refillTransactions()[1]!;
    await new EsploraClient({ baseUrl: 'sim://thief', fetch: simFetch(w.chain) }).broadcast(refill.txHex);
    await p.svc.sync();
    const notices = p.svc.getState().recoveryKey.notices;
    expect(notices).toEqual([expect.objectContaining({ kind: 'unexpected_broadcast', index: 2, txid: refill.txid })]);
    await p.svc.sync();
    expect(p.svc.getState().recoveryKey.notices).toHaveLength(1); // once, not once per sync
    p.svc.rk!.dismissNotice(notices[0]!.id);
    expect(p.svc.getState().recoveryKey.notices).toEqual([]);
    // Dismissing is remembered across a restart.
    const again = await w.phone({ secure: p.secure, kv: p.kv });
    await again.svc.sync();
    expect(again.svc.getState().recoveryKey.notices).toEqual([]);
  }, 60_000);

  it('offers to speed up a refill that is stuck for lack of fee, and does it with the phone alone', async () => {
    const w = world();
    const { p } = await setUp(w);
    w.chain.minMiningFeeRate = 20; // fees spiked after the batch was signed
    await p.svc.sync();
    w.chain.mine(3);
    w.chain.feeEstimates = { '1': 25, '2': 25, '3': 22, '6': 20, '144': 5 };
    await p.svc.sync();
    const offer = p.svc.getState().recoveryKey.speedUp;
    expect(offer).toMatchObject({ index: 1, targetRate: 22 });
    expect(offer!.feeSats).toBeGreaterThan(0);
    expect(p.svc.getState().recoveryKey.next).toMatchObject({ index: 1, status: 'arriving' });
    const before = p.prompts.length;
    await p.svc.rk!.speedUp();
    expect(p.prompts.length).toBe(before); // the phone alone: the device was not asked
    expect(p.svc.getState().recoveryKey.speedUp).toBeNull();
    w.chain.mine(1);
    await p.svc.sync();
    const rk = p.svc.getState().recoveryKey;
    expect(rk.speedUp).toBeNull();
    expect(rk.activity.map((a) => (a.type === 'payment' ? a.tx.kind : ''))).toEqual(expect.arrayContaining(['refill', 'speed_up']));
    expect(await failure(p.svc.rk!.speedUp())).toMatchObject({ kind: 'wrong_state' });
  }, 90_000);
});
