// Interfaces the phone app implements for the wallet: hardware wallets,
// secure key storage, plain app storage, cloud backup and passkeys.
// The wallet logic in this package only talks to the platform through these.

import type { QrModel } from './qr-devices.js';

/**
 * How the phone talks to the hardware wallet. `coldcard`, `jade` and `qr` are air-gapped devices over QR codes;
 * `coldcard-nfc` is a Coldcard (Mk4 or Q) over NFC (nfc-devices.ts); `jade-ble` is a Blockstream Jade or Jade Plus over
 * Bluetooth (ble-devices.ts).
 */
export type HardwareKind = 'ledger' | 'trezor' | 'coldcard' | 'bitbox02' | 'jade' | 'qr' | 'coldcard-nfc' | 'jade-ble';

export interface HardwareDeviceInfo {
  kind: HardwareKind;
  /** e.g. "Nano X", "Safe 3"; for display only. */
  model?: string;
  /** Master key fingerprint, 8 lowercase hex characters. */
  fingerprint: string;
  /** QR devices: which model it is (chosen by the owner, or suggested by its key export). A Coldcard over NFC: `coldcard-mk4` or `coldcard-q`. */
  qrModel?: QrModel;
}

/** What `signMessage` is for, so a device that needs the owner to act (QR) can say so. */
export interface SignMessageContext {
  /** `rules`: at pairing, the rules the wallet starts with (the policy text with `seq=0`), which the owner checks on the device. */
  purpose?: 'pairing' | 'rules' | 'approval' | 'recovery-access' | 'notes' | 'unlock';
  /** The same text is signed `of` times in a row (notes and hardware unlock check the device signs the same way twice). */
  round?: { n: number; of: number };
}

/** A multisig wallet as a hardware wallet needs to see it. */
export interface HardwareWalletPolicy {
  /** Name shown on the device, at most 16 ASCII characters. */
  name: string;
  /** The wallet's `wsh(sortedmulti(2,...))` descriptor with key origins and `/<0;1>/*`. */
  descriptor: string;
  /** Proof returned by `registerWallet` on devices that need one (Ledger's HMAC). */
  registration?: { hmac: string };
}

export interface HardwareSigner {
  readonly info: HardwareDeviceInfo;
  /** Extended public key at a BIP32 path such as `m/48'/1'/0'/2'`. Returns xpub (mainnet) or tpub. */
  getXpub(path: string): Promise<string>;
  /**
   * Register the multisig wallet on devices that need it (Ledger, BitBox02, Jade, Coldcard).
   * Others resolve with `{}`. The user approves on the device.
   */
  registerWallet(wallet: HardwareWalletPolicy): Promise<{ hmac?: string }>;
  /** Show the receive (0) or change (1) address at `index` on the device; resolves with that address. */
  displayAddress(wallet: HardwareWalletPolicy, chain: 0 | 1, index: number): Promise<string>;
  /** Sign every input the device can sign; returns the PSBT (base64) with its signatures added. */
  signPsbt(psbtBase64: string, wallet: HardwareWalletPolicy): Promise<string>;
  /** BIP137 `signmessage` with the single-sig key at `path`; returns the base64 signature. */
  signMessage(path: string, message: string, context?: SignMessageContext): Promise<string>;
  /** Release the connection (BLE, USB, deep link session). */
  close(): Promise<void>;
}

/**
 * True when `e`, or an error it wraps (`cause`), says the device's connection is gone: an error named `HardwareError` with
 * `code: 'disconnected'`, as the app's Ledger and Trezor signers throw. The wallet then drops a connection it was holding
 * and connects again.
 */
export function isHardwareDisconnect(e: unknown): boolean {
  for (let x = e, depth = 0; x && typeof x === 'object' && depth < 5; x = (x as { cause?: unknown }).cause, depth++) {
    const { name, code } = x as { name?: unknown; code?: unknown };
    if (name === 'HardwareError' && code === 'disconnected') return true;
  }
  return false;
}

/**
 * The wallet's record of a device it connects again: its master fingerprint and, for key 1, its BIP 48 account key. A
 * provider that would otherwise have to ask the owner for the device's key first (a Coldcard over NFC: one more tap) may
 * take them from here; every answer of the device is still checked against them (signatures against these keys).
 */
export interface KnownHardware {
  fingerprint: string;
  account?: { path: string; xpub: string };
}

/** Finds and connects hardware wallets. One implementation per transport. */
export interface HardwareProvider {
  readonly kinds: readonly HardwareKind[];
  isAvailable(): Promise<boolean>;
  /**
   * `qrModel`: for QR devices, the model the owner picked (or the one stored for the wallet's device). `known`: the
   * device the wallet expects (see `KnownHardware`); the wallet still checks `info.fingerprint` against it.
   */
  connect(opts?: { kind?: HardwareKind; signal?: AbortSignal; qrModel?: QrModel; known?: KnownHardware }): Promise<HardwareSigner>;
}

/** Secrets (the key 2 seed) kept in the Secure Enclave / Android Keystore-backed store. */
export interface SecureKeyStore {
  save(id: string, secret: Uint8Array, opts: { requireBiometrics: boolean }): Promise<void>;
  /** Resolves `null` if there is no such secret. May show the biometric prompt with `reason`. */
  load(id: string, reason: string): Promise<Uint8Array | null>;
  remove(id: string): Promise<void>;
}

/** Non-secret app state (descriptor, pairing info, caches). */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** The user's own cloud (iCloud Drive app folder, Google Drive appDataFolder). Holds only encrypted blobs. */
export interface CloudBackupStore {
  readonly provider: 'icloud' | 'google-drive' | 'file';
  isAvailable(): Promise<boolean>;
  write(name: string, data: Uint8Array): Promise<void>;
  read(name: string): Promise<Uint8Array | null>;
  list(): Promise<string[]>;
  remove(name: string): Promise<void>;
}

/** A WebAuthn passkey with the PRF extension, used to wrap the backup's data key. */
export interface PasskeyPrf {
  isSupported(): Promise<boolean>;
  /** Create a passkey for this wallet and evaluate PRF with `salt`. */
  create(opts: { userName: string; salt: Uint8Array }): Promise<{ credentialId: string; prfOutput: Uint8Array }>;
  /** Evaluate PRF with an existing passkey (any of the user's synced passkeys if `credentialId` is omitted). */
  get(opts: { credentialId?: string; salt: Uint8Array }): Promise<{ credentialId: string; prfOutput: Uint8Array }>;
}
