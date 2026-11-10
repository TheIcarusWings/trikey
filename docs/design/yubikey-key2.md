# A YubiKey lock for key 2: design proposal

Status: accepted. Step 2 (wallet core) is built; the app doesn't offer it yet. Written 2026-11-10, against `main` at 0.1.26.

The owner asked whether key 2 (the phone key) could be swapped for a YubiKey, or at least encrypted by one so that
the YubiKey is needed for every payment. The answer is the second: an **optional** lock, **off by default**, that a
person turns on in Settings. Nothing changes for anyone who leaves it off.

## 1. Why the YubiKey can't *be* key 2

A YubiKey 5's OpenPGP applet can hold a secp256k1 key (firmware 5.2.3 and later,
[Yubico](https://developers.yubico.com/PGP/YubiKey_5.2.3_Enhancements_to_OpenPGP_3.4.html)) and sign a hash with it.
That isn't enough to replace key 2:

- **One fixed key, no BIP32.** Key 2 is an xpub in the wallet's descriptor, and every address derives its own child
  key. A fixed key in the descriptor is refused by the hardware wallets that register multisig policies (Ledger's
  wallet policies and the Coldcard both expect an xpub for every key), so key 1 could not join the wallet. It would also
  put the same public key in every spend, linking all of the wallet's addresses.
- **Key 2 is more than one key.** The same seed gives the Savings key (`wallet.ts`, "Set up Savings") and the silent
  payment spend key ("Set up silent payments").
- **No backup.** A key generated on the YubiKey can't be copied out. One imported from a seed has a backup but loses
  what made the YubiKey attractive.
- **No screen.** It would sign whatever hash the phone sent. The phone is still the only display, as today.

So key 2 stays a BIP39 seed on the phone, and the YubiKey becomes a second lock on it.

## 2. What it adds, and what it doesn't

Today key 2's seed sits in the Secure Enclave / Android Keystore store behind biometrics
(`apps/mobile/src/platform/secure-key-store.ts`, DESIGN.md "Mobile app"). With the lock on, the store holds the seed
**encrypted under a key only the YubiKey can give**, and the biometric prompt still guards the ciphertext.

| Situation | Today | With the lock |
|---|---|---|
| Phone stolen while unlocked, or a biometric bypass | Key 2 can sign (the guardian's limit and the hardware key still apply) | Key 2 needs the YubiKey too, and its PIN |
| Phone stolen with the YubiKey on the same keyring | Biometrics | Biometrics plus the YubiKey's PIN (8 wrong tries block it, and only a reset that erases its credentials unblocks it) |
| Forensic copy of the phone's storage | Protected by the secure element | The same, plus a second layer that isn't on the phone at all |
| Malware running inside the app while you sign | Can read the seed | **Still can**: the seed is decrypted in the app's memory to sign. The lock is about theft, not malware |
| Seeing what you sign | Phone screen | Phone screen (the YubiKey has none) |
| The guardian's daily limit, delays and hardware approvals | Unchanged | Unchanged: the guardian doesn't know or care |

The lock covers key 2's seed only. The keys that are deliberately kept **without** biometrics so that background work
runs without a prompt (the nostr key, the silent payment scan and helper keys, the notes key) stay as they are.

## 3. The cost to the person who turns it on

- **A tap for every payment**, including small ones inside the daily limit: Face ID / fingerprint, then "Hold your
  YubiKey to the phone" (NFC) or plug it in (USB-C).
- **Two YubiKeys are strongly suggested** (a main and a spare). Setup asks for the second one and says why.
- **Losing the YubiKey doesn't lose funds.** The recovery code and the phone backup (`.tkb`) restore key 2 on any phone
  without a YubiKey (section 6). That's by design: the recovery code is kept offline on paper.

## 4. How the YubiKey gives the key: three ways

| | 1. FIDO2 PRF through the phone's passkey screen | 2. PIV key agreement, our own APDUs | 3. HMAC-SHA1 challenge-response |
|---|---|---|---|
| Who talks to the YubiKey | iOS / Android's own security-key sheet | The app, over NFC (`react-native-nfc-manager`, already a dependency) or USB | The app, over NFC or USB |
| PIN | FIDO2 PIN (PRF needs user verification) | PIV PIN, 3 tries then the PUK | None: a tap only |
| YubiKeys | YubiKey 5 and Security Key series | YubiKey 5 only | YubiKey 5 (slot configured with `ykman`) |
| iPhone built with a free Apple ID | **Works**: the system sheet handles NFC/USB, no NFC entitlement needed | **No**: NFC needs a capability a free account can't sign (`apps/mobile/app.config.ts`, `iosNfc`) | No, same reason |
| Android without Google Play services (FOSS on a de-Googled phone) | No: the passkey screen is Credential Manager | Yes | Yes |
| Code we already have | The backup's `passkey-prf` slot (`packages/wallet/src/backup.ts`) and `react-native-passkey` | NFC sessions (`apps/mobile/src/hardware/nfc`), but NDEF only today, not ISO 7816 | Same |
| Known gaps | `react-native-passkey` 3.6.2 sends PRF only on **platform** requests on iOS (`configureCreatePlatformRequest`), not on the security-key ones: it needs a patch. Whether Android returns PRF from an external key over NFC is unconfirmed | APDU code to write and test (SELECT, VERIFY, GENERATE ASYMMETRIC, GENERAL AUTHENTICATE) | No PIN, SHA-1 HMAC |

**Proposal: build way 1 first, and way 2 for Android if way 1 fails there or for phones without Google.** Way 3 isn't
worth a PIN-less design when ways 1 and 2 exist.

## 5. The format

One envelope replaces the raw seed in the secure store under the same id (`secrets.key2`), still saved with
`requireBiometrics: true`:

```
key2-lock envelope, version 1 (JSON, then the store's usual encoding)
  v: 1, kind: "trikey-key2-lock"
  walletId, key2Fingerprint      (the BIP32 fingerprint of key 2, to check the result)
  nonce, ciphertext              (XChaCha20-Poly1305 of the BIP39 entropy under DK,
                                  associated data = "trikey/key2-lock/v1" || walletId || key2Fingerprint)
  slots: 1 to 3, each wraps DK:
    fido-prf:  credentialId, rpId, aaguid, label, prfSalt (32 B), hkdfSalt (32 B), nonce, wrappedKey
               KEK = HKDF-SHA256(PRF output, hkdfSalt, "trikey/key2-lock/fido-prf/v1", 32)
    piv-ecdh:  serial, slot ("9d"), cardPub (P-256), ephemeralPub, label, hkdfSalt, nonce, wrappedKey
               KEK = HKDF-SHA256(ECDH(card key, ephemeral key), hkdfSalt, "trikey/key2-lock/piv-ecdh/v1", 32)
```

- **DK** is 32 bytes from `secureRandomBytes`, new each time the lock is turned on. Every slot wraps the same DK, so
  a spare YubiKey is another slot, not another copy of the seed.
- **The check after unwrapping:** the decrypted entropy must give `key2Fingerprint`. A wrong key fails at the AEAD,
  and a right key with the wrong wallet fails here.
- **Zeroing:** DK, the KEK, the PRF output and the entropy are zeroed in `finally`, as `withKey2` already does for
  the entropy.
- **Telling the two apart:** raw entropy is 16 or 32 bytes, and the envelope is JSON with `kind`. A phone that never
  turned the lock on reads exactly as today.

## 6. Where it plugs in

Every use of key 2 already goes through one function, `withKey2(reason, fn)` in `packages/wallet/src/wallet.ts`
(payments, fee bumps, recoveries, Savings, moving to a new guardian, the backup). The lock lives there:

1. `secureStore.load(secrets.key2, reason)`: the biometric prompt, as today.
2. If the result is an envelope: `deps.securityKey.unwrap(envelope.slots, reason)` (a new platform interface beside
   `PasskeyPrf` in `packages/wallet/src/platform.ts`) shows "Hold your YubiKey to the phone", gets the KEK from
   whichever enrolled YubiKey answers, and returns DK.
3. Decrypt, check the fingerprint, zero, then `fn(mnemonic)` as today.

No call site changes, nothing changes on the guardian or in the protocol, and the wallet's descriptor and addresses
stay the same.

- **Turning it on** (Settings, Security, "Require a YubiKey to sign"; only shown where the platform supports a way
  from section 4): the biometric prompt, enrol the main YubiKey, enrol a spare (or skip, with a warning), then one test
  unlock before the plain seed is replaced. A crash part way leaves the old entry: the envelope is written in one
  `save`.
- **Turning it off:** needs an enrolled YubiKey (otherwise the lock would mean nothing). The seed goes back to the
  plain biometric entry.
- **Adding or removing a spare:** needs an enrolled YubiKey to get DK.
- **The phone backup** (`withKey2('Back up your phone key', ...)`) unwraps as any other use, and the `.tkb` holds the
  plain key 2 under the recovery code / passkey, as today. The lock is a setting of this phone, not of the backup.
- **Restoring on a new phone** gives the plain seed; the app then offers to turn the lock on again.
- **Every wallet on the phone:** one setting for the phone, covering each wallet's key 2. Turning it on wraps all of
  them; a wallet added later is wrapped as it is saved.

## 7. What can go wrong

| Event | What happens |
|---|---|
| The YubiKey is lost or broken | The spare unlocks. Without one: restore key 2 from the recovery code or the backup (the lock is off on the restored phone), then turn it on again with new YubiKeys |
| FIDO2 PIN blocked, or a FIDO reset | The FIDO credential is gone: as lost. (PIV: the PUK can unblock the PIN first) |
| A synced passkey chosen instead of the YubiKey (way 1) | Setup asks for a security key only (`forceSecurityKey`) and shows the authenticator's name from its AAGUID. A synced passkey would still be a second factor, but not the one the person asked for |
| The phone's OS update changes PRF behaviour | Unlock fails with a clear message. The recovery code still restores key 2. The alpha test plan gets a step for it |
| The person forgets the lock exists and sells the YubiKey | The same as lost: the recovery code restores |

## 8. Plan

1. **Spike (an hour, no code):** the owner tries `trikey.app/passkey-test` with a YubiKey over NFC, in Chrome on the
   Pixel and in Safari on the iPhone, picking the security-key option in the browser's sheet ("Use a security key" or
   "Other options"). Both browsers sit on the same system FIDO stack the app would use. If PRF comes back on both,
   way 1 is open.
2. **Wallet core (done):** the envelope, `SecurityKeyUnlock` in `platform.ts`, `withKey2` and the settings flows, with unit
   tests (wrong key, wrong wallet, two slots, crash between steps, zeroing). Built in `packages/wallet/src/key2-lock.ts`
   and `wallet.ts` (`turnOnKey2Lock`, `turnOffKey2Lock`, `addKey2LockKey`, `removeKey2LockKey`, and the same on
   `WalletSet`). The envelope's `walletId` names the phone's key 2 entry (from its secure store id), not the descriptor's
   wallet id, which changes with "Replace guardian" and a recovery while key 2 stays the same.
3. **Mobile, way 1:** patch `react-native-passkey` so the iOS security-key requests carry PRF (iOS 18+ API), and use
   `forceSecurityKey`. Same RP ID as the backup passkey (`EXPO_PUBLIC_PASSKEY_RP_ID`), a separate credential.
4. **Mobile, way 2 (if needed):** ISO 7816 over NFC on Android (and USB CCID), PIV slot 9d with PIN policy "always"
   and touch policy "cached".
5. **Docs:** DESIGN.md (key 2 at rest), the alpha test plan (turn it on, pay, lose the main key, use the spare,
   restore without either), and `docs/security/review-brief.md`.

Not a gate for 0.2.0-beta.

## 9. Open questions for the owner

- **Every payment, or only above an amount?** This proposal asks for the YubiKey on every use of key 2. A threshold
  would need the seed decryptable without the YubiKey for small payments, which undoes the lock.
- **One setting for the phone, or per wallet?** Proposed: one for the phone (section 6).
- **Way 2 on the iPhone** waits for a paid Apple account, if way 1 doesn't work there.
