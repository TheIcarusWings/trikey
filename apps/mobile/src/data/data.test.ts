import { describe, expect, it } from 'vitest';
import { npubEncode } from 'nostr-tools/nip19';
import { getPublicKey } from 'nostr-tools/pure';
import { WalletError } from '@trikey/wallet';
import { SoftwareHardwareProvider, SoftwareHardwareSigner } from '@trikey/wallet/testing';
import { HardwareError } from '../hardware/errors';
import { CloudBackupError, SecureKeyError, cloudBackupError, secureKeyError } from '../platform/errors';
import { addEvent, buildActivity, emptyLog, hostFromLabel, takeLegacySends } from './app-log';
import { DevicePromptStore, compositeProvider, ledgerHint, withDevicePrompts } from './device';
import { WalletServiceError } from './errors';
import { GuardianAddressError, parseGuardianAddress } from './guardian-address';
import { mapError, refusalToError } from './real-errors';
import { createMockWalletService } from './mock';
import { looksLikeBitcoinAddress, quoteSend as mockQuote, quoteSendMax as mockQuoteMax } from './rules';
import { DEMO_SP_RECIPIENT, DEMO_TAPROOT_OUTPUT } from './sp-mock';
import { looksLikeSilentPaymentAddress } from './sp-empty';

const sk = new Uint8Array(32).fill(5);
const npub = npubEncode(getPublicKey(sk));

describe('parseGuardianAddress', () => {
  it('reads a trikey: pairing URI, ignoring the secret and the expiry', () => {
    const uri = `trikey://pair?v=1&npub=${npub}&relay=wss%3A%2F%2Frelay.damus.io&relay=ws%3A%2F%2F192.168.1.5%3A7777&secret=abcdefghijklmnopqrstuv&exp=1`;
    expect(parseGuardianAddress(uri)).toEqual({ npub, relays: ['wss://relay.damus.io', 'ws://192.168.1.5:7777'] });
  });

  it('reads an npub and relays pasted together or in two fields', () => {
    expect(parseGuardianAddress(`${npub}\nwss://nos.lol, wss://relay.damus.io.`)).toEqual({ npub, relays: ['wss://nos.lol', 'wss://relay.damus.io'] });
    expect(parseGuardianAddress(npub.toUpperCase(), 'wss://nos.lol wss://nos.lol')).toEqual({ npub, relays: ['wss://nos.lol'] });
  });

  it('says what is wrong in words', () => {
    expect(() => parseGuardianAddress('')).toThrow(GuardianAddressError);
    expect(() => parseGuardianAddress('wss://nos.lol')).toThrow(/npub1/);
    expect(() => parseGuardianAddress(`npub1${'q'.repeat(58)} wss://nos.lol`)).toThrow(/valid npub/);
    expect(() => parseGuardianAddress(npub)).toThrow(/at least one relay/);
    expect(() => parseGuardianAddress(`${npub} ws://example.com`)).toThrow(/Not a usable relay/);
  });
});

