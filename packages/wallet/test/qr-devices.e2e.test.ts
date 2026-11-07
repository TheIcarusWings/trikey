/**
 * QR hardware wallets by model (qr-devices.ts), in the wallet:
 *
 * - the capability table: which models sign Trikey's texts and how (a text QR, or a microSD file for Passport gen 2 and
 *   Krux), their limits, and that the smallest limit (Coldcard's 240) is Trikey's own maximum;
 * - every text Trikey asks a hardware wallet to sign (pairing, approvals, recovery access, the notes key, the unlock key)
 *   at its longest fits that limit and Coldcard's spacing rules: this test fails if a text grows past it;
 * - against the real guardian in-process (regtest, throwaway keys): a QR device's model is stored with the wallet, a
 *   record made before models existed reads as "Other", notes and hardware unlock are offered only for a model that
 *   signs texts (unlock not for a microSD model), the owner can set the model later, and turning notes on tells the
 *   device it is round 1 then 2 of 2.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GuardianRig } from '@trikey/guardian/testing';
import { DEVICE_VISIBLE_LENGTH, MAX_ALERT_CONTACTS, MAX_APPROVAL_MESSAGE_LENGTH, MAX_SATS, approvalMessage, pairingMessage, pairingRulesMessage, recoveryAccessMessage, unlockKeyMessage, type Policy } from '@trikey/protocol';
import {
  MIN_QR_MESSAGE_LIMIT,
  QR_MODELS,
  QR_MODEL_INFO,
  TrikeyWallet,
  qrMessageMethod,
  qrModelUnlocks,
  WalletError,
  defaultQrModelOf,
  labelsKeyMessage,
  messageProblemFor,
  qrModelInfo,
} from '../src/index.js';
import { StateStore } from '../src/state.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareProvider, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, phone, type Phone } from './helpers.js';

const WALLET = 'ffffffffffffffff';
const NOSTR = 'f'.repeat(64);
const COSIGNER = '03' + 'f'.repeat(64);
const LATE = 4_102_444_799; // 2099-12-31T23:59:59Z

/** Every text Trikey signs with the authorization key, each at its longest. */
function longestTexts(): Record<string, string> {
  const contacts = Array.from({ length: MAX_ALERT_CONTACTS }, (_, i) => (i + 1).toString(16).padStart(64, '0'));
  const big: Policy = { dailyLimitSats: MAX_SATS - 1, recoveryDelayDays: 30, alertContacts: contacts, sweepFeeCapSats: MAX_SATS, contactLock: true };
  const ctx = { walletId: WALLET, sequence: Number.MAX_SAFE_INTEGER, expiresAt: LATE };
  return {
    pairing: pairingMessage(WALLET, COSIGNER),
    'policy v1': approvalMessage({ action: 'policy', policy: { ...big, contactLock: false } }, ctx),
    'policy v2 (limit off)': approvalMessage({ action: 'policy', policy: { ...big, dailyLimitSats: MAX_SATS, contactLock: false } }, ctx),
    'policy v3 (contact lock)': approvalMessage({ action: 'policy', policy: big }, ctx),
    'policy v3 (lock turned off)': approvalMessage({ action: 'policy', policy: { ...big, contactLock: false }, contactLockBefore: true }, ctx),
    // Version 4 (`approval_contacts`): the contacts by name, or their number and code when they do not fit.
    'policy v4 (contacts named)': approvalMessage({ action: 'policy', policy: { ...big, alertContacts: contacts.slice(0, 2) } }, { ...ctx, contactsInText: true }),
    'policy v4 (contacts code)': approvalMessage({ action: 'policy', policy: big }, { ...ctx, contactsInText: true }),
    'policy v4 (limit off)': approvalMessage({ action: 'policy', policy: { ...big, dailyLimitSats: MAX_SATS } }, { ...ctx, contactsInText: true }),
    'pairing rules v4': pairingRulesMessage({ ...big, contactLock: false, alertContacts: contacts.slice(0, 3) }, { walletId: WALLET, expiresAt: LATE, contactsInText: true }),
    'cancel-recovery': approvalMessage({ action: 'cancel-recovery', recoveryId: 'z'.repeat(40) }, ctx),
    'resume-phone': approvalMessage({ action: 'resume-phone' }, ctx),
    'retire-wallet': approvalMessage({ action: 'retire-wallet' }, ctx),
    'add-wallet': approvalMessage({ action: 'add-wallet', newWalletId: 'eeeeeeeeeeeeeeee' }, ctx),
    'recovery-access v1': recoveryAccessMessage({ guardianPubkey: NOSTR, phonePubkey: NOSTR, expiresAt: LATE }),
    'recovery-access v2': recoveryAccessMessage({ guardianPubkey: NOSTR, phonePubkey: NOSTR, expiresAt: LATE, walletId: WALLET }),
    'notes key': labelsKeyMessage(WALLET, 'testnet'),
    'unlock key': unlockKeyMessage({ walletId: WALLET, guardianPubkey: NOSTR, network: 'testnet', slot: 'f'.repeat(16) }),
  };
}

