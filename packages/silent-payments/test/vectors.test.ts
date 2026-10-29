/**
 * Every case of BIP 352's official `send_and_receive_test_vectors.json` (see `vectors/SOURCE`), checked the way the
 * BIP's `reference.py` checks them: the sender's eligible input keys, private key sum, shared secrets and output
 * set; the receiver's addresses, input key sum, tweak, shared secret, found outputs, tweaks and BIP 340
 * signatures.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  SilentPaymentError,
  bytesToHex,
  changeAddress,
  computeTweak,
  createOutputs,
  hexToBytes,
  labelTable,
  parseSerializedWitness,
  receiverAddress,
  receiverSharedSecret,
  scanOutputs,
  senderSharedSecret,
  spendingPrivateKey,
  summarizeSenderInputs,
  type SenderInput,
  type TxInput,
} from '../src/index.js';

interface VectorVin {
  txid: string;
  vout: number;
  scriptSig: string;
  txinwitness: string;
  prevout: { scriptPubKey: { hex: string } };
  private_key?: string;
}

interface Vector {
  comment: string;
  sending: {
    given: { vin: VectorVin[]; recipients: { address: string; scan_pub_key: string; spend_pub_key: string; count?: number }[] };
    expected: { outputs: string[][]; shared_secrets?: (string | null)[]; input_private_key_sum?: string; input_pub_keys: string[] };
  }[];
  receiving: {
    given: { vin: VectorVin[]; outputs: string[]; key_material: { scan_priv_key: string; spend_priv_key: string }; labels: number[] };
    expected: {
      addresses: string[];
      outputs?: { priv_key_tweak: string; pub_key: string; signature: string }[];
      n_outputs?: number;
      tweak?: string | null;
      shared_secret?: string | null;
      input_pub_key_sum?: string;
    };
  }[];
}

const vectors: Vector[] = JSON.parse(readFileSync(new URL('./vectors/send_and_receive_test_vectors.json', import.meta.url), 'utf8'));

const toInput = (v: VectorVin): TxInput => ({
  txid: v.txid,
  vout: v.vout,
  prevoutScript: hexToBytes(v.prevout.scriptPubKey.hex),
  scriptSig: hexToBytes(v.scriptSig),
  witness: parseSerializedWitness(v.txinwitness),
});

const sameSet = (a: string[], b: string[]) => a.length === b.length && new Set(a).size === new Set([...a, ...b]).size;

const MSG = sha256(new TextEncoder().encode('message'));
const AUX = sha256(new TextEncoder().encode('random auxiliary data'));

describe('BIP 352 test vectors', () => {
  it('has every case of the official file', () => {
    expect(vectors.length).toBe(29);
  });

  describe.each(vectors.map((v, i) => [`${i}: ${v.comment}`, v] as const))('%s', (_name, v) => {
    it('sending', { timeout: 120_000 }, () => {
      for (const s of v.sending) {
        const inputs: SenderInput[] = s.given.vin.map((vin) => ({ ...toInput(vin), privateKey: hexToBytes(vin.private_key!) }));
        const recipients = s.given.recipients.flatMap((r) => Array<string>(r.count ?? 1).fill(r.address));
        const expectedOutputs = s.expected.outputs;
        const empty = expectedOutputs.length === 1 && expectedOutputs[0]!.length === 0;

        // The keys the receiver will count, in input order.
        let summary: ReturnType<typeof summarizeSenderInputs> | undefined;
        try {
          summary = summarizeSenderInputs(inputs);
        } catch (e) {
          expect(e).toBeInstanceOf(SilentPaymentError);
          expect(['no_eligible_inputs', 'zero_sum']).toContain((e as SilentPaymentError).code);
        }
        if (summary) {
          expect(summary.eligible.map((e) => bytesToHex(e.publicKey.toBytes(true)))).toEqual(s.expected.input_pub_keys);
          if (s.expected.input_private_key_sum) expect(summary.privateKeySum.toString(16).padStart(64, '0')).toBe(s.expected.input_private_key_sum);
        } else {
          // No eligible input, or a zero sum.
          expect(empty).toBe(true);
        }

        let outputs: string[] = [];
        try {
          const r = createOutputs({ inputs, recipients, network: 'bitcoin' });
          outputs = r.outputs.map((o) => bytesToHex(o.outputKey));
          // Shared secrets per recipient (by scan key), as the vectors list them.
          s.given.recipients.forEach((rec, i) => {
            const want = s.expected.shared_secrets?.[i];
            if (want) expect(bytesToHex(senderSharedSecret(r, hexToBytes(rec.scan_pub_key)))).toBe(want);
          });
        } catch (e) {
          expect(e).toBeInstanceOf(SilentPaymentError);
          expect(['no_eligible_inputs', 'zero_sum', 'too_many_recipients']).toContain((e as SilentPaymentError).code);
          expect(empty).toBe(true);
        }
        expect(expectedOutputs.some((set) => sameSet(set, outputs))).toBe(true);
        // A sender that refuses produces nothing.
        if (empty) expect(outputs).toEqual([]);
      }
    });

    it('receiving', { timeout: 120_000 }, () => {
      for (const r of v.receiving) {
        const scanPrivateKey = hexToBytes(r.given.key_material.scan_priv_key);
        const spendPrivateKey = hexToBytes(r.given.key_material.spend_priv_key);
        const spendPublicKey = secp256k1.getPublicKey(spendPrivateKey, true);
        const keys = { scanPrivateKey, spendPublicKey };

        // The unlabeled address, then one per label, as the vectors list them. Label 0 (change) is never handed out,
        // so the change-labelled address has its own function.
        const addresses = [
          receiverAddress(keys, 'bitcoin'),
          ...r.given.labels.map((m) => (m === 0 ? changeAddress(keys, 'bitcoin') : receiverAddress(keys, 'bitcoin', { label: m }))),
        ];
        expect(addresses).toEqual(r.expected.addresses);

        const tweak = computeTweak({ inputs: r.given.vin.map(toInput) });
        if (!tweak) {
          // Not scannable: no eligible input, or keys summing to infinity.
          expect(r.expected.outputs ?? []).toEqual([]);
          expect(r.expected.tweak ?? null).toBeNull();
          continue;
        }
        expect(bytesToHex(tweak.inputPublicKeySum)).toBe(r.expected.input_pub_key_sum);
        expect(bytesToHex(tweak.tweak)).toBe(r.expected.tweak);
        expect(bytesToHex(receiverSharedSecret(scanPrivateKey, tweak.tweak))).toBe(r.expected.shared_secret);

        const matches = scanOutputs({
          scanPrivateKey,
          spendPublicKey,
          tweak: tweak.tweak,
          outputs: r.given.outputs.map(hexToBytes),
          // Exactly the labels the vector lists (the wallet always adds the change label on top).
          labels: labelTable(scanPrivateKey, r.given.labels, { includeChange: false }),
        });
        const found = matches.map((m) => {
          const d = spendingPrivateKey(spendPrivateKey, m.tweak);
          // The spending key controls the output key.
          expect(bytesToHex(schnorr.getPublicKey(d))).toBe(bytesToHex(m.outputKey));
          // Signatures only where the vector lists them (the K_max case lists a count of 2323 instead).
          if (!r.expected.outputs) return { priv_key_tweak: bytesToHex(m.tweak), pub_key: bytesToHex(m.outputKey), signature: '' };
          const signature = schnorr.sign(MSG, d, AUX);
          expect(schnorr.verify(signature, MSG, m.outputKey)).toBe(true);
          return { priv_key_tweak: bytesToHex(m.tweak), pub_key: bytesToHex(m.outputKey), signature: bytesToHex(signature) };
        });
        if (r.expected.outputs) {
          const key = (o: { priv_key_tweak: string; pub_key: string; signature: string }) => `${o.pub_key}/${o.priv_key_tweak}/${o.signature}`;
          expect(found.map(key).sort()).toEqual(r.expected.outputs.map(key).sort());
        } else {
          expect(found.length).toBe(r.expected.n_outputs);
        }
      }
    });
  });
});

