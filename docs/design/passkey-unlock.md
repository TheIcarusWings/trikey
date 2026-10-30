# Passkey unlock for the guardian: design proposal

Status: proposal, not built. Written 2026-10-30, against `main` at the October 2026 entropy review.

The owner asked to "allow the guardian to just use a passkey from Proton or any other password
manager". Today one passphrase does two jobs:

- it signs a browser in to the web UI (`POST /api/session`, `apps/guardian/src/http/sessions.ts`);
- it decrypts key 3 after every restart, because the guardian always starts locked
  (`apps/guardian/src/keystore.ts`: Argon2id, then XChaCha20-Poly1305 over the 64-byte seed).

This proposal covers what a passkey can take over, what it cannot, and what it needs first.

## 1. The hard constraint: passkeys need HTTPS and a domain

- **Secure context.** The WebAuthn interfaces are only exposed in a secure context: an `https://`
  page with a certificate the browser trusts, or `http://localhost` / `127.0.0.1`
  ([WebAuthn L3](https://www.w3.org/TR/webauthn-3/), [Secure Contexts](https://www.w3.org/TR/secure-contexts/)).
  The guardian is reached today at `http://umbrel.local:<port>` through Umbrel's `app_proxy`, plain
  HTTP on the LAN. That page cannot create or use a passkey at all. Clicking through a certificate
  warning does not help either: browsers refuse WebAuthn on a page with a certificate error.
- **The RP ID is a domain, not an origin.** A passkey belongs to a relying-party ID, which must equal
  the page's host or be a registrable suffix of it. It cannot be an IP address. A passkey made at one
  host does not work at another, so **each access path needs its own passkey**. The port is not part
  of the RP ID: every app served on the same host name shares the same RP ID.
- **No shortcut through trikey.app.** WebAuthn Related Origin Requests would let a passkey for
  `trikey.app` be used on other origins listed in a file on `trikey.app`. That would mean listing every
  user's guardian address on our site and making our site part of every unlock. It conflicts with "we
  run nothing", and it still needs HTTPS on the guardian side. Rejected.

### Ways to reach the guardian over HTTPS

| Path | RP ID | What the owner needs | Verdict |
|---|---|---|---|
| Umbrel's built-in local HTTPS ([Umbrel docs](https://umbrel.com/support/basics/accessing-your-umbrel-over-https)) | `umbrel.local` (or the custom hostname) | Install and trust the "Umbrel Local HTTPS CA" on every device. Reinstall when Umbrel renews it. | **Unconfirmed.** Chrome reportedly rejects `.local` RP IDs because `.local` is not on the Public Suffix List ([report](https://gist.github.com/o-az/8186cc726c1182776a1b039d408ad2b1)). How apps on other ports are served over it is also unconfirmed. Every other app on the box shares the RP ID. Test before offering it. |
| Tailscale with HTTPS certificates ([Umbrel remote access](https://umbrel.com/support/basics/remote-access), [Tailscale HTTPS](https://tailscale.com/kb/1153/enabling-https), [Tailscale Serve](https://tailscale.com/kb/1312/serve)) | `<machine>.<tailnet>.ts.net` | A tailnet; the Tailscale app on the Umbrel; MagicDNS and HTTPS certificates turned on in the admin console; `tailscale serve` (or a proxy using `tailscale cert`) in front of the guardian. Certificates come from Let's Encrypt, so the machine and tailnet names are published in Certificate Transparency logs. | **Workable, recommended for most owners.** Valid certificate, nothing exposed to the internet, also works from the phone. Whether the Umbrel Tailscale app can run `serve` for one app without the CLI is unconfirmed; community guides exist. The machine name is shared with the Umbrel dashboard and other served apps. A Tailscale sidecar in the guardian's compose file, with its own node name, would give the guardian its own RP ID (packaging change, needs an auth key). |
| Own domain and reverse proxy | e.g. `guardian.example.com` | A domain; a proxy app on the box (Caddy, Nginx Proxy Manager) with a DNS-01 Let's Encrypt certificate; DNS (split-horizon or a record pointing at the private address). No inbound port needed. | **Workable, most robust.** Stable, dedicated RP ID. Most setup work. |
| Tor (`.onion`, which Umbrel provides per app) | the onion address | Tor Browser | **Not viable.** Tor Browser treats `.onion` as a secure context ([Mozilla bug 1382359](https://bugzilla.mozilla.org/show_bug.cgi?id=1382359)), but its manual lists WebAuthn as disabled ([Tor forum, 2025](https://forum.torproject.org/t/i-cant-use-google-passkey/20523), [known issues](https://tb-manual.torproject.org/known-issues/)). Other browsers cannot reach or trust onion origins. |
| `localhost` through an SSH tunnel | `localhost` | `ssh -L 3010:localhost:3010 …` from a desktop, then `http://localhost:3010` | **Fallback only.** It is a secure context, so passkeys work. But the RP ID `localhost` is shared with every other local service on that computer, and phones cannot do it easily. |

The guardian cannot pick the path for the owner. It records, for each passkey, the RP ID and origin
it was registered at, and the UI says "this passkey works at `https://…` only".

## 2. Two levels

### (a) Passkey sign-in only

A WebAuthn assertion replaces the passphrase in `POST /api/session`. Unlocking after a restart still
needs the passphrase. It works with any passkey provider, because it needs no extension.

- **Ceremony.** `userVerification: "required"` and `residentKey: "required"`. The challenge is 32
  bytes from `secureRandomBytes`, single use, kept in memory for 5 minutes.
- **Checks on the guardian.** It checks the `clientDataJSON` type, challenge and origin (the origin
  stored with the credential, and the request's own origin as `checkOrigin` already sees it). It
  checks that the RP ID hash matches the stored RP ID, that the UP and UV flags are set, and the
  signature under the stored public key. Algorithms accepted: Ed25519 (-8), ES256 (-7), RS256 (-257).
  The signature counter is recorded but not enforced: synced passkeys report 0.
- **Throttle.** Failed assertions count against the session throttle (`session-throttle.json`), as
  passphrase sign-ins do.

### (b) Passkey as an unlock slot (WebAuthn PRF)

The PRF extension (CTAP2 `hmac-secret` underneath) gives the page 32 bytes that depend only on the
credential and on a salt the page chooses. The browser first hashes the salt as
`SHA-256("WebAuthn PRF" || 0x00 || salt)`, so web origins never get raw `hmac-secret` outputs. The
same output comes back every time, on every device the passkey syncs to. The phone's cloud backup
already works this way (`packages/wallet/src/backup.ts`, slot type `passkey-prf`); this design reuses
that shape.

**Keystore format version 2.** Version 1 has no data key: the Argon2id output encrypts the seed
directly. Version 2 adds one:

```
DK          32 random bytes (secureRandomBytes), never stored in clear
ciphertext  XChaCha20-Poly1305(DK, nonce, aad = [format, 2, cipher, public…, createdAt]) over the 64-byte seed
slots       one or more wraps of DK, each XChaCha20-Poly1305(KEK, slot nonce, aad = slotAad) over DK

passphrase slot (exactly one, mandatory)
  KEK = Argon2id(NFKC passphrase, salt; m = 64 MiB, t = 3, p = 1), as in version 1
passkey-prf slot (0 to 8)
  KEK = HKDF-SHA256(ikm = PRF output, salt = hkdfSalt, info = "trikey/guardian-unlock/passkey-prf/v1", 32)

slotAad = JSON ["trikey-keystore/v2/slot", accountPubkey, slot.id, slot.type, …every other field of the slot]
```

- **Integrity.** The seed's associated data leaves the slots out, so a slot can be added or removed
  without re-encrypting the seed. Each slot binds its own parameters and key 3's account pubkey. A
  slot copied from another keystore, or one with an edited salt, KDF parameter, credential id or RP
  ID, fails to open. Nobody without DK can make a new valid slot.
- **The passphrase slot is mandatory.** `parseKeystore` refuses a version-2 file without exactly one
  passphrase slot, and the API has no way to remove it.
- **Migration.** A version-1 keystore is upgraded at the next successful passphrase unlock, the only
  time the seed is in hand: draw DK, re-encrypt, write a passphrase slot with a fresh salt, replace
  the file atomically (`writeFileAtomic`), re-open it with the passphrase before the old one is gone.
  Nothing else changes. A guardian of an older version refuses a version-2 file
  (`unsupported format or version`), so a downgrade fails closed rather than misreading it.
- **What the guardian stores per passkey** (all public, in the keystore file): slot id (16 random
  bytes), credential id, COSE public key and algorithm, RP ID, origin, transports, the backup flags
  (BE/BS, shown as "synced" or "on this device only"), AAGUID, owner label, `createdAt`, and for PRF
  slots `prfSalt`, `hkdfSalt`, `nonce` and `wrappedKey`. A passkey without PRF is stored the same way
  without the last four fields: it can sign in but not unlock. `lastUsedAt` and the signature counter
  change often, so they live in a separate `passkeys-meta.json` and the keystore is rewritten only when
  a slot is added or removed.
- **PRF salts.** `prfSalt` is 32 bytes from `secureRandomBytes`, new for each slot, chosen by the
  guardian and never reused. It is not secret. `hkdfSalt` is another 32 random bytes. The HKDF info
  string keeps this key apart from any other use of the same output.
- **Always with user verification.** `hmac-secret` holds two secrets per credential, one used with
  user verification and one without, which give different outputs; PRF is defined on the one used with
  UV ([W3C list, 2025-10](https://lists.w3.org/Archives/Public/public-webauthn/2025Oct/0027.html)).
  Every ceremony asks for `userVerification: "required"` and the guardian refuses an assertion
  without the UV flag, so the output is always the same and always behind a biometric or PIN.

**Registration** (Settings, "Add a passkey"; signed in, guardian locked or unlocked):

1. The owner enters the passphrase. Adding a way to unlock key 3 must not be possible with a stolen
   session cookie alone. The request goes through the web unlock throttle.
2. The guardian returns creation options: the RP ID (the request's host, checked against the stored
   origin rules), a stable random user handle, `excludeCredentials`, and
   `extensions: { prf: { eval: { first: prfSalt } } }`.
3. The browser runs `navigator.credentials.create()`. If the PRF result is not returned at creation
   (some providers only report `prf.enabled`), the page runs one `get()` on the new credential
   straight away to evaluate it. If no PRF output comes back, the passkey is saved as sign-in only, and
   the UI says so.
4. The guardian verifies the attestation (format `none` is fine; no attestation is required),
   unwraps DK with the passphrase, derives the KEK, wraps DK, re-opens the new slot to check it,
   writes the keystore, and zeroes DK, KEK and the PRF output.

**Unlock** (the locked screen, no session needed, since a restart ends every session):

1. `GET /api/unlock/passkey/options` returns a challenge, `allowCredentials`, and `evalByCredential`
   with each slot's `prfSalt`.
2. The browser runs `get()` and posts the assertion and the PRF output over the same HTTPS
   connection, the way it posts the passphrase today.
3. The guardian calls `throttle.begin()` on the web unlock throttle, verifies the assertion against the
   slot (origin, RP ID, UV, signature, challenge), derives the KEK, unwraps DK, decrypts the seed,
   checks it against the stored xpub, installs key 3, and signs the browser in. The outcome is the same
   as `POST /api/session` with `unlock: true`. The assertion is what binds the request to the
   guardian's origin; the PRF output alone, presented through the API without a fresh assertion,
   does nothing.

**Removal and loss.**

- **Remove** (Settings): needs the passphrase. Removing a slot rewrites the keystore without it. Where
  the browser supports the WebAuthn Signal API, the page also tells the provider the credential is
  gone, so it stops offering it.
- **A passkey deleted in the password manager** leaves its slot unused. The passphrase still unlocks.
  The owner removes the slot when they notice; the UI shows each slot's last use.
- **A lost or replaced device:** nothing to do for a synced passkey. For a device-bound one (a YubiKey,
  a passkey kept on one device), use the passphrase and register the new one.
- **A suspected leak** (the password-manager account taken over): remove the slot. That stops the
  passkey on the live guardian, but it does not help against a copy of the data directory taken
  earlier, which together with the passkey still opens the seed. The same holds for a leaked passphrase
  today. If both may have happened, the remedy is a reset (it rotates key 3) or "Replace guardian".
- Losing every passkey never loses key 3: the passphrase slot cannot be removed. This answers the
  usual objection to PRF encryption, that people delete passkeys without knowing data depends on them
  ([Cappalli, 2026-02-27](https://blog.timcappalli.me/p/passkeys-prf-warning)).

## 3. Support matrix

Checked 2026-10-30. "Passkeys" means the provider can create and use a passkey on a third-party site.
"PRF" means it returns PRF output to a third-party site. Many rows rest on vendor community threads and
third-party test tables rather than release notes; anything marked **unconfirmed** must be tested on
the owner's devices (phase 0) before we rely on it.

| Provider / platform | Passkeys | PRF | Sources |
|---|---|---|---|
| Proton Pass | Yes, all plans since 2024-03 (browser extension, iOS 17+, Android 14+) | **Unconfirmed.** No Proton statement found. Third-party sources disagree: one 2026-06 test table reports PRF output in desktop Chrome; others list it as unsupported; one user report says none on iOS. | [Proton blog](https://proton.me/blog/proton-pass-passkeys), [Proton support](https://proton.me/support/pass-use-passkeys) |
| 1Password | Yes | Browser extension: yes in the current stable release, per 1Password staff (beta from 2024-07, extension 2.26.1). Android and iOS: announced (Android beta 8.10.38, iOS with iOS 18); stable status **unconfirmed**. | [1Password blog, 2024-07](https://1password.com/blog/encrypt-data-saved-passkeys), [community thread](https://www.1password.community/discussions/1password/prf-support/153278) |
| Bitwarden | Yes (extension, mobile; desktop app since 2026.10.1) | As a provider for other sites: **not supported** in the reports found (community, 2026-07). Bitwarden uses PRF the other way round, to log in to and unlock its own vault in Chromium browsers. | [GitHub discussion #13838](https://github.com/orgs/bitwarden/discussions/13838), [community](https://community.bitwarden.com/t/support-for-storing-prf-capable-passkeys-in-bitwarden-vault/82239), [Bitwarden blog](https://bitwarden.com/blog/log-into-bitwarden-with-a-passkey/) |
| iCloud Keychain / Safari | Yes | Yes since Safari 18 / iOS 18 / macOS 15 (2024-09) for on-device passkeys. The cross-device (QR) flow returned no or different output in reports up to Safari 18.4 beta. | [Apple developer forums](https://developer.apple.com/forums/thread/774112) |
| Google Password Manager / Chrome | Yes (Android 9+, desktop Chrome) | Chrome supports PRF with security keys since 116. GPM passkeys on desktop Chrome and on Android: reported working by third-party tests; not stated in Google's docs, so **unconfirmed** officially. Third-party providers on Android: reported not to pass PRF through Credential Manager. | [Google: supported environments](https://developers.google.com/identity/passkeys/supported-environments), [Corbado (third party, updated 2026)](https://www.corbado.com/blog/passkeys-prf-webauthn) |
| Firefox | Yes | Windows and Linux since 135, macOS since 139, per Mozilla's bug tracker; an open 2025 report says it fails on macOS; not on Android. | Mozilla bugs [1935277](https://bugzilla.mozilla.org/show_bug.cgi?id=1935277), [1935278](https://bugzilla.mozilla.org/show_bug.cgi?id=1935278), [1935280](https://bugzilla.mozilla.org/show_bug.cgi?id=1935280), [1958716](https://bugzilla.mozilla.org/show_bug.cgi?id=1958716), [1985777](https://bugzilla.mozilla.org/show_bug.cgi?id=1985777) |
| Windows Hello | Yes | Historically no. Reported since the February 2026 Windows 11 update (WebAuthn API version 8), with PRF at creation in Chrome and Edge 147; reports conflict, and there is no Microsoft announcement: **unconfirmed**. | [Bitwarden issue #19858](https://github.com/bitwarden/clients/issues/19858), [community](https://community.bitwarden.com/t/encryption-prf-via-windows-hello-passkey/94236) |
| Hardware keys (YubiKey) | Yes (FIDO2) | `hmac-secret` from firmware 5.2, `hmac-secret-mc` (one touch at creation) from 5.8. Works in Chrome; WebKit bugs report null or mismatched output in Safari. Not synced: register two keys. | [Yubico: PRF support](https://developers.yubico.com/Passkeys/Passkey_concepts/Security_key_capabilities/Pseudo-Random_Function_PRF_Support.html), [Yubico: PRF extension](https://developers.yubico.com/WebAuthn/Concepts/PRF_Extension/) |

For the owner's request this means: a Proton Pass passkey will very likely work for **sign-in (a)**.
Whether it can **unlock (b)** is unconfirmed and has to be tested. 1Password in the browser,
iCloud Keychain and YubiKeys are the providers where (b) is best supported today.

## 4. Security analysis

**What a passkey slot changes.**

- **Someone with the data directory** (a stolen disk, a backup of the app folder). Today they can
  guess the passphrase offline at Argon2id's cost. A PRF slot adds a second way in, but its KEK comes
  from 256 bits that cannot be guessed, so offline guessing is no easier. What it adds is a dependency:
  file plus PRF output opens key 3, with no throttle in the way.
- **Someone with the owner's synced password-manager account.** They can use the passkey from their
  own device: sign in, and (with a PRF slot) unlock, if they can also reach the guardian's HTTPS
  origin (the tailnet, the LAN) or hold a copy of the data directory. A synced passkey is only as strong
  as that account, including its recovery path. If the passphrase is already stored in the same
  manager, nothing changes. If the owner keeps the passphrase only in their head, a synced passkey
  lowers the unlock to the account's strength. A device-bound passkey (a YubiKey) does not.
- **What unlock gives an attacker is bounded.** An unlocked guardian is one key of three: it co-signs
  within the daily limit, and loosening any rule needs the hardware wallet (rule 4). That stays true.
- **Phishing.** A passphrase can be typed into a look-alike page; a passkey cannot be used on another
  RP ID, and the guardian checks the origin in every assertion. What remains: a page on the **same
  RP ID**, such as another app served under the same host name, can ask for the guardian's passkey and,
  knowing the public `prfSalt`, get its PRF output. That output is useless through the API without a
  fresh assertion for the guardian's origin, but together with a copy of the data directory it opens the
  seed. Hence the advice to give the guardian a host name of its own.
- **Throttles still apply.** Passkey unlocks count against the web unlock throttle, passkey sign-ins
  against the session throttle. Challenges are single use and expire. Failures are logged as
  `unlock_failed` with `via: "web"` and the slot id.

**What must not change.**

- **Key 3 never leaves the guardian.** The browser sends the PRF output in; nothing secret comes out.
  DK, KEK and the seed stay on the box and are zeroed after use, as now.
- **The passphrase remains a working fallback.** It is a mandatory slot. It is still required for
  reset, for adding or removing a passkey, and for every unlock from the phone.
- **Nothing secret goes over a relay.** The phone's `guardian.unlock` over nostr stays passphrase
  only (or the future hardware unlock). PRF outputs and assertions travel only on the HTTPS path between
  the browser and the box.
- **No third party.** No hosted relying party, no Related Origin Requests on `trikey.app`, no
  attestation service. The guardian verifies everything itself.

## 5. Recommendation and plan

**Recommendation.** Build both levels behind one "Add a passkey" button that detects PRF. With PRF,
the passkey signs in and unlocks. Without it, it signs in only and the UI says so. Keep the passphrase
as the mandatory fallback and as the only key for reset, passkey management and phone unlocks. Do not
start with code: the precondition is an HTTPS path. Document Tailscale Serve and a reverse proxy with
an own domain as the supported paths, and offer passkeys only when the page is a secure context.

| Phase | Work | Size |
|---|---|---|
| 0. Spike | A throwaway HTTPS test page (create, get, PRF) run on the owner's devices: Proton Pass on each platform, the chosen access path, and `umbrel.local` with Umbrel's CA. Fill in the unconfirmed cells above. | 1-2 days |
| 1. Access path | Docs for Tailscale Serve and a reverse proxy ([`../https-access.md`](../https-access.md)); check that `checkOrigin` and the `Secure` cookie behave behind each; the UI hides passkey options outside a secure context. Optional: a Tailscale sidecar in the Umbrel package for a dedicated host name. | S (2-3 days) |
| 2. Sign-in (a) | WebAuthn registration and assertion verification on the guardian (ES256, Ed25519, RS256), credential storage, Settings > Passkeys (add, list, remove), sign-in button, tests with recorded vectors. | M (about 1 week) |
| 3. Unlock (b) | Keystore version 2 with migration, PRF slot, unlock endpoint, test vectors checked against node:crypto, DESIGN.md (keystore, threat model, Entropy table), API.md. | M-L (1-2 weeks) |
| 4. Review | Security review of phases 2 and 3 before it reaches mainnet users. | — |

Version 2 slots also prepare the ground for the hardware-wallet unlock (Open question 1 in DESIGN.md),
which would be one more slot type.

## Decisions (30 October 2026)

The owner asked for the open questions to be decided, and agreed with these answers. Each holds unless the phase 0
test says otherwise.

1. **HTTPS path: Tailscale first.** Tailscale Serve (`<box>.<tailnet>.ts.net`) is the supported path: Umbrel already
   has a Tailscale app, it needs no domain or port forwarding, and the certificate is a real one. An own domain behind
   a reverse proxy is documented as the second path. Umbrel's local CA is not pursued (Chrome reportedly refuses
   `.local` RP IDs), and Tor and SSH tunnels are not passkey paths. A passkey working only at the address it was made
   at is accepted: the guardian lists each passkey with the address it belongs to.
2. **Both levels, chosen by the provider.** Passkey sign-in works with any provider. A passkey unlocks key 3 only where
   the provider returns PRF; where it does not, the guardian says so at registration and keeps it as sign-in only.
   Whether Proton Pass is one or the other is what the phase 0 test page (`trikey.app/passkey-test`) answers on the
   owner's devices.
3. **Synced passkeys are allowed, with a plain warning.** Registering an unlock passkey says that unlocking then is as
   strong as the password manager account (and its recovery). The passphrase stays as a mandatory slot either way, and
   a device-bound passkey (a security key) is suggested for anyone who prefers it. No provider is refused.
4. **`@simplewebauthn/server`, pinned exactly.** Parsing CBOR, COSE keys and attestation by hand is where verification
   bugs live; a well-tested library is the smaller risk. It is pinned to an exact version in the lockfile, so the
   reproducible image is unaffected, and the guardian's own tests cover every path that uses it.
5. **No Tailscale sidecar in the package.** It would need an auth key in the app's settings and couple the guardian to
   one VPN. The docs explain how to point Umbrel's Tailscale app at the guardian instead.
6. **Change passphrase ships with keystore v2.** It is a re-wrap of one slot once v2 exists, and owners asked for it
   less than they will need it.

Order: phase 0 (the test page) first; then the HTTPS docs; then passkey sign-in; then keystore v2 with the PRF unlock
slot and passphrase change. Nothing past phase 0 is built until the test results are in.

## Open questions (answered above)


1. **Which HTTPS path will you use:** Tailscale, an own domain, or Umbrel's local CA if it passes the
   spike? Is it acceptable that a passkey works only at the address it was made at?
2. **Proton Pass and PRF.** If Proton Pass does not return PRF output on your devices, is sign-in only
   enough, or would you use another provider (iCloud Keychain, 1Password, a YubiKey) for the unlock
   slot?
3. **Strength.** A synced passkey makes unlocking as strong as your Proton account and its recovery
   path. Is the passphrase already stored there? If not, do you accept that trade, or prefer a
   device-bound passkey for unlocking?
4. **Dependency.** Verify WebAuthn with `@simplewebauthn/server` (well tested, one more dependency), or
   by hand on the `@noble` libraries the guardian already uses?
5. **Packaging.** Is a Tailscale sidecar in the Umbrel app, giving the guardian its own host name and
   RP ID, worth its setup cost (an auth key)?
6. **Change passphrase.** Version 2 makes changing the passphrase a re-wrap of one slot. Add it in the
   same release?
