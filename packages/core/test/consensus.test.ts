/**
 * Every transaction shape the wallet produces, checked against Bitcoin Core's
 * script interpreter instead of our own analysis. Needs `npm run build:verifier`
 * (skipped locally without it, failing in CI).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { CHANGE, RECEIVE, ROLES, Role, MultisigWallet, TX_OPTS } from '../src/wallet.js';
import { PsbtError, analyzePsbt, buildSpend, buildSweep, combinePsbts, finalizePsbt, parsePsbt } from '../src/psbt.js';
import { fund } from './helpers.js';
import {
  assertConsensusInvalid,
  assertConsensusValid,
  describeConsensus,
  spentOutputsOfPsbt,
  verifyConsensus,
} from './support/consensus.js';
import {
  Ctx,
  childKey,
  ecdsaSignature,
  makeCtx,
  multisigWitness,
  network,
  signAs,
  signAsCosigner,
  signWith,
  sortOrder,
  withWitness,
} from './support/signing.js';

const PAIRS: [Role, Role][] = [
  ['app', 'cosigner'], // phone + guardian
  ['app', 'hardware'], // phone + hardware wallet
  ['hardware', 'cosigner'], // hardware wallet + guardian
];
const pairName = (p: [Role, Role]) => p.join(' + ');

const dest = btc.p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(3), true), network.btc).address!;
const SEQUENCE_RBF = 0xfffffffd;

/** Finalizes a signed PSBT and runs Bitcoin Core's verifier over it. */
function check(psbt: Uint8Array, flags?: Parameters<typeof verifyConsensus>[2]) {
  const { txHex } = finalizePsbt(psbt);
  return { txHex, result: verifyConsensus(txHex, spentOutputsOfPsbt(psbt), flags) };
}

function sequencesOf(txHex: string): number[] {
  return btc.RawTx.decode(hex.decode(txHex)).inputs.map((i) => i.sequence);
}

