/**
 * Software stand-ins for the platform interfaces, for tests and for a regtest
 * "simulated device" in the app's developer menu:
 *
 * - `SoftwareHardwareSigner` / `SoftwareHardwareProvider`: a hardware wallet
 *   backed by a BIP 39 seed in memory (PSBT signing with core's
 *   `SoftwareSigner`, BIP 137 message signing). It behaves like a careful
 *   device: it refuses to sign for a wallet that was not registered on it, or
 *   PSBT inputs outside that wallet unless they are already finalized (external
 *   inputs, like Trezor's: the helper coin of a silent payment), and derives
 *   addresses itself.
 * - `MemorySecureKeyStore`, `MemoryKeyValueStore`, `MemoryCloudBackupStore`, `MemorySecurityKeys`,
 *   `MemoryPasskeyPrf`.
 *
 * NEVER for real funds: the software hardware wallet refuses network `bitcoin`.
 */
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { base64, hex } from '@scure/base';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { MultisigWallet, ROLES, SoftwareSigner, getNetwork, parseSortedMultiDescriptor, type Network, type NetworkName } from '@trikey/core';
import { analyzeMixedPsbt } from '../silent.js';
import { messageHash, signMessage } from '../bip137.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { isValidMnemonic } from '../keys.js';
import type { QrModel } from '../qr-devices.js';
import type {
  SignMessageContext,
  CloudBackupStore,
  HardwareDeviceInfo,
  HardwareKind,
  HardwareProvider,
  HardwareSigner,
  HardwareWalletPolicy,
  KeyValueStore,
  PasskeyPrf,
  SecureKeyStore,
  SecurityKeyEnrolment,
  SecurityKeySlot,
  SecurityKeyUnlock,
} from '../platform.js';
import { SecurityKeyError } from '../platform.js';
import { p256 } from '@noble/curves/nist.js';
import { secureRandomBytes } from '@trikey/core/random';

function refuseMainnet(network: NetworkName): Network {
  if (network === 'bitcoin') throw new Error('software hardware wallets are for tests and regtest only; refusing network "bitcoin"');
  return getNetwork(network);
}

export interface SoftwareHardwareOptions {
  mnemonic: string;
  network: NetworkName;
  kind?: HardwareKind;
  model?: string;
  /** QR devices: the model it reports (qr-devices.ts). */
  qrModel?: QrModel;
  /** Demand `registerWallet` before signing or showing addresses (default: true for ledger, bitbox02, jade, coldcard, coldcard-nfc, jade-ble). */
  requireRegistration?: boolean;
  /** Sign PSBTs that also spend finalized inputs of another wallet (external inputs). Default true. */
  allowExternalInputs?: boolean;
}

/** One call the simulated device received (for test assertions). */
export type DeviceCall =
  | { op: 'getXpub'; path: string }
  | { op: 'registerWallet'; name: string; descriptor: string }
  | { op: 'displayAddress'; chain: 0 | 1; index: number; address: string }
  | { op: 'signPsbt'; inputs: number; externalInputs: number }
  | { op: 'signMessage'; path: string; message: string; context?: SignMessageContext }
  | { op: 'close' };

const REGISTERING_KINDS: HardwareKind[] = ['ledger', 'bitbox02', 'jade', 'coldcard', 'coldcard-nfc', 'jade-ble'];

/** A BIP 137 signature (p2pkh header) with a random nonce: valid, never the same twice. */
function signMessageWithNonce(message: string, privateKey: Uint8Array): string {
  const rec = secp256k1.sign(messageHash(message), privateKey, { prehash: false, lowS: true, format: 'recovered', extraEntropy: secureRandomBytes(32) });
  const out = new Uint8Array(65);
  out[0] = 31 + rec[0]!;
  out.set(rec.subarray(1), 1);
  return base64.encode(out);
}

