import type {
  BackupOptions,
  Contact,
  CloudProvider,
  Guardian,
  GuardianAddress,
  GuardianStatus,
  HardwareKind,
  HardwareOption,
  HardwareWallet,
  FoundBackup,
  LostKey,
  NetworkName,
  PhoneBackup,
  QuoteOutcome,
  RecoveryDelayDays,
  RecoveryInProgress,
  RecoveryKeyKind,
  RestoreUnlock,
  SendQuote,
  SendRequest,
  Sats,
  ThemePreference,
  AmountUnit,
  Transaction,
  WalletMode,
  WalletState,
} from './types';

export interface ReceiveAddress {
  address: string;
  /** The hardware wallet showed this address and it matched. */
  verifiedOnDevice: boolean;
}

/**
 * Everything the screens ask of the wallet. The mock in ./mock.ts implements it with demo data and timers; the real
 * wallet in ./real.ts implements it on `@trikey/wallet`.
 *
 * Methods that wait on a person or a device ("Approve on Ledger", the passkey sheet) return promises. The UI shows a
 * waiting state until they settle. When something fails they reject with a `WalletServiceError` (./errors.ts) whose
 * message is written for the user. A method with no wallet code behind it yet rejects with kind `not_available`:
 * it never pretends to have worked.
 */
export interface WalletService {
  // -- state -----------------------------------------------------------
  getState(): WalletState;
  /** useSyncExternalStore-style: returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** The wallet's idea of "now". The mock freezes it so the demo data stays put. */
  now(): Date;
  /** How often screens should re-read `now()`. 0 or missing: never (the mock's frozen clock). */
  readonly clockTickMs?: number;
  /** Asks the guardian for the wallet's coins and history. Resolves when done; a guardian that does not answer is shown as offline. */
  sync(): Promise<void>;

  // -- onboarding ------------------------------------------------------
  /** Picks the network of the wallet to be created. Only before the wallet exists. */
  setNetwork(network: NetworkName): void;
  /** The hardware wallets this phone can talk to. */
  getHardwareOptions(): Promise<HardwareOption[]>;
  connectHardware(kind: HardwareKind): Promise<HardwareWallet>;
  /** Called with whatever the pairing QR code contained. */
  pairGuardian(pairingCode: string): Promise<Guardian>;
  /** Registers the daily limit and recovery wait with the guardian; hardware-approved. Must follow `pairGuardian` within the code's lifetime. */
  setUpRules(limitSats: Sats, delayDays: RecoveryDelayDays): Promise<void>;
  getBackupOptions(): Promise<BackupOptions>;
  createBackup(provider: CloudProvider): Promise<PhoneBackup>;
  /** The recovery code of the backup just made. Shown once; `dismissRecoveryCode` forgets it. */
  recoveryCode(): string | null;
  dismissRecoveryCode(): void;
  /** Hands the backup file to the OS share sheet (Files, AirDrop, mail to yourself). */
  exportBackupFile(): Promise<void>;
  finishOnboarding(mode?: WalletMode): void;

  // -- sending and receiving -------------------------------------------
  /** From the last sync; no I/O. */
  quoteSend(request: SendRequest): QuoteOutcome;
  /** Signs with whichever keys the quote's plan names, then broadcasts. */
  sendPayment(quote: SendQuote): Promise<Transaction>;
  /** The next unused address. With `verifyOnDevice` the hardware wallet shows it too and it must match. */
  receiveAddress(opts?: { verifyOnDevice?: boolean }): Promise<ReceiveAddress>;

  // -- guardian --------------------------------------------------------
  /** Unlocks a guardian that restarted. The passphrase is used once and never stored. */
  unlockGuardian(passphrase?: string): Promise<void>;
  lockGuardian(): Promise<void>;
  /** Sweeps to a new wallet paired with a new guardian. */
  replaceGuardian(pairingCode: string): Promise<void>;

  // -- rules (the guardian enforces them) ------------------------------
  /** Raising the limit needs the hardware wallet, lowering it does not. */
  setDailyLimit(limitSats: Sats): Promise<void>;
  /** Lengthening the wait works from the phone, shortening it needs the hardware wallet. */
  setRecoveryDelay(days: RecoveryDelayDays): Promise<void>;
  /** Needs the hardware wallet. */
  addContact(name: string, npub: string): Promise<Contact>;
  removeContact(id: string): Promise<void>;

  // -- recovery --------------------------------------------------------
  /** A backup in the given provider (default: wherever the wallet can look). */
  findBackup(provider?: CloudProvider): Promise<FoundBackup | null>;
  /** Lets the person choose a backup file, and makes it available to `findBackup`. Null if they cancelled. */
  importBackupFile(): Promise<FoundBackup | null>;
  restoreFromBackup(unlock?: RestoreUnlock, provider?: CloudProvider): Promise<void>;
  recoverWithKit(): Promise<{ movedSats: Sats }>;
  /**
   * `hardware`: this phone and the guardian move everything to a new hardware wallet (it connects `hardwareKind`).
   * `phone`: on a NEW phone, the hardware wallet and the guardian (found at `guardian`) do it.
   */
  startRecovery(lostKey: LostKey, opts?: { guardian?: GuardianAddress; hardwareKind?: HardwareKind }): Promise<RecoveryInProgress>;
  acknowledgeRecovery(): void;
  cancelRecovery(): Promise<void>;
  /** After a contested cancel: the hardware wallet re-enables phone payments. */
  resumePhoneSpending(): Promise<void>;
  /** A recovering phone's access to the guardian lasts a day; the hardware wallet renews it. */
  renewRecoveryAccess(): Promise<void>;

  // -- Recovery Key mode -----------------------------------------------
  setRecoveryKeyKind(kind: RecoveryKeyKind): void;
  /** Approves a batch of weekly refills on the hardware wallet. */
  approveRefills(amountSats: Sats): Promise<void>;

  // -- preferences -----------------------------------------------------
  setUnit(unit: AmountUnit): void;
  setTheme(theme: ThemePreference): void;
  /** Switches between the guardian home and the Recovery Key home. */
  setMode(mode: WalletMode): void;

  // -- hardware prompts --------------------------------------------------
  /** The person gave up waiting for the device: stop waiting for it. */
  cancelDevicePrompt(): void;

  // -- development -----------------------------------------------------
  /** Settings > Developer shows the ones that exist. */
  dev?: {
    setGuardianStatus?(status: GuardianStatus): void;
    simulateRecoveryFromElsewhere?(): void;
    restartOnboarding?(): void;
    /** Removes the wallet's keys and data from this phone (this mode and network only). */
    forgetWallet?(): Promise<void>;
    /** Facts about the setup, for the developer ("device fingerprint ..."). */
    info?(): string[];
  };
}
