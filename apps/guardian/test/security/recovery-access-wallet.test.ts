/**
 * Security review 2026-10, finding 10c (LOW/INFO): `recovery.access` approvals were not bound to a
 * wallet. The signed text named the guardian's and the phone's nostr keys only, so a grant that a
 * rotation or retirement revoked could be obtained again, on the next wallet with the same hardware
 * authorization key, with the very same signature.
 *
 * Now the text has a version 2 naming the wallet id (the guardian's recovery code carries the id; a
 * renewing phone knows it), and a version-1 signature whose grant was revoked stays refused until it
 * expires, whatever its encoding.
 */
import { describe, expect, it } from 'vitest';
import { base64, hex } from '@scure/base';
import { schnorr } from '@noble/curves/secp256k1.js';
import { decodeRecoveryUri, encodeRecoveryUri, recoveryAccessMessage as protocolMessage } from '@trikey/protocol';
import { pairingMessage, recoveryAccessMessage, signMessage } from '../../src/policy/index.js';
import { APP_NOSTR, AUTH_PATH, DEFAULT_RULES, MNEMONICS, approve, hwAuthPrivateKey, hwAuthPubkey, makeWallet, nostrKey, setup, type Ctx } from '../helpers.js';

const GUARDIAN = hex.encode(schnorr.getPublicKey(new Uint8Array(32).fill(31)));
const PHONE = nostrKey(41);

function access(ctx: Ctx, opts: { walletId?: string; expiresInSec?: number } = {}) {
  const expiresAt = Math.floor(ctx.clock.now() / 1000) + (opts.expiresInSec ?? 3600);
  const text = recoveryAccessMessage({ guardianPubkey: GUARDIAN, phonePubkey: PHONE, expiresAt, ...(opts.walletId ? { walletId: opts.walletId } : {}) });
  return { kind: 'bip137', expiresAt, signature: signMessage(text, hwAuthPrivateKey()) };
}

const grant = (ctx: Ctx, approval: ReturnType<typeof access>) => ctx.engine.grantRecoveryAccess({ phonePubkey: PHONE, guardianPubkey: GUARDIAN, approval });

/** After `wallet.retire`, the same keys' hardware pairs a new wallet (same authorization key). */
async function retireAndRepair(ctx: Ctx): Promise<string> {
  expect((await ctx.engine.retireWallet(approve(ctx, { action: 'retire-wallet' }, 1))).ok).toBe(true);
  const next = await makeWallet({ app: MNEMONICS.app2 });
  const cosigner = hex.encode(ctx.signer.accountPubkey);
  const reg = await ctx.engine.register({
    network: 'regtest',
    descriptor: next.descriptor(),
    cosignerAccountPubkey: cosigner,
    rules: DEFAULT_RULES,
    hardwareAuth: { kind: 'bip137', pubkey: hwAuthPubkey(), path: AUTH_PATH },
    hardwareAuthProof: signMessage(pairingMessage(next.fingerprint(), cosigner), hwAuthPrivateKey()),
    appNostrPubkey: APP_NOSTR,
  });
  expect(reg.ok).toBe(true);
  return next.fingerprint();
}

describe('security: recovery.access bound to the wallet (finding 10c)', () => {
  it('PoC: a version-1 signature whose grant a retirement revoked does not get it back on the next wallet', async () => {
    const ctx = await setup();
    const old = access(ctx); // v1: names no wallet
    expect(await grant(ctx, old)).toMatchObject({ ok: true });
    await retireAndRepair(ctx);
    expect(ctx.engine.hasRecoveryAccess(PHONE)).toBe(false);
    expect(await grant(ctx, old)).toMatchObject({ ok: false, refusal: { reason: 'approval_revoked' } });
    // Not with another encoding of the same signature either (a compressed-P2PKH header instead of P2WPKH).
    const raw = base64.decode(old.signature);
    raw[0] = raw[0] - 39 + 31;
    expect(await grant(ctx, { ...old, signature: base64.encode(raw) })).toMatchObject({ ok: false, refusal: { reason: 'approval_revoked' } });
    // A fresh signature works.
    ctx.clock.advance(1000);
    expect(await grant(ctx, access(ctx))).toMatchObject({ ok: true });
  });

  it('a version-2 signature is valid for its wallet only', async () => {
    const ctx = await setup();
    expect(await grant(ctx, access(ctx, { walletId: '0123456789abcdef' }))).toMatchObject({ ok: false, refusal: { reason: 'approval_invalid_signature' } });
    const v2 = access(ctx, { walletId: ctx.walletId });
    expect(await grant(ctx, v2)).toMatchObject({ ok: true });
    const next = await retireAndRepair(ctx);
    expect(await grant(ctx, v2)).toMatchObject({ ok: false, refusal: { reason: 'approval_invalid_signature' } });
    expect(await grant(ctx, access(ctx, { walletId: next }))).toMatchObject({ ok: true });
  });

  it('the protocol text matches the engine, and the recovery code carries the wallet id', () => {
    const ctx = { guardianPubkey: GUARDIAN, phonePubkey: PHONE, expiresAt: 1_900_000_000 };
    for (const walletId of [undefined, '0123456789abcdef']) {
      const a = recoveryAccessMessage({ ...ctx, ...(walletId ? { walletId } : {}) });
      expect(protocolMessage({ ...ctx, ...(walletId ? { walletId } : {}) })).toBe(a);
      expect(a.length).toBeLessThanOrEqual(240);
      expect(a.startsWith(walletId ? 'Trikey recovery-access v2 wallet=0123456789abcdef ' : 'Trikey recovery-access v1 ')).toBe(true);
    }
    const uri = encodeRecoveryUri({ guardianPubkey: GUARDIAN, relays: ['wss://relay.example'], network: 'regtest', walletId: '0123456789abcdef' });
    expect(decodeRecoveryUri(uri)).toMatchObject({ walletId: '0123456789abcdef' });
    expect(decodeRecoveryUri(encodeRecoveryUri({ guardianPubkey: GUARDIAN, relays: ['wss://relay.example'], network: 'regtest' })).walletId).toBeUndefined();
    expect(() => decodeRecoveryUri(uri.replace('0123456789abcdef', 'nope'))).toThrow();
  });
});
