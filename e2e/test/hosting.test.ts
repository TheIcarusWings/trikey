/**
 * Family hosting on a real chain (docs/design/family-hosting.md, sections 15 and 16): a guest's wallet on the host's
 * guardian, with the guest's chain data from a server of its own (here a stand-in that reads the same regtest Electrs
 * directly, never through the host's guardian's RPC, as the guest's own Esplora would).
 *
 * Phase 1 and 2 against a real node: accepting an invite with the contact lock on, a payment co-signed under the limit
 * (its change goes into the guardian's ledger), the limit off with the hardware wallet and a payment past the old limit,
 * a pause from the phone (the payment goes to the hardware wallet) and the hardware wallet resuming it, then leaving: the
 * leave check names the money still there, the guest sends everything out with the hardware wallet, and once a block
 * confirms it the guardian finds its co-signed coins spent on its own Electrs and releases the slot.
 *
 * Regtest only, throwaway keys.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { hex } from '@scure/base';
import { MultisigWallet } from '@trikey/core';
import { TrikeyWallet, type ChainSnapshot, type ChainSource, type WalletDeps } from '@trikey/wallet';
import { externalAddress, newMnemonic, logGuardianOnFailure, newPhone, softwareDevice, syncUntil, walletError, type Phone } from '../src/kit.js';
import { startRig, type E2eRig } from '../src/rig.js';
import { describeE2e } from '../src/suite.js';

/** The guest's "own server": the regtest Electrs read directly by script (a scan of the first 30 addresses per chain). */
class GuestChain implements ChainSource {
  readonly kind = 'esplora';
  constructor(
    private readonly rig: E2eRig,
    private readonly wallet: MultisigWallet,
  ) {}
  private get chain() {
    return this.rig.guardian.chain;
  }
  async sync(): Promise<ChainSnapshot> {
    // The same scan the guardian runs for its own wallets, here as the guest's own server would (gap limit 20).
    const r = await this.chain.walletSync(this.wallet);
    return {
      tipHeight: r.tipHeight,
      tipHash: r.tipHash,
      utxos: r.utxos.map((u) => ({ txid: u.txid, vout: u.vout, valueSats: Number(u.value), height: Math.max(0, u.height), confirmations: u.confirmations, chain: u.chain, index: u.index })),
      utxosTruncated: r.utxosTruncated,
      balance: { confirmedSats: Number(r.confirmedSats), unconfirmedSats: Number(r.unconfirmedSats) },
      history: r.history.map((h) => ({ txid: h.txid, height: h.height, confirmations: h.confirmations, ...(h.time !== undefined ? { time: h.time } : {}), netSats: Number(h.net), ...(h.fee !== undefined ? { feeSats: Number(h.fee) } : {}) })),
      historyTruncated: r.historyTruncated,
      nextReceiveIndex: r.nextReceiveIndex,
      nextChangeIndex: r.nextChangeIndex,
      gapLimit: r.gapLimit,
    };
  }
  getTransaction(txid: string): Promise<string> {
    return this.chain.getTransaction(txid);
  }
  async broadcast(txHex: string): Promise<string> {
    return (await this.chain.broadcast(txHex)).txid;
  }
  estimateFees(targets = [1, 3, 6]) {
    return this.chain.estimateFees(targets);
  }
  async unspentByScript(scripts: string[]) {
    return (await this.chain.scriptUnspent(scripts.map((s) => hex.decode(s)))).map((u) => ({ script: hex.encode(u.script), txid: u.txid, vout: u.vout, valueSats: Number(u.value), height: u.height, confirmations: u.confirmations }));
  }
}