describeConsensus('consensus: transactions we produce', () => {
  let ctx: Ctx;
  let wallet: MultisigWallet;
  beforeAll(async () => {
    ctx = await makeCtx();
    wallet = ctx.wallet;
  });

  describe('each pair of keys', () => {
    for (const pair of PAIRS) {
      it(`${pairName(pair)} spend with change`, async () => {
        const plan = buildSpend({
          wallet,
          utxos: [fund(wallet, RECEIVE, 0, 200_000n)],
          recipients: [{ address: dest, amount: 80_000n }],
          feeRate: 3,
          changeIndex: 0,
        });
        expect(plan.change).toBeDefined();
        const { result } = check(await signWith(ctx, pair, plan.psbt));
        assertConsensusValid(result);
      });

      it(`${pairName(pair)} sweep to a new wallet`, async () => {
        const { wallet: next } = { wallet: (await makeCtx({ cosignerSeed: 11 })).wallet };
        const plan = buildSweep({
          from: wallet,
          utxos: [fund(wallet, RECEIVE, 2, 90_000n), fund(wallet, CHANGE, 1, 60_000n)],
          destination: next,
          destinationIndex: 0,
          feeRate: 2,
        });
        const { result } = check(await signWith(ctx, pair, plan.psbt));
        assertConsensusValid(result);
      });
    }

    it('any one key alone is refused (control for the pair tests)', async () => {
      const plan = buildSpend({
        wallet,
        utxos: [fund(wallet, RECEIVE, 0, 100_000n)],
        recipients: [{ address: dest, amount: 50_000n }],
        feeRate: 1,
        changeIndex: 0,
      });
      for (const role of ROLES) {
        const signed = await signAs(ctx, role, plan.psbt);
        expect(() => finalizePsbt(signed)).toThrow(); // our finalizer refuses
        // and so does Bitcoin Core, if we force the lone signature into a witness
        const tx = parsePsbt(signed);
        const d = wallet.derive(RECEIVE, 0);
        const [, sig] = tx.getInput(0).partialSig![0];
        const raw = withWitness(parsePsbt(plan.psbt), 0, multisigWitness([sig], d.witnessScript));
        assertConsensusInvalid(verifyConsensus(raw, spentOutputsOfPsbt(plan.psbt)), [0]);
      }
    });
  });

  describe('every sort order of the three keys', () => {
    // sortedmulti orders pubkeys by bytes, so the order of app/hardware/guardian
    // changes from address to address. Find an address for each of the 6 orders.
    const byOrder = new Map<string, number>();
    const orders = () => {
      if (!byOrder.size) {
        for (let i = 0; i < 400 && byOrder.size < 6; i++) {
          const key = sortOrder(wallet.derive(RECEIVE, i)).join('<');
          if (!byOrder.has(key)) byOrder.set(key, i);
        }
      }
      return byOrder;
    };

    it('the wallet reaches all 6 orders', () => {
      expect(orders().size).toBe(6);
    });

    for (const a of ROLES) {
      for (const b of ROLES) {
        for (const c of ROLES) {
          if (new Set([a, b, c]).size !== 3) continue;
          const order = `${a}<${b}<${c}`;
          for (const pair of PAIRS) {
            it(`${pairName(pair)} spending where ${order}`, async () => {
              const index = orders().get(order);
              expect(index, `no address found with order ${order}`).toBeDefined();
              expect(sortOrder(wallet.derive(RECEIVE, index!)).join('<')).toBe(order);
              const plan = buildSpend({
                wallet,
                utxos: [fund(wallet, RECEIVE, index!, 100_000n)],
                recipients: [{ address: dest, amount: 40_000n }],
                feeRate: 2,
                changeIndex: 0,
              });
              assertConsensusValid(check(await signWith(ctx, pair, plan.psbt)).result);
              // signing in the opposite order, and combining separately signed PSBTs, must give the same result
              const swapped = await signWith(ctx, [pair[1], pair[0]], plan.psbt);
              assertConsensusValid(check(swapped).result);
              const combined = combinePsbts([await signAs(ctx, pair[0], plan.psbt), await signAs(ctx, pair[1], plan.psbt)]);
              assertConsensusValid(check(combined).result);
            });
          }
        }
      }
    }
  });

  describe('transaction shapes', () => {
    it('several inputs from the receive and change chains', async () => {
      const utxos = [
        fund(wallet, RECEIVE, 0, 30_000n),
        fund(wallet, RECEIVE, 7, 45_000n),
        fund(wallet, CHANGE, 0, 25_000n),
        fund(wallet, CHANGE, 4, 70_000n),
        fund(wallet, RECEIVE, 19, 12_000n),
      ];
      const plan = buildSpend({ wallet, utxos, recipients: [{ address: dest, amount: 170_000n }], feeRate: 5, changeIndex: 3 });
      expect(plan.inputs).toHaveLength(5);
      expect(new Set(plan.inputs.map((u) => u.chain))).toEqual(new Set([RECEIVE, CHANGE]));
      for (const pair of PAIRS) {
        const { result } = check(await signWith(ctx, pair, plan.psbt));
        assertConsensusValid(result);
        expect(result.inputs).toHaveLength(5);
      }
    });

    it('custom nSequence and nLockTime: signed and accepted by Bitcoin Core', async () => {
      const spend = buildSpend({
        wallet,
        utxos: [fund(wallet, RECEIVE, 0, 200_000n), fund(wallet, CHANGE, 2, 90_000n)],
        recipients: [{ address: dest, amount: 250_000n }],
        feeRate: 3,
        changeIndex: 3,
        sequence: [1008, 2016],
        lockTime: 1500,
      });
      const sweep = buildSweep({
        from: wallet,
        utxos: [fund(wallet, RECEIVE, 2, 90_000n), fund(wallet, CHANGE, 1, 60_000n)],
        destination: wallet,
        destinationIndex: 0,
        feeRate: 2,
        sequence: 0xfffffffe,
        lockTime: 800_000,
      });
      for (const pair of PAIRS) {
        const s = check(await signWith(ctx, pair, spend.psbt));
        assertConsensusValid(s.result);
        expect(sequencesOf(s.txHex)).toEqual([1008, 2016]);
        expect(btc.RawTx.decode(hex.decode(s.txHex)).lockTime).toBe(1500);

        const w = check(await signWith(ctx, pair, sweep.psbt));
        assertConsensusValid(w.result);
        expect(sequencesOf(w.txHex)).toEqual([0xfffffffe, 0xfffffffe]);
        expect(btc.RawTx.decode(hex.decode(w.txHex)).lockTime).toBe(800_000);
      }
    });

    it('a payment with change: two recipients plus a change output', async () => {
      const second = btc.p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(4), true), network.btc).address!;
      const plan = buildSpend({
        wallet,
        utxos: [fund(wallet, RECEIVE, 1, 500_000n)],
        recipients: [
          { address: dest, amount: 100_000n },
          { address: second, amount: 50_000n },
        ],
        feeRate: 4,
        changeIndex: 2,
      });
      expect(plan.change).toBeDefined();
      const signed = await signWith(ctx, ['app', 'hardware'], plan.psbt);
      const { txHex, result } = check(signed);
      assertConsensusValid(result);
      const raw = btc.RawTx.decode(hex.decode(txHex));
      expect(raw.outputs).toHaveLength(3);
      expect(raw.outputs[2].script).toEqual(wallet.derive(CHANGE, 2).script);
    });

    it('a payment that leaves no change', async () => {
      // 20_000 in, 19_500 out: what is left after the fee is below dust, so there is no change output.
      const plan = buildSpend({
        wallet,
        utxos: [fund(wallet, RECEIVE, 0, 20_000n)],
        recipients: [{ address: dest, amount: 19_500n }],
        feeRate: 2,
        changeIndex: 0,
      });
      expect(plan.change).toBeUndefined();
      const { txHex, result } = check(await signWith(ctx, ['hardware', 'cosigner'], plan.psbt));
      assertConsensusValid(result);
      expect(btc.RawTx.decode(hex.decode(txHex)).outputs).toHaveLength(1);
    });

    it('a sweep (one output, no change) from hardware + guardian', async () => {
      const next = (await makeCtx({ cosignerSeed: 12 })).wallet;
      const plan = buildSweep({
        from: wallet,
        utxos: [fund(wallet, RECEIVE, 0, 80_000n), fund(wallet, RECEIVE, 1, 80_000n), fund(wallet, CHANGE, 0, 80_000n)],
        destination: next,
        destinationIndex: 5,
        feeRate: 6,
      });
      expect(plan.change).toBeUndefined();
      const { txHex, result } = check(await signWith(ctx, ['hardware', 'cosigner'], plan.psbt));
      assertConsensusValid(result);
      const raw = btc.RawTx.decode(hex.decode(txHex));
      expect(raw.outputs).toHaveLength(1);
      expect(raw.outputs[0].script).toEqual(next.derive(RECEIVE, 5).script);
    });

    it('a different hardware wallet key set', async () => {
      const other = await makeCtx({ hardware: 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong' });
      const plan = buildSpend({
        wallet: other.wallet,
        utxos: [fund(other.wallet, RECEIVE, 6, 100_000n)],
        recipients: [{ address: dest, amount: 30_000n }],
        feeRate: 2,
        changeIndex: 0,
      });
      assertConsensusValid(check(await signWith(other, ['app', 'hardware'], plan.psbt)).result);
    });
  });

  describe('delegated (tweaked) guardian key', () => {
    it('the guardian signs with account key + tweak, as the wallet only gives it raw pubkeys', async () => {
      const utxos = [fund(wallet, RECEIVE, 9, 60_000n), fund(wallet, CHANGE, 13, 60_000n), fund(wallet, RECEIVE, 1_000_001, 60_000n)];
      const plan = buildSpend({ wallet, utxos, recipients: [{ address: dest, amount: 150_000n }], feeRate: 2, changeIndex: 0 });
      const signed = await signWith(ctx, ['app', 'cosigner'], plan.psbt);
      // the cosigner's view: raw account pubkeys and tweaks only
      const analysis = analyzePsbt(signed, wallet.accountPubkeys(), network);
      for (const input of analysis.inputs) expect(input.signedBy.sort()).toEqual(['app', 'cosigner']);
      assertConsensusValid(check(signed).result);
    });

    it('the untweaked account key does not unlock the address (the tweak matters)', async () => {
      const d = wallet.derive(RECEIVE, 3);
      const plan = buildSpend({
        wallet,
        utxos: [fund(wallet, RECEIVE, 3, 100_000n)],
        recipients: [{ address: dest, amount: 30_000n }],
        feeRate: 1,
        changeIndex: 0,
      });
      const tx = parsePsbt(plan.psbt);
      const ws = d.witnessScript;
      const spent = spentOutputsOfPsbt(plan.psbt);
      const sign = (key: Uint8Array) => ecdsaSignature(key, tx, 0, ws, 100_000n);
      const rawWith = (cosignerKey: Uint8Array) =>
        withWitness(
          parsePsbt(plan.psbt),
          0,
          multisigWitness(orderSigs(d, [['app', sign(childKey(ctx, 'app', d))], ['cosigner', sign(cosignerKey)]]), ws),
        );
      assertConsensusValid(verifyConsensus(rawWith(childKey(ctx, 'cosigner', d)), spent));
      assertConsensusInvalid(verifyConsensus(rawWith(ctx.accountKeys.cosigner), spent), [0]);
    });
  });

  describe('nSequence and RBF', () => {
    it('spends and sweeps signal RBF (0xfffffffd) on every input and verify', async () => {
      const spend = buildSpend({
        wallet,
        utxos: [fund(wallet, RECEIVE, 0, 40_000n), fund(wallet, CHANGE, 1, 40_000n)],
        recipients: [{ address: dest, amount: 70_000n }],
        feeRate: 2,
        changeIndex: 0,
      });
      const sweep = buildSweep({
        from: wallet,
        utxos: [fund(wallet, RECEIVE, 0, 40_000n), fund(wallet, CHANGE, 1, 40_000n)],
        destination: wallet,
        destinationIndex: 8,
        feeRate: 2,
      });
      for (const plan of [spend, sweep]) {
        const { txHex, result } = check(await signWith(ctx, ['app', 'hardware'], plan.psbt));
        assertConsensusValid(result);
        expect(sequencesOf(txHex)).toEqual([SEQUENCE_RBF, SEQUENCE_RBF]);
      }
    });

    // Signatures commit to nSequence, so whatever value is set before signing must verify.
    it.each([
      ['final', 0xffffffff],
      ['non-final, no RBF', 0xfffffffe],
      ['zero', 0],
    ])('a sequence of %s (%d) set before signing verifies', async (_name, sequence) => {
      const plan = buildSpend({
        wallet,
        utxos: [fund(wallet, RECEIVE, 0, 40_000n), fund(wallet, RECEIVE, 1, 40_000n)],
        recipients: [{ address: dest, amount: 50_000n }],
        feeRate: 2,
        changeIndex: 0,
      });
      const tx = parsePsbt(plan.psbt);
      for (let i = 0; i < tx.inputsLength; i++) tx.updateInput(i, { sequence });
      const psbt = await signWith(ctx, ['app', 'cosigner'], tx.toPSBT());
      const { txHex, result } = check(psbt);
      assertConsensusValid(result);
      expect(sequencesOf(txHex)).toEqual([sequence, sequence]);
    });
  });

  describe('refill-style transaction with a BIP 68 relative timelock', () => {
    // Recovery Key mode: each refill spends the previous refill's vault change and
    // sets nSequence so it cannot confirm for ~1008 blocks (BIP 68, tx version >= 2).
    // The 2-of-3 script itself has no timelock opcode, so Bitcoin Core enforces the
    // lock outside the script interpreter; what the interpreter checks is that
    // signatures commit to the exact nSequence.
    const BLOCKS_1008 = 1008;
    const TIME_LOCK = (1 << 22) | 2; // 2 x 512 seconds

    async function refill(sequence: number) {
      const plan = buildSpend({
        wallet,
        utxos: [fund(wallet, CHANGE, 0, 1_000_000n)],
        recipients: [{ address: wallet.derive(RECEIVE, 0).address, amount: 100_000n }],
        feeRate: 2,
        changeIndex: 1,
      });
      const tx = parsePsbt(plan.psbt);
      tx.updateInput(0, { sequence });
      return tx.toPSBT();
    }

    it.each([
      ['1008 blocks', BLOCKS_1008],
      ['1 block', 1],
      ['2 x 512 seconds', TIME_LOCK],
    ])('phone + hardware refill locked for %s verifies, with every flag and with the CSV flag alone', async (_n, seq) => {
      const psbt = await signWith(ctx, ['app', 'hardware'], await refill(seq));
      const all = check(psbt);
      assertConsensusValid(all.result);
      expect(sequencesOf(all.txHex)).toEqual([seq]);
      expect(btc.RawTx.decode(hex.decode(all.txHex)).version).toBe(2);
      assertConsensusValid(check(psbt, { flags: ['P2SH', 'WITNESS', 'CHECKSEQUENCEVERIFY'] }).result);
    });

    it('a sequence changed after signing no longer verifies', async () => {
      const signed = await signWith(ctx, ['app', 'hardware'], await refill(BLOCKS_1008));
      const { txHex } = finalizePsbt(signed);
      const raw = btc.RawTx.decode(hex.decode(txHex));
      // a thief shortening the lock to spend early must invalidate the signatures
      raw.inputs[0].sequence = 1;
      assertConsensusInvalid(verifyConsensus(hex.encode(btc.RawTx.encode(raw)), spentOutputsOfPsbt(signed)), [0]);
    });

    describe('OP_CHECKSEQUENCEVERIFY inside the script, with the matching flag', () => {
      // A witness script that enforces BIP 112 itself, to show the CSV flag is
      // honoured by the verifier we use: <1008> CSV DROP 2 <k1> <k2> <k3> 3 CHECKMULTISIG.
      const d = () => wallet.derive(RECEIVE, 0);
      const csvScript = (locktime: number) => {
        const keys = [...ROLES].map((r) => d().pubkeys[r]).sort((a, b) => hex.encode(a).localeCompare(hex.encode(b)));
        return btc.Script.encode([locktime, 'CHECKSEQUENCEVERIFY', 'DROP', 2, ...keys, 3, 'CHECKMULTISIG']);
      };

      function spendCsv(opts: { script: Uint8Array; sequence: number; version: number }) {
        const spk = btc.Script.encode(['OP_0', sha256(opts.script)]);
        const amount = 100_000n;
        const tx = new btc.Transaction({ ...TX_OPTS, version: opts.version });
        tx.addInput({ txid: hex.encode(sha256(new Uint8Array([1]))), index: 0, sequence: opts.sequence, witnessUtxo: { script: spk, amount } });
        tx.addOutput({ script: btc.OutScript.encode(btc.Address(network.btc).decode(dest)), amount: 90_000n });
        const order = sortOrder(d());
        const sigs = order.slice(0, 2).map((r) => ecdsaSignature(childKey(ctx, r, d()), tx, 0, opts.script, amount));
        const raw = withWitness(tx, 0, multisigWitness(sigs, opts.script));
        return { raw, spent: [{ script: spk, amount }] };
      }

      const NO_CSV = ['P2SH', 'DERSIG', 'NULLDUMMY', 'CHECKLOCKTIMEVERIFY', 'WITNESS'] as const;

      it('passes when nSequence satisfies the lock (version 2, sequence >= 1008)', () => {
        for (const sequence of [BLOCKS_1008, BLOCKS_1008 + 5]) {
          const { raw, spent } = spendCsv({ script: csvScript(BLOCKS_1008), sequence, version: 2 });
          assertConsensusValid(verifyConsensus(raw, spent));
        }
      });

      it.each([
        ['sequence below the lock', 1007, 2],
        ['sequence with the disable flag set', 0xffffffff, 2],
        ['time-based sequence for a block-based lock', TIME_LOCK, 2],
        ['transaction version 1 (BIP 68/112 need version 2)', BLOCKS_1008, 1],
      ])('fails with the CSV flag, passes without it: %s', (_n, sequence, version) => {
        const { raw, spent } = spendCsv({ script: csvScript(BLOCKS_1008), sequence, version });
        assertConsensusInvalid(verifyConsensus(raw, spent), [0]);
        assertConsensusValid(verifyConsensus(raw, spent, { flags: [...NO_CSV] }));
      });
    });
  });
});

