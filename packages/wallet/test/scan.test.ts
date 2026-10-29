/** `parseScannedCode`: every kind of code the app's cameras read. Throwaway keys only. */
import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { base64, hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { npubEncode } from 'nostr-tools/nip19';
import { NETWORKS } from '@trikey/core';
import { encodePairingUri, encodeRecoveryUri } from '@trikey/protocol';
import { parseScannedCode } from '../src/index.js';

const NOW = 1_800_000_000;
const pub = hex.encode(secp256k1.getPublicKey(new Uint8Array(32).fill(9), true).slice(1));
const relays = ['wss://relay.example.com'];
const pairing = encodePairingUri({ guardianPubkey: pub, relays, secret: 'a'.repeat(43), expiresAt: NOW + 300, label: 'Umbrel' }, NOW);
const recovery = encodeRecoveryUri({ guardianPubkey: pub, relays, network: 'signet', label: 'Umbrel' });
const key = secp256k1.getPublicKey(new Uint8Array(32).fill(3), true);
const tb = btc.p2wpkh(key, NETWORKS.testnet.btc).address!;
const bcrt = btc.p2wpkh(key, NETWORKS.regtest.btc).address!;
const bc = btc.p2wpkh(key, NETWORKS.bitcoin.btc).address!;

describe('parseScannedCode', () => {
  it('tells a pairing code from a recovery code', () => {
    expect(parseScannedCode(pairing, { now: NOW })).toEqual({ kind: 'pairing', uri: pairing, guardianNpub: npubEncode(pub), relays, label: 'Umbrel', expiresAt: NOW + 300 });
    expect(parseScannedCode(` ${recovery}\n`, { network: 'signet' })).toEqual({
      kind: 'recovery',
      uri: recovery,
      guardian: { npub: npubEncode(pub), relays },
      network: 'signet',
      label: 'Umbrel',
    });
  });

  it('explains a code it cannot use: expired, another network, damaged', () => {
    expect(parseScannedCode(pairing, { now: NOW + 301 })).toMatchObject({ kind: 'unknown', reason: expect.stringMatching(/expired/) });
    expect(parseScannedCode(recovery, { network: 'testnet' })).toMatchObject({ kind: 'unknown', reason: expect.stringMatching(/signet.*testnet/) });
    expect(parseScannedCode('trikey://pair?v=1&npub=nope', { now: NOW })).toMatchObject({ kind: 'unknown', reason: expect.stringMatching(/can't be read/) });
    expect(parseScannedCode(`${recovery}&secret=${'a'.repeat(43)}`)).toMatchObject({ kind: 'unknown' });
    expect(parseScannedCode('')).toMatchObject({ kind: 'unknown' });
    expect(parseScannedCode('hello world')).toMatchObject({ kind: 'unknown', reason: expect.stringMatching(/isn't a Trikey code/) });
  });

  it('reads addresses and BIP 21 payment links, exactly, on the right network', () => {
    expect(parseScannedCode(bcrt, { network: 'regtest' })).toEqual({ kind: 'address', address: bcrt, network: 'regtest' });
    expect(parseScannedCode(tb.toUpperCase(), { network: 'testnet' })).toEqual({ kind: 'address', address: tb, network: 'testnet' });
    expect(parseScannedCode(`BITCOIN:${tb.toUpperCase()}?amount=0.00150001&label=Coffee%20shop&message=Thanks`, { network: 'signet' })).toEqual({
      kind: 'address',
      address: tb,
      network: 'signet',
      amountSats: 150_001,
      label: 'Coffee shop',
      message: 'Thanks',
    });
    expect(parseScannedCode(`bitcoin:${bc}?amount=21`)).toMatchObject({ kind: 'address', network: 'bitcoin', amountSats: 2_100_000_000 });
    expect(parseScannedCode(bc, { network: 'testnet' })).toMatchObject({ kind: 'unknown', reason: expect.stringMatching(/mainnet address.*testnet/) });
    expect(parseScannedCode(`bitcoin:${tb}?amount=0.1.2`, { network: 'testnet' })).toMatchObject({ kind: 'unknown', reason: expect.stringMatching(/amount/) });
    expect(parseScannedCode(`bitcoin:${tb}?req-pop=1`, { network: 'testnet' })).toMatchObject({ kind: 'unknown' });
    expect(parseScannedCode('bitcoin:notanaddress')).toMatchObject({ kind: 'unknown', reason: expect.stringMatching(/no valid bitcoin address/) });
  });

  it('reads a PSBT in base64 or hex, and a nostr key', () => {
    const tx = new btc.Transaction();
    tx.addInput({ txid: new Uint8Array(32).fill(1), index: 0 });
    tx.addOutputAddress(tb, 1000n, NETWORKS.testnet.btc);
    const psbt = tx.toPSBT();
    expect(parseScannedCode(base64.encode(psbt))).toEqual({ kind: 'psbt', psbtBase64: base64.encode(psbt) });
    expect(parseScannedCode(hex.encode(psbt).toUpperCase())).toEqual({ kind: 'psbt', psbtBase64: base64.encode(psbt) });
    expect(parseScannedCode(`nostr:${npubEncode(pub)}`)).toEqual({ kind: 'contact', npub: npubEncode(pub), pubkey: pub });
    expect(parseScannedCode(`${npubEncode(pub).slice(0, -1)}x`)).toMatchObject({ kind: 'unknown', reason: expect.stringMatching(/typo/) });
  });
});
