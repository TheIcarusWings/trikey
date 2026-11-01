/**
 * The optional Savings wallet, option K (docs/design/savings-and-limit-off.md): a plain
 * `wsh(sortedmulti(2, phone, hardware, recoveryKey))` whose keys all sit at BIP 48 account 1', and in which the guardian
 * holds no key. Checked here: the descriptor's shape, that Savings shares no key or address with Spending (account 0'),
 * that every pair of its own keys signs a spend (Bitcoin Core's verifier agrees), and that nothing else does: one key
 * alone, and the guardian, which is not in the script at all.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { NETWORKS, SAVINGS_ACCOUNT, bip48Path } from '../src/network.js';
import { SoftwareSigner } from '../src/signers.js';
import { CHANGE, MultisigWallet, RECEIVE, Role } from '../src/wallet.js';
import { PsbtError, analyzePsbt, buildSpend, buildSweep, combinePsbts, finalizePsbt, sighashAll } from '../src/psbt.js';
import { parseSortedMultiDescriptor } from '../src/descriptor.js';
import { MNEMONICS, fund, makeWallet } from './helpers.js';
import { assertConsensusValid, describeConsensus, spentOutputsOfPsbt, verifyConsensus } from './support/consensus.js';

const network = NETWORKS.regtest;
/** The second hardware wallet that is the Recovery Key: a published BIP 39 test vector. */
const RECOVERY_KEY = MNEMONICS.hardware2;
const dest = btc.p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(3), true), network.btc).address!;

const phone = new SoftwareSigner('app', MNEMONICS.app);
const hardware = new SoftwareSigner('hardware', MNEMONICS.hardware, 'fake hardware wallet');
const recoveryKey = new SoftwareSigner('cosigner', RECOVERY_KEY, 'fake second hardware wallet');
/** The guardian's seed: key 3 of Spending. It must be useless for Savings. */
const guardian = new SoftwareSigner('cosigner', MNEMONICS.cosigner, 'guardian');

const SIGNERS: Record<Role, SoftwareSigner> = { app: phone, hardware, cosigner: recoveryKey };
/** Every spend of Savings needs a key that is not online: never the phone alone, never the guardian. */
const PAIRS: [Role, Role][] = [
  ['app', 'hardware'], // phone + hardware wallet: the everyday way out of Savings
  ['app', 'cosigner'], // phone + Recovery Key: the hardware wallet and its seed words are lost
  ['hardware', 'cosigner'], // hardware wallet + Recovery Key: the phone is lost, no backup
];
const NAMES: Record<Role, string> = { app: 'phone', hardware: 'hardware wallet', cosigner: 'Recovery Key' };

async function savingsWallet(rk: SoftwareSigner = recoveryKey): Promise<MultisigWallet> {
  return new MultisigWallet(network, {
    app: await phone.getKey(network, SAVINGS_ACCOUNT),
    hardware: await hardware.getKey(network, SAVINGS_ACCOUNT),
    cosigner: await rk.getKey(network, SAVINGS_ACCOUNT),
  });
}

async function signWith(roles: Role[], psbt: Uint8Array): Promise<Uint8Array> {
  const parts = await Promise.all(roles.map((r) => SIGNERS[r].signPsbt(psbt, network)));
  return combinePsbts(parts);
}