describe('DevicePromptStore and withDevicePrompts', () => {
  const device = new SoftwareHardwareSigner({
    mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow',
    network: 'regtest',
    kind: 'ledger',
  });

  it('opens a prompt for exactly as long as the device call runs', async () => {
    const store = new DevicePromptStore();
    const seen: (string | undefined)[] = [];
    store.subscribe(() => seen.push(store.getSnapshot()?.detail));
    const provider = withDevicePrompts(new SoftwareHardwareProvider(device), store, { network: 'regtest' });
    const signer = await provider.connect();
    expect(store.getSnapshot()).toBeNull();
    await signer.getXpub("m/48'/1'/0'/2'");
    expect(seen[0]).toMatch(/public key/);
    expect(store.getSnapshot()).toBeNull();
    await signer.signMessage("m/48'/1'/0'/2'/0/0", 'Trikey test message');
    expect(seen.some((d) => d?.includes('Trikey test message'))).toBe(true);
    expect(store.getSnapshot()).toBeNull();
  });

  it('lets the person give up: the call rejects with "cancelled" and the sheet closes', async () => {
    const store = new DevicePromptStore();
    const slow = {
      kinds: ['ledger' as const],
      isAvailable: async () => true,
      connect: async () => ({ ...device, info: device.info, signMessage: () => new Promise<string>(() => {}), close: async () => {} }) as never,
    };
    const signer = await withDevicePrompts(slow, store, { network: 'regtest' }).connect();
    const pending = signer.signMessage('m/0', 'hello');
    expect(store.getSnapshot()).toMatchObject({ title: 'Confirm on your device' });
    store.cancel();
    await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    expect(store.getSnapshot()).toBeNull();
  });

  it('stays out of the way of QR devices, which show their own screens', async () => {
    const store = new DevicePromptStore();
    const qr = new SoftwareHardwareSigner({ mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow', network: 'regtest', kind: 'qr' });
    const signer = await withDevicePrompts(new SoftwareHardwareProvider(qr), store, { network: 'regtest', silentKinds: ['qr'] }).connect();
    let shown = false;
    store.subscribe(() => (shown ||= store.getSnapshot() !== null));
    await signer.signMessage("m/48'/1'/0'/2'/0/0", 'x');
    expect(shown).toBe(false);
  });

  it('maps Ledger interactions to words and routes connect() by kind', async () => {
    expect(ledgerHint('unlock-device')).toMatch(/PIN/);
    expect(ledgerHint('register-wallet')).toMatch(/wallet/);
    expect(ledgerHint('nonsense')).toBeUndefined();
    const a = new SoftwareHardwareProvider(device);
    const b = { kinds: ['trezor' as const], isAvailable: async () => false, connect: async () => device };
    const both = compositeProvider([b, a]);
    expect(both.kinds).toEqual(expect.arrayContaining(['trezor', 'ledger']));
    expect(await both.isAvailable()).toBe(true);
    await both.connect({ kind: 'ledger' });
    expect(a.connects).toBe(1);
    await expect(compositeProvider([b]).connect({ kind: 'jade' })).rejects.toBeInstanceOf(WalletServiceError);
  });
});

describe('mapError', () => {
  it('turns guardian refusals into messages that offer the hardware wallet', () => {
    expect(refusalToError({ kind: 'over_daily_limit', limitSats: 100_000, usedSats: 90_000, message: 'x' })).toMatchObject({
      kind: 'over_limit',
      suggestsHardware: true,
      message: expect.stringContaining('10,000 sats left'),
    });
    expect(refusalToError({ kind: 'guardian_locked', message: 'x' })).toMatchObject({ kind: 'guardian_locked', suggestsHardware: true });
    expect(refusalToError({ kind: 'unreachable', message: 'x' })).toMatchObject({ kind: 'guardian_unreachable', suggestsHardware: true });
    expect(refusalToError({ kind: 'recovery_in_progress', message: 'x' })).toMatchObject({ kind: 'recovery_in_progress', suggestsHardware: true });
    expect(refusalToError({ kind: 'phone_spending_paused', cause: 'contested_recovery', message: 'x' })).toMatchObject({ kind: 'phone_spending_paused', suggestsHardware: true });
    expect(refusalToError({ kind: 'phone_spending_paused', cause: 'wallet_retired', message: 'x' })).toMatchObject({ suggestsHardware: false });
    expect(refusalToError({ kind: 'unlock_failed', retryAfterSeconds: 4, message: 'x' })).toMatchObject({ kind: 'unlock_failed', retryAfterSeconds: 4, message: expect.stringContaining('4 seconds') });
  });

  it('maps wallet, hardware and platform errors', () => {
    expect(mapError(new WalletError('insufficient_funds', 'x'))).toMatchObject({ kind: 'insufficient_funds' });
    expect(mapError(new WalletError('guardian_refused', 'x', { refusal: { kind: 'guardian_locked', message: 'm' } }))).toMatchObject({ kind: 'guardian_locked' });
    expect(mapError(new WalletError('key_unavailable', 'x', { cause: secureKeyError('cancelled') }))).toMatchObject({ kind: 'cancelled' });
    expect(mapError(new WalletError('hardware_invalid_response', 'x', { cause: new HardwareError('user-rejected', 'no') }))).toMatchObject({ kind: 'hardware', message: expect.stringContaining('rejected') });
    expect(mapError(new HardwareError('cancelled', 'x'))).toMatchObject({ kind: 'cancelled' });
    expect(mapError(cloudBackupError('quota'))).toMatchObject({ kind: 'backup_unavailable', message: expect.stringContaining('full') });
    expect(mapError(new Error('boom'))).toMatchObject({ kind: 'internal' });
    const same = new WalletServiceError('refused', 'r');
    expect(mapError(same)).toBe(same);
    expect(SecureKeyError).toBeDefined();
    expect(CloudBackupError).toBeDefined();
  });
});

describe('app log and activity', () => {
  it('lists the wallet\'s history (with its send log) and the security events', () => {
    const log = emptyLog();
    const now = Date.UTC(2026, 9, 29, 12);
    addEvent(log, { kind: 'limit-changed', limitSats: 80_000, direction: 'lowered', approvedOn: 'phone', at: now - 120_000 });
    addEvent(log, { kind: 'wallet-retired', reason: 'retired', at: now - 200_000 });
    log.seen['b'.repeat(64)] = now - 30_000;
    const items = buildActivity(
      [
        // Sent a moment ago, not listed by the guardian yet (the wallet's `local` entry).
        { txid: 'c'.repeat(64), height: 0, confirmations: 0, netSats: -5_100, feeSats: 100, amountSats: 5_000, recipient: 'bcrt1qexample2', signedBy: 'hardware', sentAt: now - 10_000, local: true },
        { txid: 'a'.repeat(64), height: 0, confirmations: 0, netSats: -30_200, feeSats: 200, amountSats: 30_000, recipient: 'bcrt1qexample', signedBy: 'guardian', sentAt: now - 60_000 },
        { txid: 'b'.repeat(64), height: 0, confirmations: 0, netSats: 50_000 },
        { txid: 'd'.repeat(64), height: 100, confirmations: 3, time: Math.floor(now / 1000) - 86_400, netSats: 700_000 },
      ],
      log,
      now,
    );
    const pay = (i: (typeof items)[number]) => (i.type === 'payment' ? i.tx : undefined);
    expect(items.map((i) => (i.type === 'payment' ? i.tx.txid[0] : i.event.kind))).toEqual(['c', 'b', 'a', 'limit-changed', 'wallet-retired', 'd']);
    expect(pay(items[2]!)).toMatchObject({ kind: 'sent', amountSats: 30_000, feeSats: 200, status: 'pending', address: 'bcrt1qexample', signedBy: 'phone+guardian' });
    expect(pay(items[0]!)).toMatchObject({ kind: 'sent', amountSats: 5_000, status: 'pending', signedBy: 'phone+hardware' });
    expect(pay(items[1]!)).toMatchObject({ kind: 'received', amountSats: 50_000, status: 'pending' });
    expect(pay(items[1]!)!.address).toBeUndefined();
    expect(pay(items[5]!)).toMatchObject({ kind: 'received', status: 'confirmed', amountSats: 700_000 });

    // An older app's own records go to the wallet's send log once.
    const old = { ...emptyLog(), sends: { ['e'.repeat(64)]: { txid: 'e'.repeat(64), address: 'bcrt1qold', amountSats: 1_000, feeSats: 10, signedBy: 'phone+hardware' as const, at: 5 } } };
    expect(takeLegacySends(old)).toEqual([{ txid: 'e'.repeat(64), at: 5, recipient: 'bcrt1qold', amountSats: 1_000, feeSats: 10, signedBy: 'hardware' }]);
    expect(old.sends).toBeUndefined();
    expect(hostFromLabel('My Umbrel')).toBe('umbrel');
    expect(hostFromLabel('StartOS box')).toBe('start9');
    expect(hostFromLabel(undefined)).toBe('other');
  });
});

describe('the demo wallet', () => {
  it('still satisfies the interface: quotes, a wrong passphrase, and a recovery', async () => {
    const wallet = createMockWalletService({ deviceDelayMs: 0, networkDelayMs: 0 });
    const q = wallet.quoteSend({ address: 'bc1qxyz', amountSats: 10_000, speed: 'normal' });
    expect(q).toMatchObject({ ok: true, quote: { plan: { signer: 'phone+guardian' } } });
    expect(mockQuote(wallet.getState(), { address: 'x', amountSats: 1, speed: 'fast', signer: 'hardware' })).toMatchObject({ ok: true, quote: { plan: { reason: 'requested' } } });
    wallet.dev!.setGuardianStatus!('locked');
    await expect(wallet.unlockGuardian('wrong')).rejects.toMatchObject({ kind: 'unlock_failed' });
    await wallet.unlockGuardian('anything');
    expect(wallet.getState().guardian.status).toBe('online');
    expect(wallet.getState()).toMatchObject({ backing: 'demo', capabilities: { recoveryKey: true } });
  });

  it('replaces the guardian, locks it, and finishes a recovery the way the real wallet does', async () => {
    const wallet = createMockWalletService({ deviceDelayMs: 0, networkDelayMs: 0 });
    expect(wallet.readCode('demo-pairing-code')).toMatchObject({ kind: 'pairing' });
    const plan = await wallet.previewReplaceGuardian('demo-pairing-code');
    expect(plan.steps.map((s) => s.step)).toEqual(['pair', 'sign', 'broadcast', 'retire', 'switch']);
    expect(wallet.getState().replace.plan).toEqual(plan);
    expect(await wallet.replaceGuardian()).toMatchObject({ status: 'done', oldWalletRetired: true });
    expect(wallet.getState()).toMatchObject({ guardian: { host: 'start9' }, replace: { plan: null }, oldWallets: [{ retiredOnGuardian: true }] });

    // The old guardian offline: the person has to confirm it is gone.
    wallet.dev!.setGuardianStatus!('offline');
    expect((await wallet.previewReplaceGuardian('demo-pairing-code')).oldGuardianReachable).toBe(false);
    await expect(wallet.replaceGuardian()).rejects.toMatchObject({ kind: 'guardian_unreachable' });
    expect(await wallet.replaceGuardian({ oldGuardianGone: true })).toMatchObject({ status: 'done', oldWalletRetired: false });

    wallet.dev!.setGuardianStatus!('online');
    await wallet.lockGuardian();
    expect(wallet.getState().guardian.status).toBe('locked');

    await wallet.startRecovery('phone');
    wallet.dev!.finishRecovery!();
    expect(wallet.getState()).toMatchObject({ recovery: null, recoveryOutcome: 'finished', hardwareConfirmRequired: true, finishedRecovery: { lostKey: 'phone' } });
    await wallet.confirmHardware();
    expect(wallet.getState().hardwareConfirmRequired).toBe(false);
  });
});

describe('silent payment errors', () => {
  it('maps the wallet\'s codes and the guardian\'s 1700 and 1701 into words and kinds', () => {
    expect(mapError(new WalletError('silent_payment_needs_helper', 'Fund your helper coin first.'))).toMatchObject({ kind: 'silent_payment_needs_helper', message: 'Fund your helper coin first.' });
    expect(mapError(new WalletError('silent_payments_unavailable', 'No scanner.'))).toMatchObject({ kind: 'silent_payments_unavailable', message: 'No scanner.' });
    expect(mapError(new WalletError('silent_payments_off', 'x'))).toMatchObject({ kind: 'silent_payments_off', message: expect.stringContaining('turned off') });
    expect(mapError(new WalletError('invalid_label', 'x'))).toMatchObject({ kind: 'invalid_input', message: expect.stringContaining('Labels start at 1') });
    // 1700: the guardian needs the node's RPC. The words say plainly what to do, and that receiving is paused.
    const noRpc = refusalToError({ kind: 'node_rpc_required', message: 'x' });
    expect(noRpc).toMatchObject({ kind: 'node_rpc_required', message: expect.stringContaining('Umbrel and Start9') });
    expect(noRpc.message).toMatch(/receiving is paused/);
    expect(mapError(new WalletError('node_rpc_required', 'x', { refusal: { kind: 'node_rpc_required', message: 'm' } }))).toMatchObject({ kind: 'node_rpc_required' });
    // 1701: register again
    expect(refusalToError({ kind: 'silent_payments_not_registered', message: 'x' })).toMatchObject({ kind: 'silent_payments_unavailable', message: expect.stringContaining('registers it again') });
    // a sweep the guardian will not relay names the rule
    expect(refusalToError({ kind: 'foreign_transaction', reason: 'output_not_to_wallet', message: 'm' }).message).toContain('output not to wallet');
  });

  it('reads silent payment addresses as addresses', () => {
    expect(looksLikeSilentPaymentAddress(DEMO_SP_RECIPIENT)).toBe(true);
    expect(looksLikeSilentPaymentAddress(DEMO_SP_RECIPIENT.toUpperCase())).toBe(true);
    expect(looksLikeBitcoinAddress(DEMO_SP_RECIPIENT)).toBe(true);
    expect(looksLikeSilentPaymentAddress('sp1qqshort')).toBe(false);
    expect(looksLikeSilentPaymentAddress('bc1q9d4xe8w2m5ka3hq7l0pz6vtrc2yn7kmr')).toBe(false);
  });
});

describe('activity of silent payments', () => {
  it('labels what was received to the address, the moves into the vault, and payments to a silent payment address', () => {
    const now = Date.UTC(2026, 9, 29, 12);
    const coin = { txid: 'a'.repeat(64), vout: 0, valueSats: 30_000, outputKey: 'b'.repeat(64), tweak: 'c'.repeat(64), label: 2, height: 120, status: 'swept' as const, sweepTxid: 'd'.repeat(64), foundAt: now - 3_600_000 };
    const items = buildActivity(
      [
        { txid: 'd'.repeat(64), height: 121, confirmations: 2, time: Math.floor(now / 1000) - 600, netSats: 29_556, silentSweep: { fromTxid: coin.txid, fromVout: 0 } },
        { txid: 'e'.repeat(64), height: 0, confirmations: 0, netSats: -20_300, feeSats: 300, amountSats: 20_000, recipient: DEMO_SP_RECIPIENT, signedBy: 'guardian', sentAt: now - 5_000, silentPayment: { outputKey: 'f'.repeat(64), outputAddress: DEMO_TAPROOT_OUTPUT } },
      ],
      emptyLog(),
      now,
      [coin],
    );
    const pays = items.flatMap((i) => (i.type === 'payment' ? [i.tx] : []));
    expect(pays.find((t) => t.kind === 'silent_sweep')).toMatchObject({ amountSats: 29_556, feeSats: 444, status: 'confirmed' });
    expect(pays.find((t) => t.kind === 'silent_received')).toMatchObject({ amountSats: 30_000, silentLabel: 2, status: 'confirmed' });
    expect(pays.find((t) => t.kind === 'sent')).toMatchObject({ address: DEMO_SP_RECIPIENT, silentOutputAddress: DEMO_TAPROOT_OUTPUT, signedBy: 'phone+guardian' });
  });
});

describe('the demo wallet\'s send max', () => {
  const fresh = () => createMockWalletService({ deviceDelayMs: 0, networkDelayMs: 0 });

  it('gives demo wallet details with three fingerprints', () => {
    const d = fresh().getWalletDetails()!;
    expect(d.descriptor).toMatch(/^wsh\(sortedmulti\(2,/);
    expect(Object.keys(d.fingerprints)).toEqual(['phone', 'hardware', 'guardian']);
  });

  it('quotes the whole balance minus the fee at each speed, and sends it', async () => {
    const w = fresh();
    const balance = w.getState().balanceSats;
    const fees = { slow: 210, normal: 420, fast: 840 };
    for (const speed of ['slow', 'normal', 'fast'] as const) {
      const q = w.quoteSendMax({ address: 'bc1qxyz', speed });
      expect(q).toMatchObject({ ok: true, quote: { max: true, feeSats: fees[speed], totalSats: balance, request: { address: 'bc1qxyz', speed, amountSats: balance - fees[speed] } } });
    }
    const q = w.quoteSendMax({ address: 'bc1qxyz', speed: 'normal' });
    if (!q.ok) throw new Error(q.message);
    // The demo balance is far over the daily limit: the hardware wallet signs it.
    expect(q.quote.plan).toEqual({ signer: 'hardware', reason: 'over-limit' });
    const tx = await w.sendPayment(q.quote);
    expect(tx).toMatchObject({ kind: 'sent', amountSats: balance - 420, feeSats: 420, signedBy: 'phone+hardware' });
    expect(w.getState().balanceSats).toBe(0);
    // Nothing left: the same words as the real wallet.
    expect(w.quoteSendMax({ address: 'bc1qxyz', speed: 'normal' })).toMatchObject({ ok: false, problem: 'insufficient_funds' });
  });

  it('refuses a balance the fee leaves below dust, a silent payment address without a helper, and Recovery Key mode', () => {
    const w = fresh();
    w.setMode('recoveryKey');
    expect(w.quoteSendMax({ address: 'bc1qxyz', speed: 'normal' })).toMatchObject({ ok: false, problem: 'other', message: expect.stringContaining('Recovery Key mode') });
    w.setMode('guardian');
    expect(mockQuoteMax({ ...w.getState(), balanceSats: 700 }, { address: 'bc1qxyz', speed: 'normal' })).toMatchObject({ ok: false, problem: 'amount_too_small' });
    expect(mockQuoteMax({ ...w.getState(), balanceSats: 966 }, { address: 'bc1qxyz', speed: 'normal' })).toMatchObject({ ok: true, quote: { request: { amountSats: 546 } } });
    const sp = w.quoteSendMax({ address: DEMO_SP_RECIPIENT, speed: 'normal' });
    expect(sp).toMatchObject({ ok: true, quote: { max: true, totalSats: w.getState().balanceSats, silentPayment: { outputAddress: DEMO_TAPROOT_OUTPUT, helperFeeSats: 396 } } });
    if (sp.ok) expect(sp.quote.feeSats).toBe(420 + 396);
    w.dev!.setHelperFunded!(false);
    expect(w.quoteSendMax({ address: DEMO_SP_RECIPIENT, speed: 'normal' })).toMatchObject({ ok: false, problem: 'needs_helper' });
  });

  it('steps a coin through the recovery\'s sweep line: being added, added, refused, retried', async () => {
    const w = fresh();
    await w.startRecovery('hardware');
    const before = w.getState().recovery!;
    expect(before.sweepUpdate).toBeUndefined();
    const step = () => {
      w.dev!.simulateRecoveryCoin!();
      return w.getState().recovery!;
    };
    expect(step()).toMatchObject({ movingSats: before.movingSats, sweepUpdate: { status: 'waiting', coins: 1, text: '1 new coin arrived. Adding it to your recovery…' } });
    expect(step()).toMatchObject({ movingSats: before.movingSats + 4_200, sweepUpdate: { status: 'added', coins: 1, text: '1 new coin was added to your recovery' } });
    const refused = step();
    expect(refused).toMatchObject({ movingSats: before.movingSats + 4_200, sweepUpdate: { status: 'refused', coins: 1 } });
    expect(refused.sweepUpdate!.text).toMatch(/^1 new coin arrived but could not be added .* can't finish until it is added\.$/);
    expect(step()).toMatchObject({ movingSats: before.movingSats + 4_200, sweepUpdate: { status: 'waiting', coins: 1 } });
    expect(step()).toMatchObject({ movingSats: before.movingSats + 8_400, sweepUpdate: { status: 'added', coins: 1 } });
  });
});

describe('a recovering phone whose access to the guardian runs out', () => {
  it('maps the wallet\'s recovery_access_expired to its own kind, in words that say what to do', () => {
    expect(mapError(new WalletError('recovery_access_expired', 'x'))).toMatchObject({
      kind: 'recovery_access_expired',
      message: expect.stringMatching(/The recovery continues at your guardian.*approve again with your hardware wallet/),
    });
  });

  it('shows in the demo and is renewed by approving again', async () => {
    const w = createMockWalletService({ deviceDelayMs: 0, networkDelayMs: 0 });
    await w.startRecovery('hardware');
    expect(w.getState().recovery!.accessExpired).toBeUndefined(); // the demo's recovery has no access to run out until asked
    w.dev!.simulateRecoveryAccessExpiry!();
    expect(w.getState()).toMatchObject({ recovering: true, recovery: { accessExpired: true } });
    w.dev!.simulateRecoveryAccessExpiry!();
    expect(w.getState().recovery!.accessExpired).toBe(false);
    w.dev!.simulateRecoveryAccessExpiry!();
    const ended = w.getState().recovery!.accessExpiresAt!;
    await w.renewRecoveryAccess();
    expect(w.getState().recovery).toMatchObject({ accessExpired: false });
    expect(new Date(w.getState().recovery!.accessExpiresAt!).getTime()).toBeGreaterThan(new Date(ended).getTime());
  });
});

describe('the demo wallet\'s silent payments', () => {
  const fresh = () => createMockWalletService({ deviceDelayMs: 0, networkDelayMs: 0 });

  it('shows sample data: an address, a helper coin, a balance waiting to move, and the scan status', async () => {
    const w = fresh();
    const sp = w.getState().silentPayments;
    expect(sp).toMatchObject({ support: 'full', setUp: true, receiving: true, scan: { state: 'ok', source: 'guardian' }, labels: [1], helper: { funded: true, viaGuardian: true }, balance: { sats: 42_000 } });
    expect(sp.move).toMatchObject({ ready: 2, totalFeeSats: 888, totalNetSats: 41_112 });
    expect(await w.silentPayments!.address()).toMatch(/^sp1q/);
    expect(await w.silentPayments!.address({ label: 1 })).not.toBe(await w.silentPayments!.address());
    expect(await w.silentPayments!.helperAddress()).toMatch(/^bc1q/);
    const kinds = w.getState().activity.flatMap((i) => (i.type === 'payment' ? [i.tx.kind] : []));
    expect(kinds).toEqual(expect.arrayContaining(['silent_received', 'silent_sweep']));
  });

  it('moves the received coins into the vault, one transaction each, and lists the moves', async () => {
    const w = fresh();
    const before = w.getState().balanceSats;
    const r = await w.silentPayments!.move();
    expect(r).toEqual({ moved: 2, movedSats: 41_112, feeSats: 888, waiting: 0, failed: 0 });
    expect(w.getState().balanceSats).toBe(before + 41_112);
    expect(w.getState().silentPayments.balance.sats).toBe(0);
    const moves = w.getState().activity.flatMap((i) => (i.type === 'payment' && i.tx.kind === 'silent_sweep' ? [i.tx] : []));
    expect(moves.length).toBe(3); // the two new ones and the earlier one
    expect(await w.silentPayments!.move()).toMatchObject({ moved: 0 });
  });

  it('finds a new payment on a check, and says plainly when the guardian has no node RPC', async () => {
    const w = fresh();
    expect(await w.silentPayments!.check()).toEqual({ found: 1 });
    expect(w.getState().silentPayments.balance.sats).toBe(42_000 + 18_500);
    expect(await w.silentPayments!.check()).toEqual({ found: 0 });
    w.dev!.setNodeRpc!(false);
    expect(w.getState().silentPayments.scan).toMatchObject({ state: 'needs_node_rpc', message: expect.stringContaining('Umbrel and Start9') });
    await expect(w.silentPayments!.check()).rejects.toMatchObject({ kind: 'node_rpc_required' });
    w.dev!.setNodeRpc!(true);
    expect(w.getState().silentPayments.scan.state).toBe('ok');
  });

  it('turns off and on, and adds a label', async () => {
    const w = fresh();
    await w.silentPayments!.disable();
    expect(w.getState().silentPayments).toMatchObject({ receiving: false, scan: { state: 'off' } });
    await expect(w.silentPayments!.address()).rejects.toMatchObject({ kind: 'silent_payments_off' });
    await w.silentPayments!.enable();
    expect(w.getState().silentPayments.receiving).toBe(true);
    const { label, address } = await w.silentPayments!.addLabel();
    expect(label).toBe(2);
    expect(address).toMatch(/^sp1q/);
    expect(w.getState().silentPayments.labels).toEqual([1, 2]);
    await expect(w.silentPayments!.address({ label: 0 })).rejects.toMatchObject({ kind: 'invalid_input' });
  });

  it('quotes a payment to a silent payment address with the helper coin\'s share, and asks to fund the helper when there is none', async () => {
    const w = fresh();
    const q = w.quoteSend({ address: DEMO_SP_RECIPIENT, amountSats: 10_000, speed: 'normal' });
    expect(q).toMatchObject({ ok: true, quote: { plan: { signer: 'phone+guardian' }, silentPayment: { outputAddress: DEMO_TAPROOT_OUTPUT, helperFeeSats: 396 } } });
    if (!q.ok) return;
    expect(q.quote.feeSats).toBe(420 + 396);
    const tx = await w.sendPayment(q.quote);
    expect(tx).toMatchObject({ address: DEMO_SP_RECIPIENT, silentOutputAddress: DEMO_TAPROOT_OUTPUT, signedBy: 'phone+guardian' });
    expect(w.getState().silentPayments.helper.sats).toBe(24_320 - 396);
    w.dev!.setHelperFunded!(false);
    expect(w.quoteSend({ address: DEMO_SP_RECIPIENT, amountSats: 10_000, speed: 'normal' })).toMatchObject({ ok: false, problem: 'needs_helper' });
    // Recovery Key mode pays from the spending balance, without a helper; the vault cannot make one.
    w.setMode('recoveryKey');
    expect(w.quoteSend({ address: DEMO_SP_RECIPIENT, amountSats: 10_000, speed: 'normal' })).toMatchObject({ ok: true, quote: { plan: { signer: 'phone' }, silentPayment: {} } });
    expect(w.quoteSend({ address: DEMO_SP_RECIPIENT, amountSats: 10_000, speed: 'normal', signer: 'hardware' })).toMatchObject({ ok: false, message: expect.stringContaining('spending balance') });
  });

  it('reads sp1 codes and bitcoin: links with sp= as silent payment addresses', () => {
    const w = fresh();
    expect(w.readCode(DEMO_SP_RECIPIENT)).toMatchObject({ kind: 'address', address: DEMO_SP_RECIPIENT, silentPayment: true });
    expect(w.readCode(`bitcoin:?sp=${DEMO_SP_RECIPIENT}&amount=0.0003`)).toMatchObject({ kind: 'address', address: DEMO_SP_RECIPIENT, silentPayment: true, amountSats: 30_000 });
  });
});