describe('the QR model table', () => {
  it('lists every model once, and a model that signs texts has device steps; one that cannot says why', () => {
    expect(Object.keys(QR_MODEL_INFO).sort()).toEqual([...QR_MODELS].sort());
    for (const model of QR_MODELS) {
      const info = QR_MODEL_INFO[model];
      expect(info.model).toBe(model);
      expect(info.name.length).toBeGreaterThan(2);
      if (!info.qr) expect(info.signsMessages).toBe(false);
      if (info.signsMessages) expect(info.messageSteps?.length).toBeGreaterThanOrEqual(2);
      else expect(info.whyNot).toMatch(/\w/);
    }
  });

  it('says which devices sign texts, and how, as the firmware sources read', () => {
    const signs = QR_MODELS.filter((m) => QR_MODEL_INFO[m].signsMessages);
    expect(signs).toEqual(['coldcard-q', 'jade', 'keystone-3', 'passport-prime', 'passport', 'krux', 'specter-diy']);
    expect(QR_MODELS.filter((m) => qrMessageMethod(m) === 'qr-text')).toEqual(['coldcard-q', 'jade', 'keystone-3', 'passport-prime', 'specter-diy']);
    expect(QR_MODELS.filter((m) => qrMessageMethod(m) === 'microsd')).toEqual(['passport', 'krux']);
    expect(QR_MODELS.filter((m) => qrMessageMethod(m) === 'none')).toEqual(['coldcard-mk4', 'seedsigner', 'other']);
    // Hardware unlock: never from a microSD card (a card round trip after every guardian restart).
    expect(QR_MODELS.filter((m) => qrModelUnlocks(m))).toEqual(['coldcard-q', 'jade', 'keystone-3', 'passport-prime', 'specter-diy']);
    expect(QR_MODEL_INFO['coldcard-mk4']).toMatchObject({ qr: false, signsMessages: false, whyNot: expect.stringMatching(/no camera.*NFC or USB/) });
    // SeedSigner: decided, payments only (no blind BIP 322 proof).
    expect(QR_MODEL_INFO.seedsigner.whyNot).toMatch(/m\/48'.*co-signs payments only/);
    for (const m of ['passport', 'krux'] as const) {
      expect(QR_MODEL_INFO[m]).toMatchObject({ messageMethod: 'microsd', showsAddress: 'p2pkh', noEdgeSpaces: true, unlockWhyNot: expect.stringMatching(/microSD card.*passphrase/) });
      expect(QR_MODEL_INFO[m].messageSteps!.join(' ')).toMatch(/\{file\}/);
    }
    expect(QR_MODEL_INFO.passport.maxSpaceRun).toBe(3);
    expect(QR_MODEL_INFO.krux.displayLength).toBe(120);
    expect(QR_MODEL_INFO.other.signsMessages).toBe(false);
    expect(QR_MODEL_INFO.jade.displayLength).toBe(188);
    expect(QR_MODEL_INFO['keystone-3'].showsAddress).toBe('none');
    expect(QR_MODEL_INFO['passport-prime'].signsFromAccount).toBe(true);
    expect(qrModelInfo(undefined).model).toBe('other');
    expect(qrModelInfo('nonsense' as never).model).toBe('other');
    expect([defaultQrModelOf('qr'), defaultQrModelOf('jade'), defaultQrModelOf('coldcard'), defaultQrModelOf('ledger')]).toEqual(['other', 'jade', 'coldcard-q', undefined]);
  });

  it("Coldcard's 240-character limit is the smallest, and it is exactly Trikey's own maximum", () => {
    expect(QR_MODEL_INFO['coldcard-q'].maxMessageLength).toBe(240);
    expect(MIN_QR_MESSAGE_LIMIT).toBe(240);
    expect(MAX_APPROVAL_MESSAGE_LENGTH).toBe(MIN_QR_MESSAGE_LIMIT);
  });

  it("checks a text against the model: length, printable ASCII, Coldcard's spacing rules", () => {
    expect(messageProblemFor('coldcard-q', 'a'.repeat(240))).toBeUndefined();
    expect(messageProblemFor('coldcard-q', 'a'.repeat(241))).toMatch(/241 characters; the Coldcard Q signs at most 240/);
    expect(messageProblemFor('coldcard-q', ' Trikey')).toMatch(/space/);
    expect(messageProblemFor('coldcard-q', 'Trikey   pair')).toMatch(/three spaces/);
    expect(messageProblemFor('coldcard-q', 'x')).toMatch(/too short/);
    expect(messageProblemFor('jade', 'café')).toMatch(/ASCII/);
    expect(messageProblemFor('jade', 'line\nbreak')).toMatch(/ASCII/);
    expect(messageProblemFor('jade', 'a'.repeat(300))).toBeUndefined();
    // Passport gen 2 (utils.py validate_sign_text): no space at either end, at most 3 in a row, its 4096-byte file.
    expect(messageProblemFor('passport', 'Trikey   pair')).toBeUndefined();
    expect(messageProblemFor('passport', 'Trikey    pair')).toMatch(/more than 3 spaces in a row/);
    expect(messageProblemFor('passport', 'Trikey ')).toMatch(/starts or ends with a space/);
    expect(messageProblemFor('passport', 'a'.repeat(4001))).toMatch(/signs at most 4000/);
    // Krux strips every line, so a space at either end would change the text it signs.
    expect(messageProblemFor('krux', ' Trikey')).toMatch(/Krux does not sign a text that starts or ends with a space/);
    expect(messageProblemFor('krux', 'a'.repeat(1000))).toBeUndefined();
  });
});

describe('every text Trikey signs fits every QR device that signs texts', () => {
  const texts = longestTexts();

  it.each(Object.entries(texts))('%s', (_name, text) => {
    expect(text.length).toBeLessThanOrEqual(MIN_QR_MESSAGE_LIMIT);
    for (const model of QR_MODELS.filter((m) => QR_MODEL_INFO[m].signsMessages)) expect(messageProblemFor(model, text)).toBeUndefined();
  });

  it('a version-4 policy text ends its contacts within what Jade shows (188), at its longest', () => {
    for (const [name, text] of Object.entries(texts).filter(([n]) => n.includes('v4'))) {
      expect(text.indexOf(' expires='), name).toBeLessThanOrEqual(DEVICE_VISIBLE_LENGTH);
      expect(QR_MODEL_INFO.jade.displayLength).toBe(DEVICE_VISIBLE_LENGTH);
    }
  });

  it('the longest is a policy approval with a 16-digit sequence, just under the limit', () => {
    const longest = Math.max(...Object.values(texts).map((t) => t.length));
    expect(longest).toBe(texts['policy v3 (lock turned off)']!.length);
    expect(longest).toBeGreaterThan(230);
    expect(longest).toBeLessThanOrEqual(240);
  });
});

// ------------------------------------------------------------------------------------------------ in the wallet

const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 };
const device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'qr', model: 'Coldcard Q', qrModel: 'coldcard-q' });
let rig: GuardianRig;
let p: Phone;
let w: TrikeyWallet;

