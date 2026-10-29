/**
 * BIP 68 relative timelocks (and nLockTime) against real consensus and policy. The unit tests check our nSequence
 * encoding against our own reading of BIP 68; here the node decides.
 *
 * - A 2-of-3 spend whose input has a relative lock of 10 blocks (`buildSpend`'s `sequence` option) is refused as
 *   `non-BIP68-final` until exactly the block the encoding promises (`relativeLockHeight`: coin height + 10), and then
 *   accepted and mined in that block. A spend of the same coin with the default nSequence is not refused: the lock, not
 *   anything else, is what the node objects to.
 * - The same for a height-based nLockTime (`non-final`).
 * - The Recovery Key refill chain (`@trikey/recovery-key`): each refill spends the previous refill's change with a
 *   relative lock of one period. The node refuses a refill while its parent is unconfirmed and until the period has
 *   passed after the parent confirmed.
 *
 * On the dry-run fakes the transactions are built and signed (and the refill chain verified), but a fake node has no
 * consensus rules to ask.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { base64, hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { randomBytes } from '@noble/hashes/utils.js';
import {
  MultisigWallet,
  SEQUENCE_RBF,
  SoftwareSigner,
  TX_OPTS,
  absoluteLockHeight,
  bip48Path,
  cosignerKeyExpression,
  relativeLockHeight,
  type Utxo,
} from '@trikey/core';
import {
  SpendingAccount,
  buildRefillChain,
  deriveKey2,
  finalizeRefill,
  keyFromDevice,
  recoveryKeyFromEntropy,
  verifyRefillChain,
  type RefillChainRecord,
  type StoredRefill,
  type VaultCoin,
} from '@trikey/recovery-key';
import { externalAddress, HARDWARE_MNEMONICS, logGuardianOnFailure, network, newMnemonic, softwareDevice } from '../src/kit.js';
import { startRig, type E2eRig } from '../src/rig.js';
import { buildSignedSpend, stripWitness, type SignedSpend } from '../src/spend.js';
import { describeE2e } from '../src/suite.js';
import { NodeRpcError } from '../src/node-rpc.js';

describeE2e('BIP 68 relative timelocks against real consensus', () => {
  let rig: E2eRig;

  logGuardianOnFailure(() => rig);

  beforeAll(async () => {
    rig = await startRig();
  });

  afterAll(async () => {
    await rig?.stop();
  });

  /**
   * A transaction that the node must refuse until the chain tip reaches `earliestBlock - 1` (it can be mined in block
   * `earliestBlock` at the earliest, and enters the mempool once the next block would be that one). Checks the node's
   * verdict at the tip it is at now, one block short, and exactly there; mines the blocks in between.
   */
  async function expectLockedUntil(tx: { txHex: string; txid: string }, earliestBlock: number, reason: RegExp): Promise<void> {
    const chain = rig.chain!;
    const refused = async (what: string) => {
      const v = await chain.testMempoolAccept(tx.txHex);
      expect(v.allowed, `${what}: tip ${await rig.height()}, earliest block ${earliestBlock}`).toBe(false);
      expect(v['reject-reason']).toMatch(reason);
    };
    const tip = await rig.height();
    expect(tip).toBeLessThan(earliestBlock - 2);
    await refused('at the start');
    await rig.mine(earliestBlock - 2 - tip);
    await refused('one block short');
    await rig.mine(1);
    expect(await rig.height()).toBe(earliestBlock - 1);
    const ok = await chain.testMempoolAccept(tx.txHex);
    expect(ok, `accepted exactly one block before ${earliestBlock}`).toMatchObject({ allowed: true });
  }

  describe('a 2-of-3 spend with a relative lock of 10 blocks', () => {
    const appMnemonic = newMnemonic();
    const hardwareMnemonic = newMnemonic();
    let wallet: MultisigWallet;
    const coin = async (index: number, sats: bigint): Promise<Utxo> => {
      const c = await rig.fund(wallet.derive(0, index).script, sats);
      return { txid: c.txid, vout: c.vout, value: c.value, chain: 0, index };
    };
    const spend = (coins: Utxo[], opts: { sequence?: number; lockTime?: number } = {}): Promise<SignedSpend> =>
      buildSignedSpend({
        wallet,
        coins,
        recipients: [{ address: externalAddress(5), amount: 50_000n }],
        feeRate: 5,
        changeIndex: 0,
        appMnemonic,
        hardwareMnemonic,
        ...opts,
      });

    beforeAll(async () => {
      const app = await new SoftwareSigner('app', appMnemonic).getKey(network);
      const hardware = await new SoftwareSigner('hardware', hardwareMnemonic).getKey(network);
      // The third key is nobody's: any two of three satisfy the script.
      const third = HDKey.fromMasterSeed(randomBytes(32)).derive(bip48Path(network));
      wallet = new MultisigWallet(network, { app, hardware, cosigner: cosignerKeyExpression(third.publicKey!, randomBytes(32), network) });
    });

    it('is refused as non-BIP68-final until the block the encoding promises, then accepted and mined in that block', async () => {
      const c = await coin(0, 100_000n);
      await rig.mine(1);
      const coinHeight = await rig.height();
      const locked = await spend([c], { sequence: 10 });
      const decoded = btc.Transaction.fromRaw(hex.decode(locked.txHex));
      expect([decoded.version, decoded.getInput(0).sequence]).toEqual([2, 10]);
      const earliest = relativeLockHeight(10, coinHeight)!;
      expect(earliest).toBe(coinHeight + 10);
      if (!rig.chain) return;

      // Control: the same coin, default nSequence, is fine now. The lock is what the node objects to.
      const free = await spend([c]);
      expect(btc.Transaction.fromRaw(hex.decode(free.txHex)).getInput(0).sequence).toBe(SEQUENCE_RBF);
      expect(await rig.chain.testMempoolAccept(free.txHex)).toMatchObject({ allowed: true });

      await expectLockedUntil(locked, earliest, /non-BIP68-final/);
      expect(await rig.broadcastToNode(locked.txHex)).toBe(locked.txid);
      await rig.mine(1);
      expect(await rig.height()).toBe(earliest);
      expect(await rig.confirmations(locked.txid)).toBe(1);
      const tx = await rig.chain.transaction(locked.txid);
      expect(tx?.blockhash).toBe(await rig.chain.node.call<string>('getblockhash', [earliest]));

      // Asked to relay one too early, sendrawtransaction names the same rule.
      const early = await spend([await coin(1, 100_000n)], { sequence: 10 });
      await rig.mine(1);
      const err = await rig.chain.sendRawTransaction(early.txHex).then(
        () => undefined,
        (e: unknown) => e as NodeRpcError,
      );
      expect(err).toBeInstanceOf(NodeRpcError);
      expect(err?.message).toMatch(/non-BIP68-final/);
    });

    it('refuses a height-based nLockTime the same way (non-final), accepts it one block before it can be mined', async () => {
      const c = await coin(2, 100_000n);
      await rig.mine(1);
      const tip = await rig.height();
      const lockTime = tip + 6;
      const tx = await spend([c], { lockTime });
      const decoded = btc.Transaction.fromRaw(hex.decode(tx.txHex));
      expect([decoded.lockTime, decoded.getInput(0).sequence]).toEqual([lockTime, SEQUENCE_RBF]);
      const earliest = absoluteLockHeight(lockTime, [SEQUENCE_RBF])!;
      expect(earliest).toBe(lockTime + 1);
      if (!rig.chain) return;
      await expectLockedUntil(tx, earliest, /non-final/);
      expect(await rig.broadcastToNode(tx.txHex)).toBe(tx.txid);
      await rig.mine(1);
      expect(await rig.height()).toBe(earliest);
      expect(await rig.confirmations(tx.txid)).toBe(1);
    });
  });

  describe('the Recovery Key refill chain', () => {
    const PERIOD = 6;
    const phoneMnemonic = newMnemonic();
    const device = softwareDevice(HARDWARE_MNEMONICS.two, 'trezor');
    let vault: MultisigWallet;
    let spending: SpendingAccount;
    let signed: StoredRefill[];
    let record: RefillChainRecord;
    let vaultCoin: VaultCoin;

    beforeAll(async () => {
      const phone = deriveKey2(phoneMnemonic, network);
      const hardware = keyFromDevice(device.info.fingerprint, await device.getXpub("m/48'/1'/0'/2'"), network, 0);
      vault = new MultisigWallet(network, { app: phone.vault, hardware, cosigner: recoveryKeyFromEntropy(randomBytes(16), network) });
      spending = new SpendingAccount(network, phone.spending);
      const funded = await rig.fund(vault.derive(0, 0).script, 1_000_000n);
      await rig.mine(1);
      vaultCoin = { txid: funded.txid, vout: funded.vout, value: funded.value, chain: 0, index: 0, prevTxHex: stripWitness(funded.rawTx) };
      const unsigned = buildRefillChain({
        vault,
        spending,
        head: { inputs: [vaultCoin], sequences: [SEQUENCE_RBF], lockTime: 0 },
        params: { amount: 200_000n, count: 3, periodBlocks: PERIOD, feeRate: 2 },
        startPosition: 1,
        spendIndices: [0, 1, 2],
        changeIndices: [0, 1, 2],
      });
      // Signed the way the wallet does it: the hardware wallet first, then the phone.
      const app = new SoftwareSigner('app', phoneMnemonic);
      const policy = { name: 'Trikey', descriptor: vault.descriptor() };
      signed = [];
      for (const r of unsigned) {
        const byHardware = base64.decode(await device.signPsbt(base64.encode(r.psbt), policy));
        signed.push(finalizeRefill(r, await app.signPsbt(byHardware, network)));
      }
      record = {
        id: 'e2e-chain',
        descriptor: vault.descriptor(),
        amountSats: 200_000,
        periodBlocks: PERIOD,
        refills: signed,
        batches: [{ id: 'batch-1', createdAt: 0, createdHeight: await rig.height(), from: 1, to: 3, feeRate: 2 }],
      };
    });

    it('builds a chain that verifies, with the relative lock on every link', () => {
      verifyRefillChain(record, { vault, spending, minRelaySatPerVb: 1 });
      const seqs = signed.map((r) => btc.Transaction.fromRaw(hex.decode(r.txHex), TX_OPTS).getInput(0).sequence);
      expect(seqs).toEqual([SEQUENCE_RBF, PERIOD, PERIOD]);
    });

    it('the node accepts the first refill, refuses each next one until a period after its parent confirmed, and mines them in order', async () => {
      if (!rig.chain) return;
      const chain = rig.chain;
      const [r1, r2, r3] = signed as [StoredRefill, StoredRefill, StoredRefill];

      // Refill 1 spends vault coins with no lock; the node takes it, with a fee at a feerate it relays.
      expect(await chain.testMempoolAccept(r1.txHex)).toMatchObject({ allowed: true });
      expect(await rig.broadcastToNode(r1.txHex)).toBe(r1.txid);
      // Refill 2 while its parent is unconfirmed: the parent counts as mined in the next block, so the lock cannot hold.
      expect((await chain.testMempoolAccept(r2.txHex))['reject-reason']).toMatch(/non-BIP68-final/);
      await rig.mine(1);
      const confirmed1 = await rig.height();
      expect(await rig.confirmations(r1.txid)).toBe(1);

      await expectLockedUntil(r2, relativeLockHeight(PERIOD, confirmed1)!, /non-BIP68-final/);
      expect(await rig.broadcastToNode(r2.txHex)).toBe(r2.txid);
      await rig.mine(1);
      const confirmed2 = await rig.height();
      expect(confirmed2).toBe(confirmed1 + PERIOD);
      expect(await rig.confirmations(r2.txid)).toBe(1);

      await expectLockedUntil(r3, relativeLockHeight(PERIOD, confirmed2)!, /non-BIP68-final/);
      expect(await rig.broadcastToNode(r3.txHex)).toBe(r3.txid);
      await rig.mine(1);
      expect(await rig.height()).toBe(confirmed2 + PERIOD);
      expect(await rig.confirmations(r3.txid)).toBe(1);

      // What reached the spending balance: three refills of 200,000 to the phone's own addresses.
      const spendScripts = [0, 1, 2].map((i) => hex.encode(spending.derive(1, i).script));
      for (const [i, r] of [r1, r2, r3].entries()) {
        const tx = (await chain.transaction(r.txid))!;
        expect(tx.vout[0]!.scriptPubKey.hex).toBe(spendScripts[i]);
        expect(Math.round(tx.vout[0]!.value * 1e8)).toBe(200_000);
      }
    });
  });
});
