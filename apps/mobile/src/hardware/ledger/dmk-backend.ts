/**
 * `LedgerBackend` on top of Ledger's Device Management Kit and its Bitcoin signer
 * (`@ledgerhq/device-signer-kit-bitcoin`). Everything that talks to the SDK lives here; `signer.ts` holds the logic.
 *
 * The Bitcoin signer hard-codes the app name "Bitcoin" when it opens the app itself, so for testnet/signet/regtest
 * (the separate "Bitcoin Test" app) we open the app ourselves with `OpenAppDeviceAction` and call the signer with
 * `skipOpenApp: true`.
 */
import { OpenAppDeviceAction, type DeviceManagementKit, type DeviceSessionId } from '@ledgerhq/device-management-kit';
import { RegisteredWallet, WalletPolicy, type SignerBtc } from '@ledgerhq/device-signer-kit-bitcoin';
import { HardwareError } from '../errors';
import type { PartialSignature } from '../common/psbt';
import { runDeviceAction, type DeviceActionLike } from './device-action';
import type { LedgerApp, LedgerBackend } from './signer';
import type { LedgerRegisteredWallet, LedgerWalletPolicy } from './policy';
import type { LedgerMessageSignature } from './signature';

const SKIP = { skipOpenApp: true } as const;

/**
 * The signer kit takes a derivation path without the leading `m/` ("48'/0'/0'/2'"): it parses every step as a number
 * and throws "invalid number provided" on the `m`. Our paths come from `formatPath`, which writes the `m/`.
 */
export function signerKitPath(path: string): string {
  return path.replace(/^m\//, '');
}

/** What the UI may want to tell the user while a call waits for the device ("Confirm on your Ledger"). */
export type LedgerInteraction = string;

export interface DmkBackendOptions {
  onInteraction?: (interaction: LedgerInteraction) => void;
  signal?: AbortSignal;
}

type DmkLike = Pick<DeviceManagementKit, 'executeDeviceAction' | 'disconnect'>;

/** An unsigned ECDSA signature from the app is DER; with the sighash byte appended it is what a PSBT stores. */
export function withSighashByte(signature: Uint8Array): Uint8Array {
  // A DER ECDSA signature is 0x30 <len> ...: its total length is len + 2. If it is exactly that, the byte is missing.
  if (signature[0] === 0x30 && signature.length === (signature[1] ?? 0) + 2) {
    const out = new Uint8Array(signature.length + 1);
    out.set(signature);
    out[signature.length] = 0x01; // SIGHASH_ALL: the only type Trikey PSBTs use
    return out;
  }
  return signature;
}

/** Keeps the ECDSA partial signatures of a `signPsbt` result (the app can also return MuSig2 and taproot data). */
export function ecdsaSignatures(result: readonly unknown[]): PartialSignature[] {
  const out: PartialSignature[] = [];
  for (const item of result) {
    const s = item as { inputIndex?: unknown; pubkey?: unknown; signature?: unknown; tapleafHash?: unknown };
    if (typeof s.inputIndex !== 'number' || !(s.pubkey instanceof Uint8Array) || !(s.signature instanceof Uint8Array)) continue;
    if (s.tapleafHash !== undefined) continue;
    out.push({ inputIndex: s.inputIndex, pubkey: s.pubkey, signature: withSighashByte(s.signature) });
  }
  return out;
}

export class DmkLedgerBackend implements LedgerBackend {
  constructor(
    private readonly dmk: DmkLike,
    private readonly sessionId: DeviceSessionId,
    private readonly signer: SignerBtc,
    private readonly opts: DmkBackendOptions = {},
  ) {}

  private run<O, E>(action: DeviceActionLike<O, E>): Promise<O> {
    return runDeviceAction(action, { signal: this.opts.signal, onInteraction: this.opts.onInteraction });
  }

  async ensureApp(app: LedgerApp): Promise<void> {
    // OpenAppDeviceAction does nothing if `app` is already open, closes another app first, and asks the user to confirm
    // on the device when it has to open it.
    const action = this.dmk.executeDeviceAction({
      sessionId: this.sessionId,
      deviceAction: new OpenAppDeviceAction({ input: { appName: app } }),
    });
    await this.run(action as unknown as DeviceActionLike<void, unknown>);
  }

  async getMasterFingerprint(): Promise<string> {
    const out = await this.run(this.signer.getMasterFingerprint(SKIP) as unknown as DeviceActionLike<{ masterFingerprint: Uint8Array }, unknown>);
    if (out.masterFingerprint.length !== 4) throw new HardwareError('invalid-response', 'The Ledger returned a malformed master fingerprint.', { kind: 'ledger' });
    return Array.from(out.masterFingerprint, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  async getExtendedPublicKey(path: string): Promise<string> {
    const out = await this.run(this.signer.getExtendedPublicKey(signerKitPath(path), { ...SKIP, checkOnDevice: false }) as unknown as DeviceActionLike<{ extendedPublicKey: string }, unknown>);
    return out.extendedPublicKey;
  }

  async registerWallet(policy: LedgerWalletPolicy): Promise<Uint8Array> {
    const wallet = new WalletPolicy(policy.name, policy.descriptorTemplate, policy.keys);
    const out = await this.run(this.signer.registerWallet(wallet, SKIP) as unknown as DeviceActionLike<{ hmac: Uint8Array }, unknown>);
    return out.hmac;
  }

  async getWalletAddress(wallet: LedgerRegisteredWallet, change: boolean, index: number, display: boolean): Promise<string> {
    const out = await this.run(
      this.signer.getWalletAddress(toRegistered(wallet), index, { ...SKIP, checkOnDevice: display, change }) as unknown as DeviceActionLike<{ address: string }, unknown>,
    );
    return out.address;
  }

  async signPsbt(wallet: LedgerRegisteredWallet, psbt: Uint8Array): Promise<PartialSignature[]> {
    // Our PSBTs are BIP174 v0. The signer kit normalises v0 to the PSBTv2 the Bitcoin app uses internally and returns
    // the signatures; we merge them into the original v0 PSBT ourselves.
    const out = await this.run(this.signer.signPsbt(toRegistered(wallet), psbt, SKIP) as unknown as DeviceActionLike<unknown[], unknown>);
    return ecdsaSignatures(out);
  }

  async signMessage(path: string, message: string): Promise<LedgerMessageSignature> {
    return this.run(this.signer.signMessage(signerKitPath(path), message, SKIP) as unknown as DeviceActionLike<LedgerMessageSignature, unknown>);
  }

  async close(): Promise<void> {
    await this.dmk.disconnect({ sessionId: this.sessionId });
  }
}

function toRegistered(wallet: LedgerRegisteredWallet): RegisteredWallet {
  return new RegisteredWallet(wallet.name, wallet.descriptorTemplate, wallet.keys, wallet.hmac);
}
