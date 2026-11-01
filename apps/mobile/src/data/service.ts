import type {
  WalletDetails,
  BackupOptions,
  FeeSpeed,
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
  ReplaceGuardianPlan,
  ReplaceGuardianResult,
  RestoreUnlock,
  ScannedCode,
  InviteView,
  SendQuote,
  SendRequest,
  Sats,
  ThemePreference,
  AmountUnit,
  Transaction,
  WalletMode,
  WalletState,
} from './types';
import type { RecoveryKeyActions } from './rk-actions';
import type { SilentPaymentActions } from './sp-actions';
import type { SavingsActions } from './savings-actions';

export type { RecoveryKeyActions, SilentPaymentActions, SavingsActions };

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
  /**
   * Picks the network of the wallet to be created. Only before the wallet exists. Mainnet only in guardian mode; another
   * network than before clears `mainnetRiskAccepted`.
   */
  setNetwork(network: NetworkName): void;
  /**
   * The person ticked (or unticked) "I understand" under the mainnet warning. Until it is ticked, the guardian mode makes
   * no wallet on mainnet: `connectHardware`, a recovery and a restore fail with kind `wrong_state`.
   */
  acceptMainnetRisk(accepted: boolean): void;
  /** The hardware wallets this phone can talk to. */
  getHardwareOptions(): Promise<HardwareOption[]>;
  connectHardware(kind: HardwareKind): Promise<HardwareWallet>;
  /** Called with whatever the pairing QR code contained. */
  pairGuardian(pairingCode: string): Promise<Guardian>;
  /**
   * A host's invite (docs/design/family-hosting.md): reads it and keeps it for onboarding (`state.invite`). Nothing is
   * sent. Then `acknowledgeInvite(true)` once the person ticked the disclosure, and `setUpRules` accepts it with the rules.
   * Guardian mode only (the others leave these out).
   */
  readInvite?(code: string): InviteView;
  /** The person ticked (or unticked) "I understand <host> could help a thief skip the wait". */
  acknowledgeInvite?(understood: boolean): void;
  /** A hosted wallet's own chain server (an Esplora URL), or null for the public one. */
  setHostedChainServer?(url: string | null): Promise<void>;
  /**
   * The alert contacts chosen during onboarding, before pairing. Kept on the phone until `setUpRules`, which sends
   * them with the first rules (the guardian refuses pairing without one on mainnet). Replaces any earlier list;
   * `[]` clears it. Throws `invalid_input` for a key that is not an npub.
   */
  setOnboardingContacts(contacts: { name: string; npub: string }[]): void;
  /** Registers the daily limit, recovery wait and onboarding contacts with the guardian; hardware-approved. Must follow `pairGuardian` within the code's lifetime. */
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
  /**
   * "Send max": the most that can be sent to `address` at `speed` (the confirmed balance minus the fee), from the last
   * sync, with no I/O. On success the quote carries the amount in `request.amountSats` and `max: true`, and goes to
   * `sendPayment` like any quote: it spends every coin, with no change, signed by the keys its `plan` names.
   * Fails with `amount_too_small` when the balance minus the fee is below the smallest payment, `insufficient_funds`
   * when there is nothing to send, `needs_helper` for a silent payment address when the helper coin is missing, and
   * `other` where it is not available yet (Recovery Key mode).
   */
  quoteSendMax(request: { address: string; speed: FeeSpeed }): QuoteOutcome;
  /** The wallet descriptor and key fingerprints, to recover in another wallet; `null` until the wallet is set up. */
  getWalletDetails(): WalletDetails | null;
  /** Signs with whichever keys the quote's plan names, then broadcasts. */
  sendPayment(quote: SendQuote): Promise<Transaction>;
  /** The next unused address. With `verifyOnDevice` the hardware wallet shows it too and it must match. */
  receiveAddress(opts?: { verifyOnDevice?: boolean }): Promise<ReceiveAddress>;

  // -- guardian --------------------------------------------------------
  /** Unlocks a guardian that restarted. The passphrase is used once and never stored. */
  unlockGuardian(passphrase?: string): Promise<void>;
  /** Locks the guardian from this phone (key 3 leaves its memory until someone unlocks it with the passphrase). */
  lockGuardian(): Promise<void>;
  /**
   * "Replace guardian", after scanning the new guardian's pairing code: what will happen, in plain steps. Changes
   * nothing. The plan is also in `state.replace.plan` until the move runs or is cancelled.
   */
  previewReplaceGuardian(pairingCode: string): Promise<ReplaceGuardianPlan>;
  /**
   * Runs the move to the new guardian (or goes on with one that started). Rejects with kind `guardian_unreachable`
   * when the old guardian does not answer and `oldGuardianGone` was not confirmed.
   */
  replaceGuardian(opts?: { oldGuardianGone?: boolean }): Promise<ReplaceGuardianResult>;
  /** Forgets a scanned plan, or a move that paired but signed nothing yet. */
  cancelReplaceGuardian(): Promise<void>;
  /** Moves coins sent to an old wallet (after "Replace guardian") into this one, with the hardware wallet. */
  sweepOldWallets(): Promise<{ movedSats: Sats }>;
  /** The old guardian is back: retire the old wallet there, with the hardware wallet. */
  retireOldWallet(): Promise<void>;
  /** After a recovery moved the wallet: the hardware wallet registers it, shows its first address and confirms its key. */
  confirmHardware(): Promise<void>;

  // -- scanning ----------------------------------------------------------
  /** What a camera or paste field read: a pairing or recovery code, an address, a PSBT, a nostr key. Checked against the wallet's network. */
  readCode(text: string): ScannedCode;

  // -- rules (the guardian enforces them) ------------------------------
  /** Raising the limit needs the hardware wallet, lowering it does not. With the limit off, any limit turns it back on from the phone alone. */
  setDailyLimit(limitSats: Sats): Promise<void>;
  /**
   * No daily limit: the phone and the guardian together can then send everything. Needs the hardware wallet (it signs a
   * text that says `limit=off`), and a guardian that supports it (`dailyLimit.canTurnOff`); refused during a recovery.
   * The guardian tells this phone and every alert contact.
   */
  turnLimitOff(): Promise<void>;
  /** Lengthening the wait works from the phone, shortening it needs the hardware wallet. */
  setRecoveryDelay(days: RecoveryDelayDays): Promise<void>;
  /**
   * Lets the alert contacts lock the guardian (`true`: from this phone alone) or stops them (`false`: needs the hardware
   * wallet, which signs a text that says `lock=off`). Only where `state.contactLock.supported`; otherwise it rejects with
   * kind `not_available`. The guardian tells the contacts either way.
   */
  setContactLock(on: boolean): Promise<void>;
  /** Needs the hardware wallet. */
  addContact(name: string, npub: string): Promise<Contact>;
  removeContact(id: string): Promise<void>;

  // -- recovery --------------------------------------------------------
  /** A backup in the given provider (default: wherever the wallet can look). */
  findBackup(provider?: CloudProvider): Promise<FoundBackup | null>;
  /** Lets the person choose a backup file, and makes it available to `findBackup`. Null if they cancelled. */
  importBackupFile(): Promise<FoundBackup | null>;
  /**
   * Restores the backup that `findBackup` found. A backup for another network than the phone's is refused with kind
   * `network_mismatch` unless `switchNetwork` (the person agreed to switch).
   */
  restoreFromBackup(unlock?: RestoreUnlock, provider?: CloudProvider, opts?: { switchNetwork?: boolean }): Promise<void>;
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
  /** What key 3 will be: a printed kit or a second hardware wallet (`nfc` is not available yet). Used by `rk.makeKit`. */
  setRecoveryKeyKind(kind: RecoveryKeyKind): void;
  /**
   * Recovery Key mode's own actions: the kit, the refills, the vault, recovery with the kit and the chain server. Only
   * a wallet that can run Recovery Key mode has them (the demo and the real wallet in that mode).
   */
  readonly rk?: RecoveryKeyActions;
  /**
   * Silent payments (BIP 352): turning them on and off, the address and its labels, the helper coin's address, checking for
   * payments and moving what was received into the vault. The guardian mode's wallet and the demo have them; Recovery Key mode
   * sends them through `quoteSend`/`sendPayment` like any payment and cannot receive them yet (`state.silentPayments.support`).
   */
  readonly silentPayments?: SilentPaymentActions;
  /**
   * The optional Savings wallet (docs/design/savings-and-limit-off.md): create it, receive, move money out with two of
   * its keys, replace a lost key. The guardian mode's wallet and the demo have it (`state.savings.status` says whether it
   * can be used now); Recovery Key mode does not.
   */
  readonly savings?: SavingsActions;
  /**
   * Makes a quote exact when the wallet needs the chain for it (Recovery Key mode picks the coins). Optional: the
   * quote `quoteSend` gave stays valid, with `estimate: true`. Screens that show the final fee call it.
   */
  refineQuote?(quote: SendQuote): Promise<QuoteOutcome>;

  // -- preferences -----------------------------------------------------
  setUnit(unit: AmountUnit): void;
  setTheme(theme: ThemePreference): void;
  /**
   * Before a wallet exists: which kind onboarding makes (guardian, or Recovery Key mode for "No home server?"). Once a
   * wallet exists the phone runs that one, and this does nothing, except in the demo, which shows either home.
   */
  setMode(mode: WalletMode): void;

  // -- hardware prompts --------------------------------------------------
  /** The person gave up waiting for the device: stop waiting for it. */
  cancelDevicePrompt(): void;

  // -- development -----------------------------------------------------
  /** Settings > Developer shows the ones that exist. */
  dev?: {
    setGuardianStatus?(status: GuardianStatus): void;
    simulateRecoveryFromElsewhere?(): void;
    /** The demo's recovery, followed from the new phone (`recovering`): its access to the guardian runs out (`recovery.accessExpired`); call again to renew it. */
    simulateRecoveryAccessExpiry?(): void;
    /** The demo's recovery (started on this phone) gets a coin in the old wallet; each call steps `recovery.sweepUpdate` through waiting, added (the move grows) and refused. */
    simulateRecoveryCoin?(): void;
    /** The demo's recovery ends now: the guardian takes the new wallet over. */
    finishRecovery?(): void;
    /** Simulator: swaps the simulated hardware wallet for a new one (to try "Lost my hardware wallet"). Returns its fingerprint. */
    useNewSimulatedDevice?(): string;
    restartOnboarding?(): void;
    /** The demo's Recovery Key home shows what it does when a refill this phone did not send appears, and when one is stuck. */
    simulateRecoveryKeyAlerts?(): void;
    /** The demo's guardian has its node's RPC (or not: receiving silent payments is then paused, as on a guardian answering 1700). */
    setNodeRpc?(available: boolean): void;
    /** The demo's helper coin is funded, or not yet. */
    setHelperFunded?(funded: boolean): void;
    /** The demo: an alert contact (Maria) locks the guardian with LOCK, if the setting is on. */
    simulateContactLock?(): void;
    /** The demo: Savings set up and holding money (`true`), or no Savings at all (`false`), to look at either Home. */
    setDemoSavings?(on: boolean): void;
    /** Removes the wallet's keys and data from this phone (this mode and network only). */
    forgetWallet?(): Promise<void>;
    /** Facts about the setup, for the developer ("device fingerprint ..."). */
    info?(): string[];
    /** Simulator, Recovery Key mode: the simulated chain on the developer's computer (docs/dev-regtest.md). */
    simChain?: {
      /** Mines blocks (to unlock a refill, mine 1,008). */
      mine(blocks: number): Promise<{ height: number }>;
      /** Pays `sats` to the vault's next deposit address or the spending balance's receive address, and mines a block. */
      fund(target: 'vault' | 'spending', sats: Sats): Promise<{ address: string; height: number }>;
    };
  };
}
