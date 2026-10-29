/**
 * Software stand-ins for the platform interfaces, for tests and for a regtest
 * "simulated device" in the app's developer menu:
 *
 * - `SoftwareHardwareSigner` / `SoftwareHardwareProvider`: a hardware wallet
 *   backed by a BIP 39 seed in memory (PSBT signing with core's
 *   `SoftwareSigner`, BIP 137 message signing). It behaves like a careful
 *   device: it refuses to sign for a wallet that was not registered on it, or
 *   PSBT inputs outside that wallet, and derives addresses itself.
 * - `MemorySecureKeyStore`, `MemoryKeyValueStore`, `MemoryCloudBackupStore`,
 *   `MemoryPasskeyPrf`.
 *
 * NEVER for real funds: the software hardware wallet refuses network `bitcoin`.
 */
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { base64, hex } from '@scure/base';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { MultisigWallet, ROLES, SoftwareSigner, analyzePsbt, getNetwork, parseSortedMultiDescriptor, type Network, type NetworkName } from '@trikey/core';
import { signMessage } from '../bip137.js';
import { isValidMnemonic } from '../keys.js';
import type {
  CloudBackupStore,
  HardwareDeviceInfo,
  HardwareKind,
  HardwareProvider,
  HardwareSigner,
  HardwareWalletPolicy,
  KeyValueStore,
  PasskeyPrf,
  SecureKeyStore,
} from '../platform.js';

function refuseMainnet(network: NetworkName): Network {
  if (network === 'bitcoin') throw new Error('software hardware wallets are for tests and regtest only; refusing network "bitcoin"');
  return getNetwork(network);
}

export interface SoftwareHardwareOptions {
  mnemonic: string;
  network: NetworkName;
  kind?: HardwareKind;
  model?: string;
  /** Demand `registerWallet` before signing or showing addresses (default: true for ledger, bitbox02, jade, coldcard). */
  requireRegistration?: boolean;
}

/** One call the simulated device received (for test assertions). */
export type DeviceCall =
  | { op: 'getXpub'; path: string }
  | { op: 'registerWallet'; name: string; descriptor: string }
  | { op: 'displayAddress'; chain: 0 | 1; index: number; address: string }
  | { op: 'signPsbt'; inputs: number }
  | { op: 'signMessage'; path: string; message: string }
  | { op: 'close' };

const REGISTERING_KINDS: HardwareKind[] = ['ledger', 'bitbox02', 'jade', 'coldcard'];

/** A hardware wallet in software. Regtest/testnet/signet only. */
export class SoftwareHardwareSigner implements HardwareSigner {
  readonly info: HardwareDeviceInfo;
  readonly network: Network;
  readonly calls: DeviceCall[] = [];
  /** Test hook: make the device show this instead of the address it derives. */
  displayOverride?: string;
  /** Test hook: the next signMessage returns a signature by another key. */
  signWithWrongKeyOnce = false;
  private readonly master: HDKey;
  private readonly mnemonic: string;
  private readonly requireRegistration: boolean;
  private readonly hmacKey: Uint8Array;
  /** descriptor -> hmac */
  private readonly registered = new Map<string, string>();

  constructor(opts: SoftwareHardwareOptions) {
    this.network = refuseMainnet(opts.network);
    if (!isValidMnemonic(opts.mnemonic)) throw new Error('invalid mnemonic');
    this.mnemonic = opts.mnemonic;
    this.master = HDKey.fromMasterSeed(mnemonicToSeedSync(opts.mnemonic), this.network.bip32);
    const kind = opts.kind ?? 'ledger';
    this.requireRegistration = opts.requireRegistration ?? REGISTERING_KINDS.includes(kind);
    this.hmacKey = sha256(concatBytes(utf8ToBytes('trikey-sim-device'), this.master.privateKey!));
    this.info = { kind, model: opts.model ?? 'Simulated device', fingerprint: this.master.fingerprint.toString(16).padStart(8, '0') };
  }

