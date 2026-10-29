import { sdk } from './sdk'

// Nothing is backed up, on purpose. DESIGN.md: the guardian "holds no backup of key 3"; if the box
// dies, the phone and the hardware wallet sweep to a new wallet with a fresh guardian ("Replace
// guardian"). The `main` volume holds key 3's encrypted keystore, so a StartOS backup of it would
// be exactly such a backup. A restored copy would also carry old daily-limit accounting and
// recovery state. The `startos` volume holds only the web interface password, which the user
// sets again after a restore.
//
// TODO(decision): the maintainers must confirm this. If StartOS backups of the guardian are
// wanted, change this to sdk.Backups.ofVolumes('main') and update instructions.md and README.md.
export const { createBackup, restoreInit } = sdk.setupBackups(async () =>
  sdk.Backups.ofSyncs(),
)
