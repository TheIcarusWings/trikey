import type {
  Contact,
  CloudProvider,
  Guardian,
  GuardianStatus,
  HardwareKind,
  HardwareWallet,
  LostKey,
  PhoneBackup,
  RecoveryDelayDays,
  RecoveryInProgress,
  RecoveryKeyKind,
  SendQuote,
  SendRequest,
  Sats,
  ThemePreference,
  AmountUnit,
  Transaction,
  WalletMode,
  WalletState,
} from './types';

/**
 * Everything the screens ask of the wallet. The mock in ./mock.ts implements it
 * with demo data and timers; the real wallet (descriptors, PSBTs, hardware and
 * guardian transports) implements the same interface later.
 *
 * Methods that wait on a person or a device ("Approve on Ledger", the passkey sheet)
 * return promises. The UI shows a waiting state until they settle and shows an
 * error if they reject.
 */
export interface WalletService {
  // -- state -----------------------------------------------------------
  getState(): WalletState;
  /** useSyncExternalStore-style: returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** The wallet's idea of "now". The mock freezes it so the demo data stays put. */
  now(): Date;

  // -- onboarding ------------------------------------------------------
  connectHardware(kind: HardwareKind): Promise<HardwareWallet>;
  /** Called with whatever the pairing QR code contained. */
  pairGuardian(pairingCode: string): Promise<Guardian>;
  /** Registers the daily limit and recovery wait with the guardian; hardware-approved. */
  setUpRules(limitSats: Sats, delayDays: RecoveryDelayDays): Promise<void>;
  createBackup(provider: CloudProvider): Promise<PhoneBackup>;
  finishOnboarding(mode?: WalletMode): void;

  // -- sending and receiving -------------------------------------------
  quoteSend(request: SendRequest): SendQuote;
  /** Signs with whichever keys the quote's plan names, then broadcasts. */
  sendPayment(quote: SendQuote): Promise<Transaction>;

  // -- guardian --------------------------------------------------------
  unlockGuardian(): Promise<void>;
  lockGuardian(): void;
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
  restoreFromBackup(): Promise<void>;
  recoverWithKit(): Promise<{ movedSats: Sats }>;
  startRecovery(lostKey: LostKey): Promise<RecoveryInProgress>;
  acknowledgeRecovery(): void;
  cancelRecovery(): Promise<void>;

  // -- Recovery Key mode -----------------------------------------------
  setRecoveryKeyKind(kind: RecoveryKeyKind): void;
  /** Approves a batch of weekly refills on the hardware wallet. */
  approveRefills(amountSats: Sats): Promise<void>;

  // -- preferences -----------------------------------------------------
  setUnit(unit: AmountUnit): void;
  setTheme(theme: ThemePreference): void;
  /** Switches between the guardian home and the Recovery Key home. */
  setMode(mode: WalletMode): void;

  // -- development -----------------------------------------------------
  /** Only the mock implements these; the screens show them under Settings > Developer. */
  dev?: {
    setGuardianStatus(status: GuardianStatus): void;
    simulateRecoveryFromElsewhere(): void;
    restartOnboarding(): void;
  };
}