  private checkPath(path: string): void {
    const m = /^m\/(\d+)'\/(\d+)'/.exec(path);
    if (m && (m[1] === '44' || m[1] === '48' || m[1] === '49' || m[1] === '84' || m[1] === '86') && Number(m[2]) !== this.network.coinType)
      throw new Error(`refusing a coin type ${m[2]}' path on ${this.network.name}`);
  }

  async getXpub(path: string): Promise<string> {
    this.checkPath(path);
    this.calls.push({ op: 'getXpub', path });
    return this.master.derive(path).publicExtendedKey;
  }

  private walletOf(policy: HardwareWalletPolicy): MultisigWallet {
    const wallet = MultisigWallet.fromDescriptor(policy.descriptor, this.network);
    const ours = parseSortedMultiDescriptor(policy.descriptor).some((k) => k.fingerprint === this.info.fingerprint);
    if (!ours) throw new Error('this wallet does not include this device');
    return wallet;
  }

  private checkRegistered(policy: HardwareWalletPolicy): void {
    if (!this.requireRegistration) return;
    const h = this.registered.get(policy.descriptor);
    if (!h || policy.registration?.hmac !== h) throw new Error('wallet not registered on this device');
  }

  async registerWallet(policy: HardwareWalletPolicy): Promise<{ hmac?: string }> {
    if (!/^[\x20-\x7e]{1,16}$/.test(policy.name)) throw new Error('wallet name must be 1-16 ASCII characters');
    this.walletOf(policy);
    this.calls.push({ op: 'registerWallet', name: policy.name, descriptor: policy.descriptor });
    if (!this.requireRegistration) return {};
    const h = bytesToHex(hmac(sha256, this.hmacKey, utf8ToBytes(`${policy.name}\n${policy.descriptor}`)));
    this.registered.set(policy.descriptor, h);
    return { hmac: h };
  }

  async displayAddress(policy: HardwareWalletPolicy, chain: 0 | 1, index: number): Promise<string> {
    const wallet = this.walletOf(policy);
    this.checkRegistered(policy);
    const address = this.displayOverride ?? wallet.derive(chain, index).address;
    this.calls.push({ op: 'displayAddress', chain, index, address });
    return address;
  }

  async signPsbt(psbtBase64: string, policy: HardwareWalletPolicy): Promise<string> {
    const wallet = this.walletOf(policy);
    this.checkRegistered(policy);
    const psbt = base64.decode(psbtBase64);
    // Like a real device: every input must belong to the registered wallet.
    const a = analyzePsbt(psbt, wallet.accountPubkeys(), this.network);
    this.calls.push({ op: 'signPsbt', inputs: a.inputs.length });
    const signed = await new SoftwareSigner('hardware', this.mnemonic, 'simulated device').signPsbt(psbt, this.network);
    return base64.encode(signed);
  }

  async signMessage(path: string, message: string): Promise<string> {
    this.checkPath(path);
    if (!/^[\x20-\x7e]+$/.test(message)) throw new Error('the device only signs printable ASCII');
    this.calls.push({ op: 'signMessage', path, message });
    if (this.signWithWrongKeyOnce) {
      this.signWithWrongKeyOnce = false;
      return signMessage(message, sha256(utf8ToBytes('not the device key')));
    }
    return signMessage(message, this.master.derive(path).privateKey!);
  }

  async close(): Promise<void> {
    this.calls.push({ op: 'close' });
  }

  /** The key at `path` (tests). */
  publicKeyAt(path: string): string {
    return hex.encode(this.master.derive(path).publicKey!);
  }
}

/** Hands out the software device(s). `device` can be swapped to simulate plugging in another one. */
export class SoftwareHardwareProvider implements HardwareProvider {
  readonly kinds: readonly HardwareKind[] = ['ledger', 'trezor', 'coldcard', 'bitbox02', 'jade', 'qr'];
  connects = 0;

  constructor(public device: SoftwareHardwareSigner) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async connect(): Promise<HardwareSigner> {
    this.connects++;
    return this.device;
  }
}

