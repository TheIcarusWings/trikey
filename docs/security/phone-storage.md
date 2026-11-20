# What the phone app keeps, and where

Written 2026-11-10, after Binance's warning about "worse_query", an iOS bug that lets a malicious app read other apps'
files. It lists everything the Trikey app keeps on a phone, where each piece lives, and what someone who can read the app's
files learns. For the design behind it see DESIGN.md ("Mobile app", "Threat model").

## Two places

1. **The secure store** (`apps/mobile/src/platform/secure-key-store.ts`, on `expo-secure-store`):
   - On iOS, the Keychain. On Android, values encrypted under a key in the Android Keystore.
   - Every item is `WHEN_UNLOCKED_THIS_DEVICE_ONLY`: never synced to iCloud Keychain, never in a device backup, never
     readable while the phone is locked.
   - Items saved with biometrics need Face ID or a fingerprint each time they are read. iOS binds them to the current
     enrolled faces or fingers; Android binds the Keystore key to them.
   - The Keychain is not a file in the app's folder. It is a system service, and its items are encrypted with keys that
     the Secure Enclave (Android: the Keystore) guards.
2. **The app's files**, inside the app's own folder:
   - a SQLite database (`apps/mobile/src/platform/key-value-store.ts`);
   - a cache folder for files that are being shared or picked.

   The database goes into phone backups (iCloud Backup; Android Auto Backup and device transfer).

## What is where

| What | Where | Behind biometrics | If someone reads it |
|---|---|---|---|
| Key 2 (BIP 39 entropy), or its envelope when the optional security-key lock is on (docs/design/yubikey-key2.md) | Secure store | Yes | One key of three. Phone-only payments stay inside the guardian's daily limit; everything else needs the hardware wallet too |
| The nostr key the phone talks to the guardian with | Secure store | No (background sync needs it) | The phone's identity towards the guardian: it can ask what a paired phone may ask (status, history, a lock). It can't move money: the guardian's signature is one of the two a payment needs, and the other is key 2's |
| The notes key (encrypted labels on the guardian) | Secure store | No | The owner's labels, if the encrypted copy on the guardian is turned on |
| The silent payment scan key and the helper key | Secure store | No | Which silent payments arrived. The helper coin, which is kept small |
| Recovery Key mode: the key that seals its stored state | Secure store | No | Opens the refill chain stored in the database (below) |
| BitBox02 pairing channel key | Secure store | No | Pretending to be this phone to that BitBox02. The device still shows and confirms every request |
| The wallet descriptor (every xpub), the guardian's pairing details, settings | Database | n/a | **Privacy:** every address of the wallet, the balance and the history. No signing power |
| Transaction cache, send log | Database | n/a | Privacy: past payments |
| Labels and frozen coins | Database | n/a | Privacy: what the owner called each payment |
| Recovery Key mode refill chain | Database, encrypted (XChaCha20-Poly1305) under a key from the secure store | n/a | Nothing without the secure store's key (DESIGN.md, Recovery Key mode, "Stored state") |
| A backup file being shared (`.tkb`) | Cache folder, emptied before each share and at every start | n/a | Encrypted under the recovery code (Argon2id) or a passkey: nothing without them |
| A labels file being shared (BIP 329) | Cache folder, emptied the same way | n/a | Privacy: the labels |
| A request or signed file for a microSD device (Passport, Krux) | Picked through the system picker; the copy is read, then deleted | n/a | See DESIGN.md, "Encrypted notes on the guardian", for the signed notes file |

**No seed, private key or recovery code is ever written to the app's files in the clear.** The wallet's code saves key
material only through `SecureKeyStore.save` (packages/wallet/src/wallet.ts and packages/recovery-key/src). Writing the
seed anywhere else would be a bug.

## What a file-reading bug gets

A bug like worse_query, which lets another app read Trikey's files, gets the database and whatever is in the cache folder
at that moment:

- **Privacy is lost.** The descriptor gives every address, so the balance and the history, plus the labels.
- **No money moves.** Nothing in those files can sign: key 2 and the other keys are in the secure store.
- **The descriptor is not a secret for the wallet's safety.** Two keys are needed to spend, and the guardian applies its
  rules to anything signed with key 2.

## What it would take to get key 2

Reading files is not enough. Getting key 2 needs one of these:

- code running inside the Trikey app;
- a bug in the Keychain or Keystore itself, or in the Secure Enclave or Keystore hardware;
- a stolen phone that is both unlocked and past Face ID or the fingerprint.

Even then it is one key of three:
- The guardian co-signs phone-only payments up to the daily limit, so at most that amount can move.
- Raising the limit, changing a rule or starting a recovery needs the hardware wallet, or waits for the Delay & Notify
  period, which alerts the owner every day.
- The optional security-key lock (docs/design/yubikey-key2.md) would add a YubiKey to every use of key 2, once the app has it.

## What users should do about bugs like this

- **Keep iOS and Android up to date.** For worse_query, reports point to iOS 27.2.1 or later. Apple had not named the bug
  when this was written.
- **Remove apps from sources you don't trust**, such as sideloaded or manually signed apps from strangers. A Trikey built
  from this repository's source on your own Mac is not that kind of app.
- **If you think a phone was compromised:**
  - lock the guardian from the phone or the web UI;
  - restore key 2 on a clean phone from the backup or the recovery code;
  - consider "Replace guardian", which moves the coins to a new wallet with new keys, so the old descriptor's addresses
    stop mattering.
