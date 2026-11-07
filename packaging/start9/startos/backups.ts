import { sdk } from './sdk'

// Nothing is backed up, on purpose. DESIGN.md: the guardian "holds no backup of key 3"; if the box
// dies, the phone and the hardware wallet sweep to a new wallet with a fresh guardian ("Replace
// guardian"). The `main` volume holds key 3's encrypted keystore, so a StartOS backup of it would
// be exactly such a backup. A restored copy would also carry old daily-limit accounting and
// recovery state. The `startos` volume holds only the web interface password, which the user
// sets again after a restore.
//
// Decided (2026-11-07, the owner): no backup, here and on Umbrel, whose package leaves the guardian's
// data folder out of umbrelOS backups the same way (packaging/umbrel/trikey-guardian/umbrel-app.yml,
// backupIgnore). DESIGN.md, "The platforms' backups leave the guardian out". A restored server starts
// an empty guardian, and the owner uses Replace guardian from the phone with the hardware wallet.
export const { createBackup, restoreInit } = sdk.setupBackups(async () =>
  sdk.Backups.ofSyncs(),
)
