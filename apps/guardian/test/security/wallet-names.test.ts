/**
 * Security sweep 2, finding 15 (MEDIUM): wallet names chosen on the phone went unfiltered into the guardian's signed
 * alert DMs to the owner's contacts. A phone thief renames the first wallet to `trikey-help.io` (or `OK TEST` with a
 * line break), adds a wallet of their own (paired phone only), starts a recovery: every DM about it to the contacts
 * begins with the thief's text, and a link in it makes the contacts dismiss the genuine alert as phishing (DESIGN.md:
 * "a message with a link is not from the guardian"). The same for a guest's `walletLabel` in DMs to its contacts.
 *
 * Now a name shows in alerts with its letters, digits, spaces, `-` and `'` only (`safeName`): no dot, no colon or
 * slash, no line break. The stored name is unchanged (the phone rebuilds the hardware wallet's registration name from
 * it); a guest's label is cleaned when it is set. The app refuses such names when they are typed (packages/wallet).
 */
import { HDKey } from '@scure/bip32';
import { hex } from '@scure/base';
import { afterEach, describe, expect, it } from 'vitest';
import { MultisigWallet, type KeyExpression } from '@trikey/core';
import { isSafeName, safeName, type Policy } from '@trikey/protocol';
import { labelled } from '../../src/runtime.js';
import { isLinkFree } from '../../src/notify/render.js';
import { HostedEngine, MemoryHostedStore } from '../../src/hosting/engine.js';
import { ClockChain, ManualClock, SoftwareCosignerSigner, pairingMessage, signMessage, type Rules } from '../../src/policy/index.js';
import { GuardianRig } from '../support/index.js';
import { fakeMap, hostedWallet } from '../support/hosted.js';
import { APP_NOSTR, AUTH_PATH, CONTACT_A, MNEMONICS, T0, appSigner, hwAuthPrivateKey, hwAuthPubkey, hwSigner, network, withRulesApproval } from '../helpers.js';
import { callHandler, pairInRig } from './support.js';

/** Nothing a nostr app could turn into a link, and no line break (render.ts `isLinkFree` is the alert channels' check). */
const clean = (text: string) => isLinkFree(text) && !/[\r\n]/.test(text);

describe('security: wallet names in alerts (finding 15)', () => {
  let rig: GuardianRig;
  afterEach(async () => rig?.stop());

  it('names keep letters, digits, spaces, - and apostrophes only', () => {
    expect(safeName('trikey-help.io', 16)).toBe('trikey-help io');
    expect(safeName('OK\nreply STOP', 16)).toBe('OK reply STOP');
    expect(safeName('https://x.co/a', 16)).toBe('https x co a');
    expect(safeName("Anna’s iPhone (2)", 64)).toBe('Anna’s iPhone 2');
    expect(safeName('Épargne für Kinder', 16)).toBe('Épargne für Kind');
    expect(safeName('貯金', 16)).toBe('貯金');
    expect(safeName('💰', 16)).toBe('');
    expect(isSafeName("Kids' savings")).toBe(true);
    for (const bad of ['a.b', 'x\ny', 'a:b', 'a/b', ' lead', 'two  spaces', '']) expect(isSafeName(bad)).toBe(false);
  });

  it("a phone's own wallet names never put a link or a line break in an alert", async () => {
    rig = await GuardianRig.start();
    const g = rig.guardian;
    await pairInRig(rig, { alertContacts: [CONTACT_A] });
    const prep = await callHandler(rig, 'wallet.add.prepare', { account: 2 });
    const key3: KeyExpression = { fingerprint: prep.guardianKey.fingerprint, originPath: prep.guardianKey.path.replace(/^m\//, '').replace(/'/g, 'h'), xpub: prep.guardianKey.xpub };
    const wallet = new MultisigWallet(network, { app: await appSigner().getKey(network, 2), hardware: await hwSigner(MNEMONICS.hardware2).getKey(network), cosigner: key3 });
    const rules: Policy = { dailyLimitSats: 50_000, recoveryDelayDays: 7, alertContacts: [CONTACT_A], sweepFeeCapSats: 20_000 };
    const res = await callHandler(
      rig,
      'wallet.add',
      withRulesApproval(
        {
          account: 2,
          name: 'evil.example\nOK',
          firstName: 'trikey-help.io',
          descriptor: wallet.descriptor(),
          hardwareAuth: { pubkey: hwAuthPubkey(AUTH_PATH, MNEMONICS.hardware2), path: AUTH_PATH },
          hardwareAuthProof: signMessage(pairingMessage(wallet.fingerprint(), hex.encode(HDKey.fromExtendedKey(prep.guardianKey.xpub, network.bip32).publicKey!)), hwAuthPrivateKey(AUTH_PATH, MNEMONICS.hardware2)),
          rules,
        },
        g.clock.now(),
        hwAuthPrivateKey(AUTH_PATH, MNEMONICS.hardware2),
      ),
      APP_NOSTR,
    );
    // Stored and answered as given: the phone rebuilds the device's registration name from it.
    expect(res.name).toBe('evil.example\nOK');
    expect(g.wallets.registry.firstName).toBe('trikey-help.io');
    // What the contacts' DMs start with: the first wallet's and the added wallet's.
    const own = g.wallets.active()[0]!;
    const firstLine = labelled(g, 'Trikey alert: someone started a recovery.');
    const ownLine = labelled(own, 'Trikey alert: someone started a recovery.');
    expect(firstLine).toBe('trikey-help io: Trikey alert: someone started a recovery.');
    expect(ownLine).toBe('evil example OK: Trikey alert: someone started a recovery.');
    for (const label of [g.label()!, own.label()!]) expect(clean(label)).toBe(true);
  }, 60_000);

  it("a guest's wallet label is cleaned when it is set", async () => {
    const clock = new ManualClock(T0);
    const signer = new SoftwareCosignerSigner(new Uint8Array(32).fill(21));
    const engine = await HostedEngine.open({ slotId: '0123456789abcdef', store: new MemoryHostedStore(), clock, chain: new ClockChain(clock) });
    const fx = await hostedWallet({ cosignerPub: hex.encode(signer.accountPubkey) });
    const rules: Rules = { dailyLimitSats: 100_000n, recoveryDelayDays: 7, alertContacts: [CONTACT_A], sweepFeeCapSats: 20_000n };
    const res = await engine.register(
      {
        network: 'regtest',
        accountPubkeys: { app: fx.accountPubkeys.app, hardware: fx.accountPubkeys.hardware },
        cosignerAccountPubkey: fx.accountPubkeys.cosigner,
        rules,
        hardwareAuth: fx.hardwareAuth,
        hardwareAuthProof: fx.proof,
        rulesApproval: fx.approveRules(rules, clock.now()),
        appNostrPubkey: APP_NOSTR,
        walletLabel: 'Ana\n\nUPDATE: all fine, see https://evil.example',
        walletMap: fakeMap(),
      },
      signer,
    );
    expect(res.ok).toBe(true);
    const label = engine.registration()!.walletLabel;
    expect(label).toBe('Ana UPDATE all fine see https evil example');
    expect(clean(label)).toBe(true);
  });
});