beforeAll(async () => {
  rig = await GuardianRig.start();
  p = phone({ clock: rig.clock, hardware: new SoftwareHardwareProvider(device), cloud: new MemoryCloudBackupStore(), passkey: new MemoryPasskeyPrf() });
  w = await TrikeyWallet.create(p.deps, { deviceName: 'QR phone' });
  await w.onboard({ pairingUri: rig.pairingUri(), rules: RULES, hardwareKind: 'qr' });
}, 30_000);

afterAll(async () => {
  await w?.close().catch(() => undefined);
  await rig?.stop();
});

describe('a QR device in the wallet', { timeout: 60_000 }, () => {
  it('pairs (the device signed the pairing text) and stores its model', () => {
    expect(w.state.stage).toBe('paired');
    expect(w.state.hardware).toMatchObject({ kind: 'qr', qrModel: 'coldcard-q' });
    expect(device.calls.find((c) => c.op === 'signMessage')).toMatchObject({ context: { purpose: 'pairing' } });
  });

  it('offers notes and hardware unlock for a model that signs texts', () => {
    expect(w.notesView()).toMatchObject({ available: true });
    expect(w.hardwareUnlockView()).toMatchObject({ available: true });
  });

  it('turning notes on asks for the same text twice and says which round it is', async () => {
    const n = device.calls.length;
    await w.enableNotes();
    const rounds = device.calls.slice(n).flatMap((c) => (c.op === 'signMessage' ? [c.context] : []));
    expect(rounds).toEqual([
      { purpose: 'notes', round: { n: 1, of: 2 } },
      { purpose: 'notes', round: { n: 2, of: 2 } },
    ]);
    await w.disableNotes();
  });

  it('a model that signs from a microSD card: notes are offered, hardware unlock is not, with the reason', async () => {
    for (const model of ['passport', 'krux'] as const) {
      await w.setHardwareModel(model);
      expect(w.notesView()).toMatchObject({ available: true });
      expect(w.hardwareUnlockView()).toMatchObject({ available: false, unavailable: 'microsd', on: false });
      const e = await w.enableHardwareUnlock().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(WalletError);
      expect((e as WalletError).message).toMatch(/only from a microSD card.*passphrase unlocks your guardian/);
    }
    await w.setHardwareModel('coldcard-q');
    expect(w.hardwareUnlockView()).toMatchObject({ available: true });
  });

  it('a model that signs no text: notes and unlock are not offered, and the reason names the device', async () => {
    await w.setHardwareModel('seedsigner');
    expect(w.state.hardware?.qrModel).toBe('seedsigner');
    expect(w.notesView()).toMatchObject({ available: false, unavailable: 'hardware' });
    expect(w.hardwareUnlockView()).toMatchObject({ available: false, unavailable: 'hardware' });
    const e = await w.enableNotes().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(WalletError);
    expect((e as WalletError).message).toMatch(/SeedSigner doesn.t sign messages with a multisig key/);
    await w.setHardwareModel('jade');
    expect(w.notesView()).toMatchObject({ available: true });
  });

  it('only a QR device has a model to set, and only a known one', async () => {
    await expect(w.setHardwareModel('nonsense' as never)).rejects.toMatchObject({ code: 'wrong_state' });
  });

  it('a record made before models existed reads as "Other" (no texts) until the owner picks the model', async () => {
    const key = new StateStore(p.deps.store).key;
    const raw = JSON.parse((await p.deps.store.get(key))!);
    delete raw.hardware.qrModel;
    await p.deps.store.set(key, JSON.stringify(raw));
    const loaded = await new StateStore(p.deps.store).load();
    expect(loaded!.hardware).toMatchObject({ kind: 'qr', qrModel: 'other' });
  });
});
