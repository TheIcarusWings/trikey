import type {
  HardwareKind,
  KitDestination,
  KitInfo,
  KitProof,
  KitRecoveryResult,
  RecoveryKeyOption,
  RecoveryKit,
  RefillApproval,
  RefillPreview,
  Sats,
  ServerCheck,
} from './types';

/**
 * What the Recovery Key screens ask of the wallet (`WalletService.rk`). The demo's mock and the real wallet in
 * ./rk-service.ts both implement it. Errors are `WalletServiceError`s, as everywhere.
 */
export interface RecoveryKeyActions {
  /** The choices on "Make your Recovery Key": a printed kit and a second hardware wallet; the NFC card is "coming later". */
  keyOptions(): RecoveryKeyOption[];
  /**
   * Makes key 3 as `setRecoveryKeyKind` says (a printed kit, or a second hardware wallet read through the OS), and gives
   * back the kit to print. Key 3 lives in memory until `confirmKit`; asking again makes a new one. `secondDevice` is the
   * kind of the second hardware wallet to connect.
   */
  makeKit(opts?: { secondDevice?: HardwareKind }): Promise<RecoveryKit>;
  /**
   * The person saved the kit and proved it (typed the asked words, scanned the QR, or said so for a wallet map). Builds
   * the vault, registers it on the hardware wallet and checks its first address there (QR-only devices skip that
   * check), then forgets key 3: only its public key stays on the phone.
   */
  confirmKit(proof: KitProof): Promise<{ fingerprint: string }>;

  /** What approving refills would do: the schedule, the cost and how many times the hardware wallet asks. */
  previewRefills(opts?: { amountSats?: Sats; count?: number }): Promise<RefillPreview>;
  /** The hardware wallet signs every refill (one confirmation each), then one Face ID for the phone. */
  approveRefills(opts?: { amountSats?: Sats; count?: number }): Promise<RefillApproval>;

  /** Speeds up the refill `state.recoveryKey.speedUp` offered (the phone alone signs the extra transaction). */
  speedUp(): Promise<void>;
  /** Hides a banner for good (the next one of its kind shows again). */
  dismissNotice(id: string): void;

  /** The vault's next deposit address, without using it up. */
  vaultAddress(): string;
  /** Shows that address on the hardware wallet and checks it matches. */
  verifyVaultAddress(): Promise<{ address: string; verifiedOnDevice: boolean }>;

  /** Reads a kit (its QR text, or its words) and looks up what the vault holds. Changes nothing. */
  readKit(input: string): Promise<KitInfo>;
  /**
   * Moves everything the kit's vault holds. `hardware`: the kit and the hardware wallet, on a new phone (this phone has
   * no wallet yet). `phone`: the kit and this phone, because the hardware wallet is gone. A new vault shows the new kit
   * through `confirmNewKit` and moves nothing until it returns a proof (or `false` to stop).
   */
  recoverWithKit(opts: {
    kit: string;
    with: 'hardware' | 'phone';
    destination: KitDestination;
    confirmNewKit?: (kit: RecoveryKit) => Promise<KitProof | false>;
  }): Promise<KitRecoveryResult>;
  /** The kit is lost (or was seen): this phone and the hardware wallet move everything to a new vault with a new kit. */
  replaceKit(opts: { confirmNewKit: (kit: RecoveryKit) => Promise<KitProof | false> }): Promise<KitRecoveryResult>;

  /** The amount and count a new batch of refills starts with. */
  setRefillDefaults(defaults: { amountSats: Sats; count: number }): void;
  /** Asks the server at `url` for the chain's height and checks it is on this wallet's network. Changes nothing. */
  testServer(url: string): Promise<ServerCheck>;
  /** Reads the chain from `url` from now on, or from the default server for the network when `null`. */
  setServer(url: string | null): Promise<void>;
}
