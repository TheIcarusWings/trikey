/**
 * The HTTP API's bodies. `apps/guardian-web/src/api/types.ts` is the source of
 * truth (API.md says so); these are type-only re-exports of it, so the server
 * and the UI cannot drift apart without `npm run typecheck` failing. Nothing
 * is imported at runtime.
 */
export type {
  ActivityEntry,
  ChainStatus,
  GuardianStatus,
  HostingOverview,
  PairedPhone,
  PairingSession,
  RecoveryCode,
  RecoveryInProgress,
  RelayOption,
  RetiredWalletSummary,
  Rules,
  SetupPreflight,
} from '../../../guardian-web/src/api/types.js';
