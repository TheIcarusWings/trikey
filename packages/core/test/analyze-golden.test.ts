/**
 * `analyzePsbt` with its default options, byte for byte: every analysis and every refusal of a fixed set
 * of PSBTs, recorded in test/fixtures/analyze-defaults.json before the helper-input option existed.
 * New options must not change a single byte of what the defaults return. Regenerate (only for a
 * deliberate change of the default behaviour) with `UPDATE_GOLDEN=1`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { CHANGE, RECEIVE, TX_OPTS } from '../src/wallet.js';
import { PsbtError, analyzePsbt, parsePsbt } from '../src/psbt.js';
import { makeCtx, network, signAs, signWith } from './support/signing.js';
import { fundFixed, fundScriptFixed, helperKey, mixedPsbt, p2trScript, p2wpkhScript, signAndFinalizeHelper } from './support/fixed.js';

const FIXTURE = new URL('./fixtures/analyze-defaults.json', import.meta.url);

/** JSON with bigints as "123n" and bytes as hex, so the fixture shows every field exactly. */
function serialize(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x instanceof Uint8Array ? hex.encode(x) : x)));
}

function outcome(f: () => unknown): unknown {
  try {
    return { ok: serialize(f()) };
  } catch (e) {
    if (!(e instanceof PsbtError)) return { thrown: (e as Error).message };
    return { error: { code: e.code, input: e.input ?? null, message: e.message } };
  }
}

async function cases(): Promise<Record<string, unknown>> {
  const ctx = await makeCtx();
  const other = (await makeCtx({ cosignerSeed: 11 })).wallet;
  const w = ctx.wallet;
  const acct = w.accountPubkeys();
  const a = fundFixed(w, RECEIVE, 0, 200_000n, 1);
  const b = fundFixed(w, CHANGE, 3, 90_000n, 2);
  const ext = p2wpkhScript();
  const spend = mixedPsbt(w, [{ kind: 'vault', utxo: a }, { kind: 'vault', utxo: b }], [
    { script: ext, amount: 150_000n },
    { self: { chain: CHANGE, index: 4 }, amount: 139_000n },
  ]);
  const phoneSigned = await signAs(ctx, 'app', spend);
  const both = await signWith(ctx, ['app', 'hardware'], spend);
  const sweep = mixedPsbt(w, [{ kind: 'vault', utxo: a }], [{ script: other.derive(RECEIVE, 0).script, amount: 199_000n }]);
  const toTaproot = await signAs(
    ctx,
    'app',
    mixedPsbt(w, [{ kind: 'vault', utxo: a }], [
      { script: p2trScript(), amount: 30_000n },
      { self: { chain: CHANGE, index: 5 }, amount: 169_000n },
    ]),
  );

  // A finalized single-key P2WPKH input next to the vault's (what a silent payment PSBT carries).
  const h = helperKey();
  const coin = fundScriptFixed(h.script, 20_000n, 9);
  const mixed = signAndFinalizeHelper(
    await signAs(
      ctx,
      'app',
      mixedPsbt(w, [{ kind: 'vault', utxo: a }, { kind: 'helper', coin, script: h.script }], [
        { script: p2trScript(), amount: 30_000n },
        { self: { chain: CHANGE, index: 6 }, amount: 168_000n },
        { script: h.script, amount: 19_500n },
      ]),
    ),
    1,
    h.priv,
  );

  const noPrev = mixedPsbt(w, [{ kind: 'vault', utxo: { ...a, prevTxHex: undefined } }], [{ script: ext, amount: 100_000n }]);
  // scure refuses to build it, so the previous transaction is swapped in the bytes (same length).
  const wrongPrev = hex.decode(hex.encode(mixedPsbt(w, [{ kind: 'vault', utxo: a }], [{ script: ext, amount: 100_000n }])).replace(a.prevTxHex!, b.prevTxHex!));
  const tampered = (() => {
    const [pub, sig] = btc.Transaction.fromPSBT(phoneSigned, TX_OPTS).getInput(0).partialSig![0]!;
    const bad = sig.slice();
    bad[10] ^= 1;
    const tx = btc.Transaction.fromPSBT(spend, TX_OPTS);
    tx.updateInput(0, { partialSig: [[pub, bad]] }, true);
    return tx.toPSBT();
  })();
  const overspend = mixedPsbt(w, [{ kind: 'vault', utxo: a }], [{ script: ext, amount: 200_001n }]);
  const single = (() => {
    const tx = btc.Transaction.fromPSBT(spend, TX_OPTS);
    tx.updateInput(0, { sighashType: btc.SigHash.SINGLE }, true);
    return tx.toPSBT();
  })();

  const req = { requireNonWitnessUtxo: true };
  return {
    phoneSigned: outcome(() => analyzePsbt(phoneSigned, acct, network, req)),
    phoneAndHardware: outcome(() => analyzePsbt(both, acct, network)),
    unsigned: outcome(() => analyzePsbt(spend, acct, network, req)),
    sweepToOther: outcome(() => analyzePsbt(sweep, acct, network, { ...req, outputsAcct: other.accountPubkeys() })),
    sweepAsSelf: outcome(() => analyzePsbt(sweep, acct, network)),
    toTaproot: outcome(() => analyzePsbt(toTaproot, acct, network, req)),
    helperInput: outcome(() => analyzePsbt(mixed, acct, network, req)),
    helperInputNoRequire: outcome(() => analyzePsbt(mixed, acct, network)),
    otherWallet: outcome(() => analyzePsbt(spend, other.accountPubkeys(), network)),
    missingNonWitnessUtxo: outcome(() => analyzePsbt(noPrev, acct, network, req)),
    wrongNonWitnessUtxo: outcome(() => analyzePsbt(wrongPrev, acct, network)),
    tamperedSignature: outcome(() => analyzePsbt(tampered, acct, network)),
    outputsExceedInputs: outcome(() => analyzePsbt(overspend, acct, network)),
    sighashSingle: outcome(() => analyzePsbt(single, acct, network)),
    psbts: { spend: hex.encode(spend), phoneSigned: hex.encode(phoneSigned), mixed: hex.encode(mixed), txid: parsePsbt(spend).id },
  };
}

describe('analyzePsbt defaults (golden)', () => {
  it('returns exactly what it returned before the helper-input option', async () => {
    const got = await cases();
    if (process.env.UPDATE_GOLDEN) writeFileSync(FIXTURE, `${JSON.stringify(got, null, 2)}\n`);
    const want = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    expect(JSON.stringify(got, null, 2)).toBe(JSON.stringify(want, null, 2));
  });
});
