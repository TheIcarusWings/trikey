// Dev-only check that the wallet's crypto stack runs on this JS engine (Hermes on a phone, Node
// in tests): the polyfills, @noble/@scure through @trikey/core, and nostr-tools through
// @trikey/protocol. The Developer section of Settings runs it. The modules are imported when
// the test runs, so nothing here is evaluated at app start.

import { runtimeReport } from './polyfill-install';

export interface SelfTestStep {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface SelfTestReport {
  ok: boolean;
  steps: SelfTestStep[];
  totalMs: number;
}

// Public test vectors / values computed once with the same libraries in Node.
const NIP06_MNEMONIC = 'leader monkey parrot ring guide accident before fence cannon height naive bean';
const NIP06_PUBKEY = '17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917';
const MNEMONICS = [
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  'legal winner thank year wave sausage worth useful legal winner thank yellow',
  'letter advice cage absurd amount doctor acoustic avoid letter advice cage above',
] as const;
const FIRST_SIGNET_ADDRESS = 'tb1qr3az57pxl8z7q6d9q7v0fmeaphuwe3z0ghvkjr457ch4vqwmtkasmn0gme';
const APP_FINGERPRINT = '73c5da0a';
const DESCRIPTOR_CHECKSUM = 'eezrhmjx';

function expect(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

async function runStep(name: string, fn: () => void | Promise<void>): Promise<SelfTestStep> {
  const t0 = Date.now();
  try {
    await fn();
    return { name, ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function runCryptoSelfTest(): Promise<SelfTestReport> {
  const t0 = Date.now();
  const steps: SelfTestStep[] = [];

  steps.push(
    await runStep('Runtime globals', () => {
      const missing = runtimeReport().filter((c) => !c.ok).map((c) => c.name);
      expect(missing.length === 0, `missing: ${missing.join(', ')}`);
    }),
  );

  steps.push(
    await runStep('Random bytes', () => {
      const a = crypto.getRandomValues(new Uint8Array(32));
      const b = crypto.getRandomValues(new Uint8Array(32));
      expect(a.some((x) => x !== 0), 'all zero');
      expect(a.join() !== b.join(), 'two draws were identical');
    }),
  );

  steps.push(
    await runStep('Text encoding', () => {
      const text = 'Trikey ₿ 🔑 é';
      expect(new TextDecoder().decode(new TextEncoder().encode(text)) === text, 'UTF-8 round trip failed');
    }),
  );

  steps.push(
    await runStep('Key derivation (BIP39, BIP32, NIP-06)', async () => {
      const { identityFromMnemonic } = await import('@trikey/protocol');
      expect(identityFromMnemonic(NIP06_MNEMONIC).pubkey === NIP06_PUBKEY, 'NIP-06 test vector mismatch');
    }),
  );

  steps.push(
    await runStep('Multisig wallet (BIP48, descriptor, address)', async () => {
      const { HDKey } = await import('@scure/bip32');
      const { mnemonicToSeedSync } = await import('@scure/bip39');
      const core = await import('@trikey/core');
      const net = core.NETWORKS.signet;
      const path = core.bip48Path(net);
      const masters = MNEMONICS.map((m) => HDKey.fromMasterSeed(mnemonicToSeedSync(m, ''), net.bip32));
      expect(masters[0]!.fingerprint.toString(16) === APP_FINGERPRINT, 'master fingerprint mismatch');
      const wallet = new core.MultisigWallet(net, {
        app: core.keyExpressionFromMaster(masters[0]!, path),
        hardware: core.keyExpressionFromMaster(masters[1]!, path),
        cosigner: core.bareKeyExpression(masters[2]!.derive(path)),
      });
      expect(wallet.descriptor().endsWith(`#${DESCRIPTOR_CHECKSUM}`), 'descriptor checksum mismatch');
      expect(wallet.derive(0, 0).address === FIRST_SIGNET_ADDRESS, 'first address mismatch');
    }),
  );

  steps.push(
    await runStep('NIP-44 encrypt and decrypt', async () => {
      const nip44 = await import('nostr-tools/nip44');
      const { generateSecretKey, getPublicKey } = await import('nostr-tools/pure');
      const alice = generateSecretKey();
      const bob = generateSecretKey();
      const plaintext = 'sign this ₿ 🔑';
      const sealed = nip44.encrypt(plaintext, nip44.getConversationKey(alice, getPublicKey(bob)));
      expect(sealed !== plaintext, 'not encrypted');
      expect(nip44.decrypt(sealed, nip44.getConversationKey(bob, getPublicKey(alice))) === plaintext, 'decrypt mismatch');
      let rejected = false;
      try {
        nip44.decrypt(sealed, nip44.getConversationKey(generateSecretKey(), getPublicKey(alice)));
      } catch {
        rejected = true;
      }
      expect(rejected, 'a wrong key decrypted the message');
    }),
  );

  steps.push(
    await runStep('Gift wrap (NIP-59) through the protocol', async () => {
      const { wrapMessage, unwrapMessage, generateMessageId } = await import('@trikey/protocol');
      const { generateSecretKey, getPublicKey } = await import('nostr-tools/pure');
      const phone = generateSecretKey();
      const guardian = generateSecretKey();
      const id = generateMessageId();
      const { wrap } = wrapMessage(
        { id, method: 'guardian.status', params: {} },
        { senderSecretKey: phone, recipient: getPublicKey(guardian) },
      );
      const incoming = unwrapMessage(wrap, { recipientSecretKey: guardian, expectedPeer: getPublicKey(phone) });
      expect(incoming.meta.id === id && incoming.sender === getPublicKey(phone), 'unwrapped message differs');
    }),
  );

  return { ok: steps.every((s) => s.ok), steps, totalMs: Date.now() - t0 };
}

/** One line for the Settings row: "Passed: 7 checks in 412 ms" or "Failed: <first failing step>". */
export function summarize(report: SelfTestReport): string {
  if (report.ok) return `Passed: ${report.steps.length} checks, ${report.totalMs} ms`;
  const bad = report.steps.filter((s) => !s.ok);
  return `Failed: ${bad[0]!.name}`;
}
