import { describe, expect, it } from 'vitest';
import { npubEncode } from 'nostr-tools/nip19';
import { getPublicKey } from 'nostr-tools/pure';
import { WalletError } from '@trikey/wallet';
import { SoftwareHardwareProvider, SoftwareHardwareSigner } from '@trikey/wallet/testing';
import { HardwareError } from '../hardware/errors';
import { CloudBackupError, SecureKeyError, cloudBackupError, secureKeyError } from '../platform/errors';
import { addEvent, addSend, buildActivity, emptyLog, hostFromLabel } from './app-log';
import { DevicePromptStore, compositeProvider, ledgerHint, withDevicePrompts } from './device';
import { WalletServiceError } from './errors';
import { GuardianAddressError, parseGuardianAddress } from './guardian-address';
import { mapError, refusalToError } from './real-errors';
import { createMockWalletService } from './mock';
import { quoteSend as mockQuote } from './rules';

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
  it('lists the guardian\'s history with what the app knows about each payment, and security events', () => {
    const log = emptyLog();
    const now = Date.UTC(2026, 9, 29, 12);
    addSend(log, { txid: 'a'.repeat(64), address: 'bcrt1qexample', amountSats: 30_000, feeSats: 200, signedBy: 'phone+guardian', at: now - 60_000 });
    addSend(log, { txid: 'c'.repeat(64), address: 'bcrt1qexample2', amountSats: 5_000, feeSats: 100, signedBy: 'phone+hardware', at: now - 10_000 });
    addEvent(log, { kind: 'limit-changed', limitSats: 80_000, direction: 'lowered', approvedOn: 'phone', at: now - 120_000 });
    log.seen['b'.repeat(64)] = now - 30_000;
    const items = buildActivity(
      [
        { txid: 'a'.repeat(64), height: 0, confirmations: 0, netSats: -30_200, feeSats: 200 },
        { txid: 'b'.repeat(64), height: 0, confirmations: 0, netSats: 50_000 },
        { txid: 'd'.repeat(64), height: 100, confirmations: 3, time: Math.floor(now / 1000) - 86_400, netSats: 700_000 },
      ],
      log,
      now,
    );
    const pay = (i: (typeof items)[number]) => (i.type === 'payment' ? i.tx : undefined);
    expect(items.map((i) => (i.type === 'payment' ? i.tx.txid[0] : i.event.kind))).toEqual(['c', 'b', 'a', 'limit-changed', 'd']);
    expect(pay(items[2]!)).toMatchObject({ kind: 'sent', amountSats: 30_000, feeSats: 200, status: 'pending', address: 'bcrt1qexample', signedBy: 'phone+guardian' });
    expect(pay(items[0]!)).toMatchObject({ kind: 'sent', amountSats: 5_000, status: 'pending' }); // sent a moment ago, not listed yet
    expect(pay(items[1]!)).toMatchObject({ kind: 'received', amountSats: 50_000, status: 'pending' });
    expect(pay(items[4]!)).toMatchObject({ kind: 'received', status: 'confirmed', amountSats: 700_000 });
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
});