describe('the Savings wallet (option K)', () => {
  let savings: MultisigWallet;
  let spending: MultisigWallet;
  beforeAll(async () => {
    savings = await savingsWallet();
    spending = (await makeWallet()).wallet;
  });

  it('is a plain 2-of-3 of three BIP 48 account-1 keys, as the design writes it', () => {
    expect(SAVINGS_ACCOUNT).toBe(1);
    expect(bip48Path(network, SAVINGS_ACCOUNT)).toBe("m/48'/1'/1'/2'");
    const desc = savings.descriptor();
    expect(desc).toMatch(/^wsh\(sortedmulti\(2,\[[0-9a-f]{8}\/48h\/1h\/1h\/2h\]tpub\w+\/<0;1>\/\*,\[[0-9a-f]{8}\/48h\/1h\/1h\/2h\]tpub\w+\/<0;1>\/\*,\[[0-9a-f]{8}\/48h\/1h\/1h\/2h\]tpub\w+\/<0;1>\/\*\)\)#[a-z0-9]{8}$/);
    const keys = parseSortedMultiDescriptor(desc);
    expect(new Set(keys.map((k) => k.fingerprint)).size).toBe(3);
    // The descriptor alone rebuilds the wallet, byte for byte (other wallet software imports it as any multisig).
    const again = MultisigWallet.fromDescriptor(desc, network);
    expect(again.descriptor()).toBe(desc);
    expect(again.fingerprint()).toBe(savings.fingerprint());
    expect(again.derive(RECEIVE, 0).address).toBe(savings.derive(RECEIVE, 0).address);
  });

  it('on mainnet the paths say coin 0 and the keys are xpubs', async () => {
    const main = NETWORKS.bitcoin;
    const k = await phone.getKey(main, SAVINGS_ACCOUNT);
    expect(k.originPath).toBe('48h/0h/1h/2h');
    expect(k.xpub.startsWith('xpub')).toBe(true);
  });

  it('shares no key and no address with Spending (account 0)', async () => {
    const spendingKeys = Object.values(spending.keys).map((k) => k.xpub);
    for (const k of Object.values(savings.keys)) expect(spendingKeys).not.toContain(k.xpub);
    expect(savings.fingerprint()).not.toBe(spending.fingerprint());
    const spendingAddresses = new Set<string>();
    for (const chain of [RECEIVE, CHANGE]) for (let i = 0; i < 25; i++) spendingAddresses.add(spending.derive(chain, i).address);
    for (const chain of [RECEIVE, CHANGE]) for (let i = 0; i < 25; i++) expect(spendingAddresses.has(savings.derive(chain, i).address)).toBe(false);
    // The same phone seed and the same hardware wallet, at account 0, are Spending's keys: not Savings'.
    expect((await phone.getKey(network)).xpub).not.toBe(savings.keys.app.xpub);
    expect((await hardware.getKey(network)).xpub).not.toBe(savings.keys.hardware.xpub);
  });

  for (const pair of PAIRS) {
    it(`the ${NAMES[pair[0]]} and the ${NAMES[pair[1]]} spend it`, async () => {
      const u = fund(savings, RECEIVE, 0, 300_000n);
      const plan = buildSpend({ wallet: savings, utxos: [u], recipients: [{ address: dest, amount: 120_000n }], feeRate: 2, changeIndex: 0 });
      const signed = await signWith(pair, plan.psbt);
      const a = analyzePsbt(signed, savings.accountPubkeys(), network, { requireNonWitnessUtxo: true });
      expect(a.inputs[0]!.signedBy.sort()).toEqual([...pair].sort());
      expect(a.externalOut).toBe(120_000n);
      expect(() => finalizePsbt(signed)).not.toThrow();
    });
  }

  it('one key alone never spends it, the phone included', async () => {
    const u = fund(savings, RECEIVE, 1, 200_000n);
    const plan = buildSpend({ wallet: savings, utxos: [u], recipients: [{ address: dest, amount: 50_000n }], feeRate: 2, changeIndex: 0 });
    for (const role of ['app', 'hardware', 'cosigner'] as Role[]) {
      const one = await SIGNERS[role].signPsbt(plan.psbt, network);
      expect(() => finalizePsbt(one), NAMES[role]).toThrow();
    }
  });

  it('the guardian holds no Savings key: it signs nothing, and a signature by its key is refused', async () => {
    const u = fund(savings, RECEIVE, 2, 200_000n);
    const plan = buildSpend({ wallet: savings, utxos: [u], recipients: [{ address: dest, amount: 50_000n }], feeRate: 2, changeIndex: 0 });
    // Its seed's fingerprint is in no input's derivations: there is nothing for it to sign.
    await expect(guardian.signPsbt(plan.psbt, network)).rejects.toThrow(/no inputs/i);
    // A signature by a key that is not one of the three (say, key 3 at either account) is an unknown signer.
    // The device would refuse to sign with a key that is not in the script, so the signature is made by hand.
    const g = guardian.master(network).derive(`${bip48Path(network, SAVINGS_ACCOUNT)}/0/2`);
    const withPhone = await phone.signPsbt(plan.psbt, network);
    const tx = btc.Transaction.fromPSBT(plan.psbt);
    const d = savings.derive(RECEIVE, 2);
    const msg = sighashAll(tx, 0, d.witnessScript, 200_000n);
    const der = secp256k1.sign(msg, g.privateKey!, { prehash: false, format: 'der' });
    tx.updateInput(0, { partialSig: [[g.publicKey!, Uint8Array.from([...der, btc.SigHash.ALL])]] }, true);
    const mixed = combinePsbts([withPhone, tx.toPSBT()]);
    let refused: unknown;
    try {
      analyzePsbt(mixed, savings.accountPubkeys(), network);
    } catch (e) {
      refused = e;
    }
    expect(refused).toBeInstanceOf(PsbtError);
    expect((refused as PsbtError).code).toBe('unknown_signer');
    // And the phone + guardian pair, the one the daily limit trusts in Spending, cannot finalize a Savings spend.
    expect(() => finalizePsbt(mixed)).toThrow();
  });

  it('a Savings spend is not a Spending spend: the guardian\'s analysis of Spending refuses its inputs', async () => {
    const u = fund(savings, RECEIVE, 3, 200_000n);
    const plan = buildSpend({ wallet: savings, utxos: [u], recipients: [{ address: dest, amount: 50_000n }], feeRate: 2, changeIndex: 0 });
    expect(() => analyzePsbt(plan.psbt, spending.accountPubkeys(), network)).toThrow(PsbtError);
  });

  it('a move from Savings to Spending pays Spending like any outside payment (no change of Spending\'s)', async () => {
    const u = fund(savings, RECEIVE, 4, 400_000n);
    const to = spending.derive(RECEIVE, 7).address;
    const plan = buildSpend({ wallet: savings, utxos: [u], recipients: [{ address: to, amount: 150_000n }], feeRate: 2, changeIndex: 1 });
    const a = analyzePsbt(plan.psbt, savings.accountPubkeys(), network);
    // Seen from Savings, the Spending address is outgoing; the change goes back to Savings' own change chain.
    expect(a.externalOut).toBe(150_000n);
    expect(a.outputs.filter((o) => o.isSelf)).toHaveLength(1);
  });

  it('replacing a lost key sweeps everything to a new Savings wallet that keeps the two surviving keys', async () => {
    // The Recovery Key was lost: the phone and the hardware wallet move everything to a Savings with a new one.
    const newRk = new SoftwareSigner('cosigner', 'vessel ladder alter error federal sibling chat ability sun glass valve picture', 'new second hardware wallet');
    const next = await savingsWallet(newRk);
    expect(next.keys.app.xpub).toBe(savings.keys.app.xpub);
    expect(next.keys.hardware.xpub).toBe(savings.keys.hardware.xpub);
    expect(next.fingerprint()).not.toBe(savings.fingerprint());
    const coins = [fund(savings, RECEIVE, 5, 100_000n), fund(savings, CHANGE, 0, 80_000n)];
    const plan = buildSweep({ from: savings, utxos: coins, destination: next, destinationIndex: 0, feeRate: 2 });
    const signed = await signWith(['app', 'hardware'], plan.psbt);
    const a = analyzePsbt(signed, savings.accountPubkeys(), network, { outputsAcct: next.accountPubkeys() });
    expect(a.externalOut).toBe(0n);
    expect(a.selfOut).toBe(180_000n - plan.fee);
    expect(() => finalizePsbt(signed)).not.toThrow();
  });
});

describeConsensus('consensus: Savings spends', () => {
  let savings: MultisigWallet;
  beforeAll(async () => {
    savings = await savingsWallet();
  });

  for (const pair of PAIRS) {
    it(`${NAMES[pair[0]]} + ${NAMES[pair[1]]}: valid under Bitcoin Core's script rules`, async () => {
      const coins = [fund(savings, RECEIVE, 10, 250_000n), fund(savings, CHANGE, 3, 90_000n)];
      const plan = buildSpend({ wallet: savings, utxos: coins, recipients: [{ address: dest, amount: 300_000n }], feeRate: 3, changeIndex: 4 });
      const signed = await signWith(pair, plan.psbt);
      const { txHex } = finalizePsbt(signed);
      assertConsensusValid(verifyConsensus(txHex, spentOutputsOfPsbt(signed)));
    });
  }

  it('a sweep to a new Savings wallet (hardware wallet + Recovery Key, the phone lost): valid', async () => {
    const newPhone = new SoftwareSigner('app', 'vessel ladder alter error federal sibling chat ability sun glass valve picture');
    const next = new MultisigWallet(network, {
      app: await newPhone.getKey(network, SAVINGS_ACCOUNT),
      hardware: savings.keys.hardware,
      cosigner: savings.keys.cosigner,
    });
    const coins = [fund(savings, RECEIVE, 11, 120_000n), fund(savings, RECEIVE, 12, 60_000n)];
    const plan = buildSweep({ from: savings, utxos: coins, destination: next, destinationIndex: 0, feeRate: 2 });
    const signed = await signWith(['hardware', 'cosigner'], plan.psbt);
    const { txHex } = finalizePsbt(signed);
    assertConsensusValid(verifyConsensus(txHex, spentOutputsOfPsbt(signed)));
  });
});