/** Secure store in memory, recording how each secret was saved and every load (tests check biometrics). */
export class MemorySecureKeyStore implements SecureKeyStore {
  readonly items = new Map<string, { secret: Uint8Array; requireBiometrics: boolean }>();
  readonly loads: { id: string; reason: string; biometric: boolean }[] = [];
  /** Test hook: the next biometric load fails as if the user cancelled. */
  cancelNextPrompt = false;

  async save(id: string, secret: Uint8Array, opts: { requireBiometrics: boolean }): Promise<void> {
    this.items.set(id, { secret: secret.slice(), requireBiometrics: opts.requireBiometrics });
  }

  async load(id: string, reason: string): Promise<Uint8Array | null> {
    const item = this.items.get(id);
    this.loads.push({ id, reason, biometric: !!item?.requireBiometrics });
    if (!item) return null;
    if (item.requireBiometrics && this.cancelNextPrompt) {
      this.cancelNextPrompt = false;
      throw new Error('user cancelled');
    }
    return item.secret.slice();
  }

  async remove(id: string): Promise<void> {
    this.items.delete(id);
  }
}

export class MemoryKeyValueStore implements KeyValueStore {
  readonly data = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }
  async remove(key: string): Promise<void> {
    this.data.delete(key);
  }
}

export class MemoryCloudBackupStore implements CloudBackupStore {
  readonly provider = 'file' as const;
  readonly files = new Map<string, Uint8Array>();
  available = true;
  async isAvailable(): Promise<boolean> {
    return this.available;
  }
  async write(name: string, data: Uint8Array): Promise<void> {
    this.files.set(name, data.slice());
  }
  async read(name: string): Promise<Uint8Array | null> {
    return this.files.get(name)?.slice() ?? null;
  }
  async list(): Promise<string[]> {
    return [...this.files.keys()];
  }
  async remove(name: string): Promise<void> {
    this.files.delete(name);
  }
}

/**
 * Passkeys with the PRF extension, in memory. PRF = HMAC-SHA256(credential secret,
 * SHA-256("WebAuthn PRF" || 0x00 || salt)), the way WebAuthn maps PRF onto hmac-secret.
 * Share one instance between two simulated phones to model a synced passkey.
 */
export class MemoryPasskeyPrf implements PasskeyPrf {
  readonly credentials = new Map<string, { userName: string; secret: Uint8Array }>();
  supported = true;

  async isSupported(): Promise<boolean> {
    return this.supported;
  }

  private eval(secret: Uint8Array, salt: Uint8Array): Uint8Array {
    return hmac(sha256, secret, sha256(concatBytes(utf8ToBytes('WebAuthn PRF'), Uint8Array.of(0), salt)));
  }

  async create(opts: { userName: string; salt: Uint8Array }): Promise<{ credentialId: string; prfOutput: Uint8Array }> {
    if (!this.supported) throw new Error('passkeys are not supported');
    const credentialId = base64.encode(randomBytes(16));
    const secret = randomBytes(32);
    this.credentials.set(credentialId, { userName: opts.userName, secret });
    return { credentialId, prfOutput: this.eval(secret, opts.salt) };
  }

  async get(opts: { credentialId?: string; salt: Uint8Array }): Promise<{ credentialId: string; prfOutput: Uint8Array }> {
    if (!this.supported) throw new Error('passkeys are not supported');
    const id = opts.credentialId ?? this.credentials.keys().next().value;
    const c = id === undefined ? undefined : this.credentials.get(id);
    if (!c || id === undefined) throw new Error('no such passkey');
    return { credentialId: id, prfOutput: this.eval(c.secret, opts.salt) };
  }
}

/** Every role key in a descriptor (tests). */
export function descriptorRoles(descriptor: string) {
  const keys = parseSortedMultiDescriptor(descriptor);
  return Object.fromEntries(ROLES.map((r, i) => [r, keys[i]!]));
}