/** A hardware wallet in software. Regtest/testnet/signet only. */
export class SoftwareHardwareSigner implements HardwareSigner {
  readonly info: HardwareDeviceInfo;
  readonly network: Network;
  readonly calls: DeviceCall[] = [];
  /** Test hook: make the device show this instead of the address it derives. */
  displayOverride?: string;
  /** Test hook: the next signMessage returns a signature by another key. */
  signWithWrongKeyOnce = false;
  /**
   * Test hook: sign messages with a random nonce (valid signatures by the device's key, but never the same twice), as a
   * device without RFC 6979 would. Encrypted notes refuse such a device.
   */
  randomMessageNonces = false;
  private readonly master: HDKey;
  private readonly mnemonic: string;
  private readonly requireRegistration: boolean;
  private readonly allowExternalInputs: boolean;
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
    this.allowExternalInputs = opts.allowExternalInputs ?? true;
    this.hmacKey = sha256(concatBytes(utf8ToBytes('trikey-sim-device'), this.master.privateKey!));
    this.info = { kind, model: opts.model ?? 'Simulated device', fingerprint: this.master.fingerprint.toString(16).padStart(8, '0'), ...(opts.qrModel ? { qrModel: opts.qrModel } : {}) };
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
    // Like a real device: every input must belong to the registered wallet, or be another wallet's input that is
    // already finalized (an external input: it signs nothing there and checks the rest of the transaction).
    const a = analyzeMixedPsbt(psbt, wallet, { allowForeign: (f) => this.allowExternalInputs && f.finalized });
    this.calls.push({ op: 'signPsbt', inputs: a.vaultInputs.length, externalInputs: a.foreignInputs.length });
    const signed = await new SoftwareSigner('hardware', this.mnemonic, 'simulated device').signPsbt(psbt, this.network);
    return base64.encode(signed);
  }

  async signMessage(path: string, message: string, context?: SignMessageContext): Promise<string> {
    this.checkPath(path);
    if (!/^[\x20-\x7e]+$/.test(message)) throw new Error('the device only signs printable ASCII');
    this.calls.push({ op: 'signMessage', path, message, ...(context ? { context } : {}) });
    if (this.signWithWrongKeyOnce) {
      this.signWithWrongKeyOnce = false;
      return signMessage(message, sha256(utf8ToBytes('not the device key')));
    }
    if (this.randomMessageNonces) return signMessageWithNonce(message, this.master.derive(path).privateKey!);
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

/**
 * A device whose key export was swapped on its way to the phone: the QR code or NFC read the phone took carries
 * `impostorMnemonic`'s key, at the asked path and under this device's own fingerprint, so nothing in the export gives it
 * away. The device itself still works addresses out with its own key, as a real one does, so `displayAddress` (the
 * device's screen, or the compare sheet an air-gapped device gets) shows another address than the phone computes. For
 * tests of the on-device address check, the one thing that catches it.
 */
export class SwappedExportSigner extends SoftwareHardwareSigner {
  private readonly impostor: HDKey;
  /** Impostor xpub handed out -> this device's own xpub at the same path. */
  private readonly swapped = new Map<string, string>();

  constructor(opts: SoftwareHardwareOptions & { impostorMnemonic: string }) {
    super(opts);
    this.impostor = HDKey.fromMasterSeed(mnemonicToSeedSync(opts.impostorMnemonic), this.network.bip32);
  }

  override async getXpub(path: string): Promise<string> {
    const own = await super.getXpub(path);
    const fake = this.impostor.derive(path).publicExtendedKey;
    this.swapped.set(fake, own);
    return fake;
  }

  override async displayAddress(policy: HardwareWalletPolicy, chain: 0 | 1, index: number): Promise<string> {
    let descriptor = policy.descriptor.replace(/#[a-z0-9]{8}$/, '');
    for (const [fake, own] of this.swapped) descriptor = descriptor.split(fake).join(own);
    const address = MultisigWallet.fromDescriptor(descriptor, this.network).derive(chain, index).address;
    this.calls.push({ op: 'displayAddress', chain, index, address });
    return address;
  }
}

/** Hands out the software device(s). `device` can be swapped to simulate plugging in another one. */
export class SoftwareHardwareProvider implements HardwareProvider {
  readonly kinds: readonly HardwareKind[] = ['ledger', 'trezor', 'coldcard', 'bitbox02', 'jade', 'qr', 'coldcard-nfc', 'jade-ble'];
  connects = 0;

  /**
   * Other devices at hand: one the wallet asks for by fingerprint (`known`, a wallet's own device) is the one that
   * connects, as when the owner plugs in the device the phone names (adding a wallet asks the first wallet's device too).
   */
  others: SoftwareHardwareSigner[] = [];

  constructor(public device: SoftwareHardwareSigner) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async connect(opts?: { kind?: HardwareKind; known?: { fingerprint: string } }): Promise<HardwareSigner> {
    this.connects++;
    const known = opts?.known?.fingerprint;
    return (known && this.device.info.fingerprint !== known ? this.others.find((d) => d.info.fingerprint === known) : undefined) ?? this.device;
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
    const credentialId = base64.encode(secureRandomBytes(16));
    const secret = secureRandomBytes(32);
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

/** One simulated security key (`MemorySecurityKeys`). */
export interface MemorySecurityKey {
  name: string;
  type: 'fido-prf' | 'piv-ecdh';
  /** Fixed per key (from its `seed`): the same input always gives the same answer. Made-up bytes, never a real key's. */
  secret: Uint8Array;
  credentialId: string;
  serial: number;
}

/**
 * Security keys for the optional lock on key 2 (key2-lock.ts), in memory and deterministic: each key's secret comes from
 * its seed. A `fido-prf` key answers PRF as `MemoryPasskeyPrf` does (HMAC-SHA256 of its secret over the WebAuthn PRF
 * salt); a `piv-ecdh` key holds a P-256 key made from its secret and answers ECDH (the shared point's x). `held` names the
 * key the person holds to the phone next. Test hooks: `cancelNext`, `failNext`, `wrongAnswerNext`, `supported`.
 */
export class MemorySecurityKeys implements SecurityKeyUnlock {
  static readonly RP_ID = 'trikey.test';
  readonly keys: MemorySecurityKey[];
  held: string;
  supported = true;
  /** The next prompt is cancelled by the person (`SecurityKeyError` `cancelled`). */
  cancelNext = false;
  /** The next prompt fails (`SecurityKeyError` `failed`). */
  failNext = false;
  /** The next unlock answers with other bytes, as a key whose PRF changed would. */
  wrongAnswerNext = false;
  /** Every prompt, for assertions. */
  readonly calls: { op: 'enrol' | 'unlock'; reason: string; key: string; slots?: number }[] = [];
  /** Every KEK material handed out (tests check the wallet zeroed it). */
  readonly handedOut: Uint8Array[] = [];

  constructor(keys: { name: string; type?: 'fido-prf' | 'piv-ecdh'; seed: number }[]) {
    this.keys = keys.map((k) => {
      const secret = sha256(utf8ToBytes(`trikey test security key ${k.seed}`));
      return { name: k.name, type: k.type ?? 'fido-prf', secret, credentialId: base64.encode(sha256(concatBytes(secret, utf8ToBytes('credential'))).subarray(0, 16)), serial: 10_000_000 + k.seed };
    });
    this.held = this.keys[0]!.name;
  }

  async isSupported(): Promise<boolean> {
    return this.supported;
  }

  private key(): MemorySecurityKey {
    const k = this.keys.find((x) => x.name === this.held);
    if (!k) throw new SecurityKeyError('failed', `no security key "${this.held}"`);
    return k;
  }

  private hooks(): void {
    if (this.cancelNext) {
      this.cancelNext = false;
      throw new SecurityKeyError('cancelled', 'The person cancelled.');
    }
    if (this.failNext) {
      this.failNext = false;
      throw new SecurityKeyError('failed', 'The security key did not answer.');
    }
  }

  private prf(k: MemorySecurityKey, salt: Uint8Array): Uint8Array {
    return hmac(sha256, k.secret, sha256(concatBytes(utf8ToBytes('WebAuthn PRF'), Uint8Array.of(0), salt)));
  }

  private handOut(material: Uint8Array): Uint8Array {
    this.handedOut.push(material);
    return material;
  }

  private matches(k: MemorySecurityKey, s: SecurityKeySlot): boolean {
    return s.type === 'fido-prf' ? k.type === 'fido-prf' && s.credentialId === k.credentialId && s.rpId === MemorySecurityKeys.RP_ID : k.type === 'piv-ecdh' && s.serial === k.serial;
  }

  async enrol(opts: { reason: string; label: string; prfSalt: Uint8Array; exclude: readonly SecurityKeySlot[] }): Promise<SecurityKeyEnrolment> {
    const k = this.key();
    this.calls.push({ op: 'enrol', reason: opts.reason, key: k.name });
    this.hooks();
    if (opts.exclude.some((s) => this.matches(k, s))) throw new SecurityKeyError('failed', 'This security key is already enrolled.');
    if (k.type === 'fido-prf')
      return { type: 'fido-prf', credentialId: k.credentialId, rpId: MemorySecurityKeys.RP_ID, aaguid: bytesToHex(sha256(utf8ToBytes('test aaguid')).subarray(0, 16)), kekMaterial: this.handOut(this.prf(k, opts.prfSalt)) };
    const ephemeral = p256.utils.randomSecretKey();
    try {
      const cardPub = p256.getPublicKey(k.secret, false);
      return {
        type: 'piv-ecdh',
        serial: k.serial,
        slot: '9d',
        cardPub,
        ephemeralPub: p256.getPublicKey(ephemeral, false),
        kekMaterial: this.handOut(p256.getSharedSecret(ephemeral, cardPub, true).slice(1)),
      };
    } finally {
      ephemeral.fill(0);
    }
  }

  async unlock(slots: readonly SecurityKeySlot[], reason: string): Promise<{ slotIndex: number; kekMaterial: Uint8Array }> {
    const k = this.key();
    this.calls.push({ op: 'unlock', reason, key: k.name, slots: slots.length });
    this.hooks();
    const slotIndex = slots.findIndex((s) => this.matches(k, s));
    if (slotIndex < 0) throw new SecurityKeyError('failed', 'This security key is not enrolled here.');
    const s = slots[slotIndex]!;
    const material = s.type === 'fido-prf' ? this.prf(k, s.prfSalt) : p256.getSharedSecret(k.secret, s.ephemeralPub, true).slice(1);
    if (this.wrongAnswerNext) {
      this.wrongAnswerNext = false;
      material[0]! ^= 1;
    }
    return { slotIndex, kekMaterial: this.handOut(material) };
  }
}

/** Every role key in a descriptor (tests). */
export function descriptorRoles(descriptor: string) {
  const keys = parseSortedMultiDescriptor(descriptor);
  return Object.fromEntries(ROLES.map((r, i) => [r, keys[i]!]));
}