describeE2e('family hosting on a real chain', () => {
  let rig: E2eRig;
  const device = softwareDevice(newMnemonic());
  let phone: Phone;
  let G: TrikeyWallet;
  let slotId: string;

  logGuardianOnFailure(() => rig);

  beforeAll(async () => {
    rig = await startRig();
    const hostedChain: WalletDeps['hostedChain'] = ({ wallet }) => new GuestChain(rig, wallet);
    phone = newPhone(rig, device, { hostedChain });
    G = await TrikeyWallet.create(phone.deps, { deviceName: 'E2E guest phone' });
  });

  afterAll(async () => {
    await G?.close().catch(() => undefined);
    await rig?.stop();
  });

  it('accepts an invite with the contacts allowed to pause the wallet; receives after the phone key backup', async () => {
    const now = rig.clock.now();
    const inv = await rig.guardian.hosting.registry.createInvite('Guest', now);
    if (!inv.ok) throw new Error(inv.message);
    slotId = inv.slot.slotId;
    const { encodeInviteUri } = await import('@trikey/protocol');
    const link = encodeInviteUri(
      { guardianPubkey: rig.pubkey, relays: rig.relayUrls, secret: inv.secret, expiresAt: Math.floor(inv.slot.invite!.expiresAt / 1000), network: 'regtest', label: 'E2E host' },
      Math.floor(now / 1000),
    );
    await G.connectHardware();
    const out = await G.acceptInvite({ inviteUri: link, rules: { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: ['cd'.repeat(32)], sweepFeeCapSats: 20_000, contactLock: true }, walletLabel: 'Guest', understood: true });
    expect(out).toMatchObject({ hosted: true, addressVerified: true });
    expect(G.contactLockOn).toBe(true);
    await G.createBackup({ passkey: true });
    const { index } = await G.receiveAddress();
    await rig.fund(G.multisig().derive(0, index).script, 400_000n);
    await rig.mine(1);
    await syncUntil(G, (s) => s.balance.confirmedSats === 400_000, 'the funding to confirm');
  });

  it('pays under the limit with the guardian (into the real mempool), then past the old limit once it is off', async () => {
    const small = await G.send({ address: externalAddress(), amountSats: 30_000 });
    expect(small).toMatchObject({ ok: true, signedBy: 'phone+guardian' });
    await rig.mine(1);
    expect((await G.hostedCoins()).length).toBe(1); // its change, in the guardian's ledger
    await G.turnLimitOff();
    await G.refreshStatus();
    expect(G.limitOff).toBe(true);
    const big = await G.send({ address: externalAddress(4), amountSats: 150_000 });
    expect(big).toMatchObject({ ok: true, signedBy: 'phone+guardian' });
    await rig.mine(1);
    await G.setDailyLimit(100_000);
  });

  it('pauses from the phone (the host box stays unlocked): the payment goes to the hardware wallet; the hardware wallet resumes', async () => {
    await G.lockGuardian();
    expect(G.hostedPause).toMatchObject({ by: 'phone' });
    expect(rig.guardian.locked).toBe(false);
    const paid = await G.send({ address: externalAddress(5), amountSats: 10_000 });
    expect(paid).toMatchObject({ ok: true, signedBy: 'phone+hardware' });
    await rig.mine(1);
    await G.resumePhoneSpending();
    expect(G.hostedPause).toBeUndefined();
  });

  it('leaves: refused while money is there; after sending everything out with the hardware wallet, the slot is released', async () => {
    await G.sync();
    expect((await G.hostedLeaveCheck()).safe).toBe(false);
    expect((await walletError(G.leaveHost())).code).toBe('not_safe_to_release');
    const all = G.quoteSendMax({ address: externalAddress(6), signer: 'hardware' });
    const out = await G.send(all);
    expect(out).toMatchObject({ ok: true, signedBy: 'phone+hardware' });
    await rig.mine(1);
    await syncUntil(G, (s) => s.balance.totalSats === 0, 'the wallet to be empty');
    expect(await G.hostedLeaveCheck()).toEqual({ safe: true, blockers: [] });
    await G.leaveHost();
    const slot = rig.guardian.hosting.registry.slot(slotId)!;
    expect(slot.state).toBe('left');
    expect(slot.key3Mix).toBeUndefined();
  });
});