/** Orders signatures to match the pubkey order of the witness script. */
function orderSigs(d: ReturnType<MultisigWallet['derive']>, sigs: [Role, Uint8Array][]): Uint8Array[] {
  const order = sortOrder(d);
  return [...sigs].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([, s]) => s);
}

describeConsensus('consensus: transactions that must be rejected', () => {
  let ctx: Ctx;
  let wallet: MultisigWallet;
  beforeAll(async () => {
    ctx = await makeCtx();
    wallet = ctx.wallet;
  });

  const AMOUNT = 100_000n;
  const INDEX = 2;

  /** An unsigned one-input spend, plus the pieces needed to hand-build witnesses. */
  function setup(w: MultisigWallet = wallet, index = INDEX) {
    const d = w.derive(RECEIVE, index);
    const plan = buildSpend({
      wallet: w,
      utxos: [fund(w, RECEIVE, index, AMOUNT)],
      recipients: [{ address: dest, amount: 60_000n }],
      feeRate: 2,
      changeIndex: 0,
    });
    return { d, plan, tx: parsePsbt(plan.psbt), spent: spentOutputsOfPsbt(plan.psbt) };
  }

  type Built = ReturnType<typeof setup>;

  /** The correct witness, built by hand; a control that the broken variants below are compared with. */
  const sigsFor = (s: Built, roles: Role[], opts?: Parameters<typeof ecdsaSignature>[5], amount = AMOUNT) =>
    orderSigs(s.d, roles.map((r) => [r, ecdsaSignature(childKey(ctx, r, s.d), s.tx, 0, s.d.witnessScript, amount, opts)] as [Role, Uint8Array]));
  const rawOf = (s: Built, witness: Uint8Array[]) => withWitness(parsePsbt(s.plan.psbt), 0, witness);

  it('control: the hand-built witness is accepted', () => {
    const s = setup();
    const raw = rawOf(s, multisigWitness(sigsFor(s, ['app', 'hardware']), s.d.witnessScript));
    assertConsensusValid(verifyConsensus(raw, s.spent));
  });

  it('only one signature', () => {
    const s = setup();
    for (const r of ROLES) {
      const raw = rawOf(s, multisigWitness(sigsFor(s, [r]), s.d.witnessScript));
      assertConsensusInvalid(verifyConsensus(raw, s.spent), [0]);
    }
  });

  it('the same signature twice', () => {
    const s = setup();
    const [sig] = sigsFor(s, ['app']);
    assertConsensusInvalid(verifyConsensus(rawOf(s, multisigWitness([sig, sig], s.d.witnessScript)), s.spent), [0]);
  });

  it('a signature from a key that is not in the script', () => {
    const s = setup();
    const [appSig] = sigsFor(s, ['app']);
    const stranger = ecdsaSignature(new Uint8Array(32).fill(0x42), s.tx, 0, s.d.witnessScript, AMOUNT);
    for (const sigs of [[appSig, stranger], [stranger, appSig]]) {
      assertConsensusInvalid(verifyConsensus(rawOf(s, multisigWitness(sigs, s.d.witnessScript)), s.spent), [0]);
    }
  });

  it("a signature from the right role's key at a different address", () => {
    const s = setup();
    const other = wallet.derive(RECEIVE, INDEX + 1);
    const wrong = ecdsaSignature(childKey(ctx, 'hardware', other), s.tx, 0, s.d.witnessScript, AMOUNT);
    const [appSig] = sigsFor(s, ['app']);
    const sigs = orderSigs(s.d, [['app', appSig], ['hardware', wrong]]);
    assertConsensusInvalid(verifyConsensus(rawOf(s, multisigWitness(sigs, s.d.witnessScript)), s.spent), [0]);
  });

  it('the account key without the delegated tweak', () => {
    const s = setup();
    const [appSig] = sigsFor(s, ['app']);
    const untweaked = ecdsaSignature(ctx.accountKeys.hardware, s.tx, 0, s.d.witnessScript, AMOUNT);
    const sigs = orderSigs(s.d, [['app', appSig], ['hardware', untweaked]]);
    assertConsensusInvalid(verifyConsensus(rawOf(s, multisigWitness(sigs, s.d.witnessScript)), s.spent), [0]);
  });

  describe('a signature over a different amount (the segwit v0 amount commitment)', () => {
    it.each([
      ['one satoshi less', -1n],
      ['one satoshi more', 1n],
      ['a hundred times more', 99n * AMOUNT],
    ])('both signatures commit to %s', (_n, delta) => {
      const s = setup();
      const raw = rawOf(s, multisigWitness(sigsFor(s, ['app', 'hardware'], undefined, AMOUNT + delta), s.d.witnessScript));
      assertConsensusInvalid(verifyConsensus(raw, s.spent), [0]);
    });

    it('only one of the two signatures commits to a different amount', () => {
      const s = setup();
      const [a, b] = [sigsFor(s, ['app']), sigsFor(s, ['hardware'], undefined, AMOUNT - 1n)];
      const sigs = orderSigs(s.d, [['app', a[0]], ['hardware', b[0]]]);
      assertConsensusInvalid(verifyConsensus(rawOf(s, multisigWitness(sigs, s.d.witnessScript)), s.spent), [0]);
    });

    it('the verifier uses the amount of the real output: lying about it fails valid signatures', () => {
      const s = setup();
      const raw = rawOf(s, multisigWitness(sigsFor(s, ['app', 'hardware']), s.d.witnessScript));
      assertConsensusValid(verifyConsensus(raw, s.spent));
      assertConsensusInvalid(verifyConsensus(raw, [{ script: s.spent[0].script, amount: AMOUNT + 1n }]), [0]);
    });
  });

  describe('wrong sighash type', () => {
    const NONE = btc.SigHash.NONE;
    const SINGLE_ACP = btc.SigHash.SINGLE_ANYONECANPAY;

    it('signed as ALL but labelled NONE (or the reverse)', () => {
      const s = setup();
      for (const opts of [
        { digestType: btc.SigHash.ALL, appendType: NONE },
        { digestType: NONE, appendType: btc.SigHash.ALL },
        { digestType: btc.SigHash.ALL, appendType: SINGLE_ACP },
      ]) {
        const [a] = sigsFor(s, ['app'], opts);
        const [b] = sigsFor(s, ['hardware'], opts);
        const sigs = orderSigs(s.d, [['app', a], ['hardware', b]]);
        assertConsensusInvalid(verifyConsensus(rawOf(s, multisigWitness(sigs, s.d.witnessScript)), s.spent), [0]);
      }
    });

    it('only one signature carries the wrong type', () => {
      const s = setup();
      const [a] = sigsFor(s, ['app']);
      const [b] = sigsFor(s, ['hardware'], { digestType: btc.SigHash.ALL, appendType: NONE });
      const sigs = orderSigs(s.d, [['app', a], ['hardware', b]]);
      assertConsensusInvalid(verifyConsensus(rawOf(s, multisigWitness(sigs, s.d.witnessScript)), s.spent), [0]);
    });

    // Consensus accepts any sighash type that matches the signed digest, so a
    // SIGHASH_NONE spend is valid on-chain. Only our own checks keep it out of the wallet.
    it.each([
      ['NONE', NONE],
      ['SINGLE | ANYONECANPAY', SINGLE_ACP],
    ])('a correctly signed %s spend is valid for Bitcoin Core, so analyzePsbt must refuse it', (_n, type) => {
      const s = setup();
      const sigs = sigsFor(s, ['app', 'hardware'], { digestType: type });
      assertConsensusValid(verifyConsensus(rawOf(s, multisigWitness(sigs, s.d.witnessScript)), s.spent));

      const psbtTx = parsePsbt(s.plan.psbt);
      psbtTx.updateInput(0, {
        sighashType: type,
        partialSig: sigsFor(s, ['app'], { digestType: type }).map((sig) => [s.d.pubkeys.app, sig] as [Uint8Array, Uint8Array]),
      });
      const err = (() => {
        try {
          analyzePsbt(psbtTx.toPSBT(), wallet.accountPubkeys(), network);
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(PsbtError);
      expect((err as PsbtError).code).toBe('bad_sighash_type');
    });
  });

  describe('a tampered output after signing', () => {
    async function signedTx(pair: [Role, Role] = ['app', 'hardware']) {
      const plan = buildSpend({
        wallet,
        utxos: [fund(wallet, RECEIVE, 0, 70_000n), fund(wallet, CHANGE, 5, 70_000n)],
        recipients: [{ address: dest, amount: 100_000n }],
        feeRate: 2,
        changeIndex: 0,
      });
      const signed = await signWith(ctx, pair, plan.psbt);
      const { txHex } = finalizePsbt(signed);
      const spent = spentOutputsOfPsbt(signed);
      assertConsensusValid(verifyConsensus(txHex, spent)); // control: untampered passes
      return { raw: btc.RawTx.decode(hex.decode(txHex)), spent };
    }
    const encode = (raw: unknown) => hex.encode(btc.RawTx.encode(raw as Parameters<typeof btc.RawTx.encode>[0]));

    it('a recipient amount raised', async () => {
      const { raw, spent } = await signedTx();
      raw.outputs[0].amount += 1n;
      assertConsensusInvalid(verifyConsensus(encode(raw), spent));
    });

    it('a recipient address replaced (the attacker redirects the payment)', async () => {
      const { raw, spent } = await signedTx();
      raw.outputs[0].script = btc.OutScript.encode(
        btc.Address(network.btc).decode(btc.p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(9), true), network.btc).address!),
      );
      assertConsensusInvalid(verifyConsensus(encode(raw), spent), [0, 1]);
    });

    it('the change output lowered (value diverted to the miner)', async () => {
      const { raw, spent } = await signedTx();
      raw.outputs[1].amount -= 1_000n;
      assertConsensusInvalid(verifyConsensus(encode(raw), spent), [0, 1]);
    });

    it('an output added or removed', async () => {
      const { raw, spent } = await signedTx();
      const extra = { ...raw.outputs[0], amount: 500n };
      assertConsensusInvalid(verifyConsensus(encode({ ...raw, outputs: [...raw.outputs, extra] }), spent), [0, 1]);
      assertConsensusInvalid(verifyConsensus(encode({ ...raw, outputs: raw.outputs.slice(0, 1) }), spent), [0, 1]);
    });

    it('nLockTime changed', async () => {
      const { raw, spent } = await signedTx();
      assertConsensusInvalid(verifyConsensus(encode({ ...raw, lockTime: 1 }), spent), [0, 1]);
    });

    it('an input outpoint swapped (signatures commit to every outpoint)', async () => {
      const { raw, spent } = await signedTx();
      raw.inputs[1].index += 1;
      assertConsensusInvalid(verifyConsensus(encode(raw), spent), [0, 1]);
    });
  });

  describe('a witness script for a different wallet', () => {
    it('another wallet’s witness script (with its own valid signatures) cannot spend our output', async () => {
      const stranger = await makeCtx({ cosignerSeed: 21 });
      const ours = setup();
      const theirs = stranger.wallet.derive(RECEIVE, INDEX);
      expect(hex.encode(theirs.witnessScript)).not.toBe(hex.encode(ours.d.witnessScript));
      const sigs = orderSigs(theirs, (['app', 'hardware'] as Role[]).map((r) => [r, ecdsaSignature(childKey(stranger, r, theirs), ours.tx, 0, theirs.witnessScript, AMOUNT)] as [Role, Uint8Array]));
      const raw = rawOf(ours, multisigWitness(sigs, theirs.witnessScript));
      assertConsensusInvalid(verifyConsensus(raw, ours.spent), [0]);
    });

    it('our witness script from another address index', () => {
      const s = setup();
      const other = wallet.derive(RECEIVE, INDEX + 1);
      const sigs = orderSigs(other, (['app', 'hardware'] as Role[]).map((r) => [r, ecdsaSignature(childKey(ctx, r, other), s.tx, 0, other.witnessScript, AMOUNT)] as [Role, Uint8Array]));
      assertConsensusInvalid(verifyConsensus(rawOf(s, multisigWitness(sigs, other.witnessScript)), s.spent), [0]);
    });

    it('the right witness script, but the output being spent belongs to another wallet', async () => {
      const s = setup();
      const stranger = await makeCtx({ cosignerSeed: 21 });
      const foreignSpk = stranger.wallet.derive(RECEIVE, INDEX).script;
      const raw = rawOf(s, multisigWitness(sigsFor(s, ['app', 'hardware']), s.d.witnessScript));
      assertConsensusValid(verifyConsensus(raw, s.spent));
      assertConsensusInvalid(verifyConsensus(raw, [{ script: foreignSpk, amount: AMOUNT }]), [0]);
    });
  });

  describe('witness structure our finalizer must get right', () => {
    it('signatures in the wrong order (CHECKMULTISIG needs script order)', () => {
      const s = setup();
      const sigs = sigsFor(s, ['app', 'hardware']);
      assertConsensusValid(verifyConsensus(rawOf(s, multisigWitness(sigs, s.d.witnessScript)), s.spent));
      assertConsensusInvalid(verifyConsensus(rawOf(s, multisigWitness([...sigs].reverse(), s.d.witnessScript)), s.spent), [0]);
    });

    it('a non-empty CHECKMULTISIG dummy (NULLDUMMY)', () => {
      const s = setup();
      const sigs = sigsFor(s, ['app', 'hardware']);
      const raw = rawOf(s, multisigWitness(sigs, s.d.witnessScript, new Uint8Array([1])));
      assertConsensusInvalid(verifyConsensus(raw, s.spent), [0]);
    });

    it('a missing witness', () => {
      const s = setup();
      const raw = rawOf(s, multisigWitness(sigsFor(s, ['app', 'hardware']), s.d.witnessScript));
      const decoded = btc.RawTx.decode(hex.decode(raw));
      const stripped = hex.encode(btc.RawTx.encode({ ...decoded, segwitFlag: false, witnesses: undefined }));
      assertConsensusInvalid(verifyConsensus(stripped, s.spent), [0]);
    });
  });

  it('only the bad input fails when a multi-input spend has one bad signature', async () => {
    const plan = buildSpend({
      wallet,
      utxos: [fund(wallet, RECEIVE, 0, 70_000n), fund(wallet, CHANGE, 1, 70_000n), fund(wallet, RECEIVE, 2, 70_000n)],
      recipients: [{ address: dest, amount: 150_000n }],
      feeRate: 2,
      changeIndex: 0,
    });
    const signed = await signWith(ctx, ['app', 'cosigner'], plan.psbt);
    const { txHex } = finalizePsbt(signed);
    const spent = spentOutputsOfPsbt(signed);
    assertConsensusValid(verifyConsensus(txHex, spent));
    const raw = btc.RawTx.decode(hex.decode(txHex));
    const sigs = raw.witnesses![1];
    sigs[1] = new Uint8Array([...sigs[1]].map((b, i) => (i === 10 ? b ^ 1 : b)));
    assertConsensusInvalid(verifyConsensus(hex.encode(btc.RawTx.encode(raw)), spent), [1]);
  });

  it('the cosigner signing alone is not enough (guardian-only spend)', async () => {
    const s = setup();
    const signed = signAsCosigner(ctx, s.plan.psbt);
    expect(() => finalizePsbt(signed)).toThrow();
  });
});

describeConsensus('consensus: taproot (BIP 341 key path, TAPROOT flag)', () => {
  // Throwaway keys: an internal key and a P2WPKH key, fixed bytes on regtest.
  const internal = new Uint8Array(32).fill(41);
  const p2tr = btc.p2tr(secp256k1.getPublicKey(internal, true).slice(1), undefined, network.btc);
  const wpkhKey = new Uint8Array(32).fill(42);
  const p2wpkh = btc.p2wpkh(secp256k1.getPublicKey(wpkhKey, true), network.btc);
  const TAPROOT = { flags: ['ALL'] } as const;
  const SPLIT = { flags: ['ALL_PRE_TAPROOT', 'TAPROOT'] } as const;

  function prev(script: Uint8Array, amount: bigint, seed: number) {
    const raw = btc.RawTx.encode({
      version: 2,
      segwitFlag: false,
      inputs: [{ txid: sha256(Uint8Array.of(seed, 0x7a)), index: 0, finalScriptSig: new Uint8Array([0x51]), sequence: 0xffffffff }],
      outputs: [{ script, amount }],
      lockTime: 0,
    });
    return { txid: hex.encode(sha256(sha256(raw)).reverse()), amount, script };
  }

  /** A key-path spend of a P2TR coin (plus, optionally, a P2WPKH coin), signed with SIGHASH_DEFAULT. */
  function spend(withSecond: boolean) {
    const a = prev(p2tr.script, 50_000n, 1);
    const b = prev(p2wpkh.script, 30_000n, 2);
    const tx = new btc.Transaction(TX_OPTS);
    tx.addInput({ txid: a.txid, index: 0, sequence: SEQUENCE_RBF, witnessUtxo: { script: a.script, amount: a.amount }, tapInternalKey: p2tr.tapInternalKey });
    if (withSecond) tx.addInput({ txid: b.txid, index: 0, sequence: SEQUENCE_RBF, witnessUtxo: { script: b.script, amount: b.amount } });
    tx.addOutput({ script: btc.OutScript.encode(btc.Address(network.btc).decode(dest)), amount: withSecond ? 79_000n : 49_000n });
    tx.signIdx(internal, 0);
    if (withSecond) tx.signIdx(wpkhKey, 1);
    tx.finalize();
    const spent = [{ script: a.script, amount: a.amount }, ...(withSecond ? [{ script: b.script, amount: b.amount }] : [])];
    return { txHex: hex.encode(tx.extract()), spent };
  }

  const flipSig = (txHex: string) => {
    const raw = btc.RawTx.decode(hex.decode(txHex));
    const w = raw.witnesses![0]!;
    expect(w).toHaveLength(1); // key path: one 64-byte Schnorr signature (SIGHASH_DEFAULT)
    expect(w[0]!.length).toBe(64);
    w[0] = w[0]!.map((x, i) => (i === 10 ? x ^ 1 : x));
    return hex.encode(btc.RawTx.encode(raw));
  };

  it('a valid key-path spend verifies with TAPROOT', () => {
    const s = spend(false);
    assertConsensusValid(verifyConsensus(s.txHex, s.spent, { flags: [...TAPROOT.flags] }));
    assertConsensusValid(verifyConsensus(s.txHex, s.spent, { flags: [...SPLIT.flags] }));
  });

  it('a tampered signature fails with TAPROOT, and only TAPROOT catches it', () => {
    const s = spend(false);
    const bad = flipSig(s.txHex);
    assertConsensusInvalid(verifyConsensus(bad, s.spent, { flags: [...TAPROOT.flags] }), [0]);
    // Before taproot, witness v1 outputs are anyone-can-spend: the default flags accept the forgery.
    assertConsensusValid(verifyConsensus(bad, s.spent));
  });

  it('the signature commits to every spent output: a wrong amount for the OTHER input fails the taproot input', () => {
    const s = spend(true);
    assertConsensusValid(verifyConsensus(s.txHex, s.spent, { flags: [...TAPROOT.flags] }));
    const lied = [s.spent[0]!, { ...s.spent[1]!, amount: 30_001n }];
    // Input 1 (segwit v0) commits to its own amount and fails too; input 0 fails only through BIP 341's
    // commitment to every spent amount.
    assertConsensusInvalid(verifyConsensus(s.txHex, lied, { flags: [...TAPROOT.flags] }), [0, 1]);
    assertConsensusInvalid(verifyConsensus(flipSig(s.txHex), s.spent, { flags: [...TAPROOT.flags] }), [0]);
  });
});
