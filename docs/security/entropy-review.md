# Entropy review, October 2026

Scope: how Trikey generates and uses randomness. That covers the RNG and its guards, key generation
on the phone, the guardian and the Recovery Kit, nonces and per-message randomness, the lifetime of
secret material, and the tests. Reviewed at `main` `deee1be` (the code reviewed is unchanged since
`e6a5f9a`). No product code was changed by the review itself.

**Status (30 October 2026): M1 and L1-L3 are fixed** (#24, #21, #20, #22), released from v0.1.2-alpha.
Each finding below keeps its original text, with a "Fixed" note under its heading. The Info items are
accepted as they are, as the review recommends.

## Summary

The RNG design is sound. Every key and secret Trikey makes comes through `secureRandomBytes`. It reads
the OS CSPRNG on all three platforms, with no weak fallback, and refuses to answer if the source is
missing, replaced, stuck or repeating. Bitcoin signing does not depend on runtime randomness: ECDSA
uses RFC 6979. Encryption nonces are 24-byte XChaCha20 or 32-byte NIP-44 values, drawn fresh every
time. No shipped code calls `Math.random` for anything secret.

No Critical or High issue was found.

The main finding is **M1**. The "key 3 from both sides" mix does not protect against the threat it
was built for. That threat is a predictable RNG on the guardian. The phone's contribution `c`
reaches the guardian over public nostr relays, encrypted to the guardian's nostr key, and that key
comes from the same guardian RNG. So an attacker who can predict the guardian's RNG output can read
`c` from a stored relay copy and derive key 3. A proof of concept confirms this (below).

The other findings are Low or Informational:
- the randomness lint is easy to get around;
- the NIP-59 back-dating is undone by a cleartext `expiration` tag;
- there is no startup health test or known-answer test for the RNG;
- a few hygiene points.

| # | Severity | Finding | Status |
|---|---|---|---|
| M1 | Medium | The key-3 mix does not protect against a predictable guardian RNG: `c` is recoverable from relays with the guardian's nostr key, which comes from the same RNG | Fixed (#24) |
| L1 | Low | The randomness lint misses most ways around `secureRandomBytes`, and never looks at dependencies | Fixed (#21); dependencies still out of scope |
| L2 | Low | NIP-59 back-dating is undone by the gift wrap's cleartext `expiration` tag (real send time + a predictable TTL) | Fixed (#20) |
| L3 | Low | No startup RNG health or known-answer test on the guardian; the phone's self-test is manual (Developer screen); the per-call checks only catch gross failures | Fixed (#22) |
| I1 | Info | Signing randomness that skips the guards: BIP 340 `aux_rand` for nostr events comes from raw `crypto.getRandomValues` (safe by BIP 340's design) | Confirmed, no impact |
| I2 | Info | `pair.prepare` can be repeated without limit within a session, so a phone can choose among many key-3 xpubs | Confirmed, no direct impact |
| I3 | Info | The guardian accepts a degenerate phone contribution (`c` all-zero or constant) without comment | Confirmed, no direct impact |
| I4 | Info | `randomPositions` (Recovery Kit word challenge) has modulo bias and reuses its 32 bytes | Confirmed, negligible |
| I5 | Info | Secret material that cannot be zeroed in JS (mnemonic strings, intermediate BIP 32 nodes); the backup file stays in the app cache | Confirmed, inherent; the cached backup file is now cleared (see I5) |
| S1 | Suspicion | `expo-print` on Android may write the kit page (key 3 in the clear) to a cache file | Not confirmed |
| S2 | Suspicion | A second instance of `@trikey/core/random` in the Metro bundle would be pinned only on first use | Not confirmed |

---

## Findings

### M1 (Medium). The key-3 mix does not protect against a predictable guardian RNG

> **Fixed in #24.** New setup and reset seeds are `HMAC-SHA512(key = OS draw, "trikey/guardian-seed/v1" || browser || extra)`: 32 bytes from the setup browser's `crypto.getRandomValues` (sent over HTTP, never over a relay) and, on Umbrel, the app's `APP_SEED` (`TRIKEY_EXTRA_ENTROPY`). The OS draw stays the key, so no seed is weaker than before. DESIGN.md and the code comments now say what the phone's mix covers and what these inputs cover. Existing guardians keep their keys.

**Where.**
- `apps/guardian/src/keystore.ts:254-259`: `mixedKey3Seed`, `seed3 = HMAC-SHA512(guardianSeed, tag || context || c)`.
- `apps/guardian/src/nostr/handlers.ts:316-330`: `pair.prepare` takes `entropy` (`c`) from the RPC request.
- `packages/wallet/src/wallet.ts:1083-1095`: the phone draws `c` and sends it in `pair.prepare` over `this.connect(payload.guardianPubkey, payload.relays)`.
- `apps/guardian/src/identity.ts:56`: the guardian's nostr key from `randomSecretKey()`, the same OS RNG as the setup seed.
- `apps/guardian/src/pairing.ts:49`: the pairing session id, the same RNG again.
- `apps/guardian/src/config.ts:89-91`: the default relays are public (damus, nos.lol, primal).
- The claim itself: `DESIGN.md` "Entropy", "What this is for": "It protects against a weak generator on the guardian: a guessable setup seed alone no longer gives key 3."

**What is wrong.** The mix is meant to help when the guardian's RNG is weak or predictable. But the
phone's contribution `c` reaches the guardian inside a NIP-59 gift wrap published to public relays.
The wrap's outer layer is encrypted to ECDH(wrap key, guardian pubkey) and the seal to ECDH(phone
key, guardian pubkey). The guardian's nostr secret opens both. That secret came from the same
generator as the setup seed, and so did the pairing id that goes into `walletContext`.

In other words, a fully predictable guardian RNG gives the attacker every input to `seed3`:
- the setup seed;
- the nostr key, which opens the relay copy of `pair.prepare` and reveals `c`;
- the pairing id;
- the network and the phone pubkey, which are public.

`c` is also stored in clear in the registration (`policy/types.ts:93-98`). The nostr key is stored
unencrypted in the same data directory (`identity.ts`, by design). So someone who copies the data
directory also has everything except the seed, which is consistent with the design. But the claim
above is stronger than what the code delivers.

**Scenario.** A guardian image or VM is restored from a snapshot, or its kernel RNG is otherwise
predictable to an attacker. That is exactly the "weak generator on the guardian" case. The attacker:
1. predicts the setup seed and the guardian's nostr secret key;
2. downloads the kind-1059 wraps addressed to the guardian's npub from a public relay (they are
   kept at least until their `expiration`, and many relays ignore NIP-40);
3. opens the `pair.prepare` wrap and reads `entropy`;
4. computes `seed3` and key 3.

A thief who then steals the phone, or who also has a weak key 2, holds two keys. The mix bought
nothing against this attacker.

**Proof of concept.** This was run against the real `wrapMessage` / `openGiftWrap` and
`GuardianSeed.key3` code. It is a throwaway script, not committed. A phone wraps `pair.prepare` with
a fresh `c` to a guardian whose nostr key the attacker "predicted". The attacker opens the wrap with
that key, reads `c`, and derives key 3 from the predicted seed:

```
c recovered from relay copy: true
attacker key 3 xpub == guardian key 3 xpub: true
```

**Why there is no transport fix.** If the guardian's RNG is fully predictable, an observer can
re-run anything the guardian computes from messages that travel over nostr. Ephemeral keys drawn
on the guardian do not help either. The contribution has to come from a source the observer
cannot predict, delivered over a path that the guardian's predictable keys do not protect.

**Recommended fix.**
1. **Correct the claim now** (DESIGN.md "Entropy" and the comments in `keystore.ts` and
   `wallet.ts:1065-1070`). The mix protects against an attacker who knows the guardian's seed but
   not its nostr traffic. For example, a seed leaked on its own, a weakness in BIP 39 seed
   generation alone, or a guardian that later turns out to have a flawed `generateSeed`. It does
   not protect against a guardian whose whole RNG output is predictable to someone who can read
   relays.
2. **Mix in an independent source at setup, over a path relays never see.** The web UI's setup
   request can carry 32 bytes from the browser's `crypto.getRandomValues`: another machine, and a
   LAN or Tor HTTP path. The guardian can then set
   `seed = HMAC-SHA512(key = os_entropy, data = "trikey/guardian-seed/v1" || browser_entropy)`
   before `entropyToMnemonic`, or mix it into the key-3 HMAC. On Umbrel, the per-app `APP_SEED`
   environment variable is another independent input that is cheap to add. It is derived from the
   Umbrel's own seed, which was made at another time. Neither helps against an attacker who already
   runs code on the box, and they do not need to.
3. Optionally, carry `c` (or a second contribution `c2`) in the guardian web UI as well, for example
   as a short code the phone displays and the user types, so that it never crosses a relay. That
   costs UX; item 2 is cheaper and covers the realistic case.

### L1 (Low). The randomness lint misses most ways around `secureRandomBytes`

> **Fixed in #21.** A token-level checker (`packages/core/test/support/randomness-check.ts`) follows namespace, default, aliased, multi-line, `require` and dynamic-import forms, `globalThis.crypto`, and `nip44.encrypt` without a nonce; it is tested on 90 bypasses and 50 look-alikes. It found one real case (the Developer self-test's NIP-44 call), now fixed. Value aliasing and dependencies stay out of reach.

**Where.** `packages/core/test/randomness-lint.test.ts:20-38`.

**What is wrong.** The rules are line-based regexes over six patterns. I fed the exact `RULES` from
the test a set of common alternatives. All of the following pass the lint unflagged:

- `crypto.randomBytes(32)` after `import crypto from 'node:crypto'` or `import * as c`. The lookbehind
  `(?<![\w.])` in `raw randomBytes( call` excludes the member-call form on purpose, and the import
  rule only matches named imports.
- `crypto.getRandomValues(...)`, `globalThis.crypto.getRandomValues(...)`, `webcrypto.getRandomValues(...)`.
  These call the right source but skip the stuck, repeat and replacement checks.
- `crypto.randomUUID()`, `randomInt`, `randomFillSync` / `randomFill` from `node:crypto`.
- `secp256k1.utils.randomSecretKey()`, `schnorr.utils.randomSecretKey()` (noble).
- `randomBytes` imported from `@noble/ciphers/utils.js`, `@noble/curves/utils.js` or
  `@scure/btc-signer/utils.js`. The import rule only names `@noble/hashes` and `crypto`.
- A multi-line import (`import {\n randomBytes as rb,\n} from '@noble/hashes/utils.js'`) followed by
  `rb(32)`.
- `nip44.encrypt(text, key)` without the nonce argument. nostr-tools then draws its own nonce.
- `nip59.wrapEvent` / `nip17.wrapEvent` / `wrapManyEvents`. nostr-tools draws the wrap key with its
  own `generateSecretKey` and the back-dating with `Math.random`.
- `ExpoCrypto.getRandomBytes` / `getRandomBytes` from `expo-crypto`. In `__DEV__` under a remote
  debugger this falls back to `Math.random`
  (`node_modules/expo-crypto/build/Crypto.js:22-29`). The app uses `getRandomValues`, which has no
  such fallback.
- `Math['random']()`.

I grepped today's shipped sources for all of these and found none. So this is a guard-rail gap,
not a live bug. The lint also does not scan `apps/guardian-web`, which does draw randomness, though
only in `src/api/mock.ts`. By design it does not scan dependencies.

**Scenario.** A later change adds `crypto.randomUUID()` for an id that turns out to be a secret
(a session or pairing token), or calls `nip44.encrypt` without the nonce. CI stays green, and the
DESIGN.md claim that every secret goes through the checked source silently stops being true.

**Recommended fix.**
- Make the lint match by token rather than by import form. Flag
  `\b(randomBytes|randomFillSync|randomFill|randomInt|randomUUID|getRandomValues|randomSecretKey|randomPrivateKey|getRandomBytes(Async)?)\b`
  anywhere outside `packages/core/src/random.ts` and the polyfill files (allowlist those), and
  `Math\s*(\.|\[)\s*['"]?random`.
- Flag `nip44.encrypt(` calls with fewer than three arguments, and the identifiers `wrapEvent`,
  `wrapManyEvents`, `createWrap` and `createSeal` from nostr-tools.
- Add the bypass lines above to the "rules catch what they are meant to" test.
- Add `apps/guardian-web/src` with `api/mock.ts` allowlisted.
- Optionally, add a runtime tripwire in tests: wrap `globalThis.crypto.getRandomValues` in the test
  setup with a counter, and assert that the key-generation paths cause no draws except through
  `secureRandomBytes`. That catches dependency-internal draws the lint cannot see.

### L2 (Low). NIP-59 back-dating is undone by the cleartext `expiration` tag

> **Fixed in #20.** The wrap's expiration is `created_at + WRAP_BACKDATE_SEC + maxTtl(class)`, a function of the back-dated `created_at` only, so it reveals nothing more about the send time. The exact expiry stays inside the encrypted rumor.

**Where.**
- `packages/protocol/src/envelope.ts:157-167`: `expiration = createdAt + ttl`, with `createdAt` the
  real send time.
- `packages/protocol/src/transport.ts:166-182`: the gift wrap copies that tag into its public tags.
- `packages/protocol/src/client.ts:183`: `ttl` is a deterministic function of the method class and
  the call timeout.

**What is wrong.** `created_at` on the seal and the wrap is back-dated by a uniform 0 to 2 days from
`secureRandomInt` (`transport.ts:142`), "so relays should not learn when a message was sent".
DESIGN.md calls this "Back-dating hides when a message was sent". But the wrap also carries a
cleartext `expiration` tag. It equals the real send time plus a TTL that an observer can bucket by
method class, so anyone reading the relay gets the send time to within a few seconds. Relays also
see when an event arrives anyway.

`wrapDirectMessage` (the NIP-17 alerts) does not add the tag, so it is not affected.

**Scenario.** A relay or a later reader lines up the expiration times of wraps to the guardian's
npub. That gives the exact times of `sign`, `recovery.*` and `guardian.unlock` traffic, which is
what the randomized timestamps were meant to hide. This is privacy only; funds are not at risk.

**Recommended fix.** One of these:
- round `expiration` up to a coarse bucket, for example the next hour, plus a random 0 to 1 h from
  `secureRandomInt`, and keep the exact expiry inside the rumor, where it is already checked
  (`envelope.ts:210`);
- or drop the public tag and rely on the rumor's expiration.

Either way, narrow the DESIGN.md wording: relays still see when an event arrives.

### L3 (Low). No startup RNG health or known-answer test; the per-call checks are narrow

> **Fixed in #22.** `@trikey/core/random-health` runs at guardian start (exit 70 on failure) and on the phone at boot and before every key. Correction to the suggestion below: 96 to 160 set bits per 256-bit block is about 4 sigma (a false alarm about once in 1,400 runs); the fix uses 64 to 192 (8 sigma), for a false-alarm rate below 10^-13 per run.

**Where.**
- `packages/core/src/random.ts:205-221`: the per-call checks are one byte value repeated, and the
  leading 32 bytes equal to the previous draw's.
- `apps/mobile/src/platform/self-test.ts:59-68`: the self-test that checks the source is pinned
  runs only from Settings, Developer (`components/self-test-row.tsx`).
- The guardian (`main.ts`, `pin-random.ts`) pins the source and runs no test before
  `generateSeed()` at setup (`guardian.ts:652`) or at reset (`guardian.ts:911`).

**What is wrong.** The per-call checks catch a zero buffer and a stuck source. They do not catch:
- a source that cycles with period 2 or more (A, B, A, B);
- a counter or a timestamp-seeded PRNG;
- a polyfill backed by `Math.random`.

DESIGN.md acknowledges that no output test proves unpredictability, which is correct. But two cheap
tests that would catch more gross failures are missing:
- **A startup health test** before the first key is made: draw, for example, 16 blocks of 32
  bytes, and refuse if any two are equal, if a block has fewer than about 96 or more than about 160
  set bits out of 256 (far outside 6 sigma), or if blocks differ by a constant (XOR or difference).
  This is in the spirit of the SP 800-90B start-up tests.
- **A known-answer test of the primitives** the keys depend on: HMAC-SHA512, BIP 39 to seed,
  BIP 32, Argon2id, XChaCha20-Poly1305, and the `trikey/key3/v1` vector the tests already have
  (`apps/guardian/test/key3-mix.e2e.test.ts`). It catches a broken JS engine or a bad dependency
  update on the target device. The phone has these vectors, but only behind a developer screen.

**Scenario.** A future platform change makes `expo-crypto` return the output of a seeded PRNG that
cycles every few draws, for example a mock left in a release build. Every call passes, and keys are
made from it.

**Recommended fix.** Add `randomSourceSelfTest()` to `@trikey/core/random`, implementing the health
test above, and run it:
- in `pin-random.ts` and `polyfills.ts` right after pinning, latching a failure like the other
  checks;
- again just before `newMnemonic`, `generateSeed`, `newRecoveryKeyEntropy` and
  `randomSecretKey` for identities.

Run the existing self-test vectors silently once at app start and at guardian start, and refuse
key generation on a mismatch. Keep the Developer screen for the full report.

### I1 (Info). Signing randomness that skips the guards (no impact)

- Nostr events (seals, wraps, alerts) are signed by nostr-tools `finalizeEvent`, which calls
  noble `schnorr.sign` with the default `auxRand = randomBytes(32)`. That reads
  `globalThis.crypto.getRandomValues` directly (`node_modules/@noble/hashes/utils.js:656-661`),
  without the stuck or repeat checks. BIP 340 derives the nonce from
  `H(d XOR H(aux) || P || m)`, so even all-zero aux randomness gives a safe deterministic nonce.
  On the phone and the guardian the global is the pinned function anyway.
- ECDSA: key 3 signs with `secp256k1.sign(..., { prehash: false, lowS: true })`
  (`keystore.ts:175`), and noble's default is `extraEntropy: false`
  (`node_modules/@noble/curves/abstract/weierstrass.js:828`). That is pure RFC 6979, so a broken
  RNG cannot leak key 3 through nonces. `@scure/btc-signer` grinds low-R with a counter as
  `extraEntropy` (`node_modules/@scure/btc-signer/utils.js:208-212`), which is still deterministic.
  The hardware wallets use their own nonces.
- BIP 137 approvals are produced by the hardware wallet, and the guardian only verifies them.

Recommendation: none needed. Optionally, pass `secureRandomBytes(32)` as `auxRand` where Trikey
calls Schnorr signing itself, for uniformity with DESIGN.md's claim that "every key and secret" is
checked.

### I2 (Info). `pair.prepare` can be repeated, so the phone can choose among key-3 xpubs

`handlers.ts:316-330`: within one pairing session the bound phone may call `pair.prepare` any number
of times. Each call takes a new `c`, returns the resulting key-3 xpub, and the last one counts. Key 3
is an HMAC under the guardian seed, so the phone cannot learn or steer the private key, and it
cannot cancel the guardian's entropy. Choosing among xpubs gains nothing for signing. Each call does
cost an HMAC plus a BIP 32 derivation.

Recommendation: limit `pair.prepare` to a handful per session, or make `c` first-write-wins per
session. This also makes the commitment order explicit: the guardian's seed is fixed at setup, and
the phone gets one choice of `c`.

### I3 (Info). The guardian does not check the phone's contribution for obvious failure

The schema (`schemas.ts:203`, `Hex32`) accepts any 32 bytes, including all zeros. The mix stays as
strong as the guardian seed whatever `c` is, so this is not a weakness. But a constant `c` is a free
signal that the phone's RNG is broken, which matters because the phone's RNG also made key 2.

Recommendation: refuse (or at least warn about) a `c` with one byte value repeated, mirroring
`secureRandomBytes`'s own check.

### I4 (Info). `randomPositions` is biased

`packages/recovery-key/src/wallet.ts:256-262`: `(r[i++ % 32] + i) % 12 + 1` over 32 bytes reused
cyclically. 256 is not a multiple of 12, so the positions have a small modulo bias, and the
`+ i` term correlates consecutive picks. The positions only choose which kit words the user types,
so there is no security impact. `secureRandomInt(12)` in a loop would be uniform and simpler.

### I5 (Info). Secret material JS cannot zero

These are inherent to JavaScript and listed for completeness:
- `generateSeed` (`keystore.ts:142-149`) and `newMnemonic` / `newPhoneMnemonic` pass the mnemonic as
  an immutable string, which cannot be zeroed.
- `HDKey.derive` creates intermediate nodes that `cosignerFromSeed` does not wipe; only `master` and
  `account` are wiped.
- The guardian keeps the 64-byte setup seed in memory for the whole unlocked period (`GuardianSeed`),
  by design, so that new pairings can derive key 3.

The encrypted `.tkb` backup is written to the app cache (`apps/mobile/src/platform/backup-files.native.ts:12-15`)
and not deleted after the share sheet closes. It is encrypted under a 120-bit recovery code or a
passkey PRF, so this is hygiene only. Recommendation: delete the cache file after `shareAsync`
returns.

**Fixed (2026-11-01):** the shared backup now goes into its own cache folder, emptied before each share and at every
start of the app, so it lasts at most the rest of that session. Not right after `shareAsync`: on Android the app
receiving the file may only read it after control returns. The document picker's cache copy is deleted once read.

---

## Suspicions (not confirmed)

- **S1. `expo-print` on Android.** `apps/mobile/src/lib/print-kit.ts` passes the kit HTML (key 3 in
  the clear) to `Print.printAsync({ html })` on the grounds that nothing is written to the app's
  storage. As far as I recall, on Android expo-print renders through a WebView and a print adapter
  that may write a temporary PDF to the app's cache directory. I could not confirm this without a
  device or the native sources. If it is true, the Recovery Key would sit on disk next to key 2's
  secure-store entry, which is the pairing the kit design forbids. Check on a device, after printing
  to "Save as PDF" and cancelling: list `getCacheDir()`. Clear `Print/` and the cache after
  printing if anything is there.
- **S2. Duplicate module instances.** Pinning, the latched failure and the continuous-test state are
  module-global in `@trikey/core/random`. If Metro ever bundled two copies, for example through the
  `.js`-stripping resolver fallback in `metro.config.js` or a nested `node_modules`, the second copy
  would never be explicitly pinned. It would pin whatever `crypto.getRandomValues` holds at its
  first draw (`random.ts:196`), and the self-test would only inspect the copy it imports. Most
  outcomes fail loudly: `assertRandomSourcePinned` in `random.native.ts` throws when it runs on an
  unpinned copy. I did not build the bundle to check. Recommendation: assert one instance at
  startup (a `Symbol.for('trikey.random')` marker on `globalThis` that a second copy refuses), or
  check the bundle in CI.

---

## Checked and found sound

**The RNG (`packages/core/src/random.ts`)**
- `secureRandomBytes` reads only `globalThis.crypto.getRandomValues`. It calls the pinned function
  with its own `this` and has no fallback path. It latches failures. The length is bounded at
  1 to 65,536. Every call draws at least 32 bytes, so the checks always run on a full block, and
  short outputs are copied with the remainder zeroed.
- The continuous test stores only a 128-bit tagged hash of the previous block, not the block.
- `secureRandomInt` uses rejection sampling with no modulo bias, and handles the 2^32 boundary.
- `randomSecretKey` takes 32 bytes, keeps them only if they are a valid scalar, and redraws at most
  four times.
- `node_modules/@noble/hashes/utils.js:659` (v2.4) reads `globalThis.crypto` at call time, not at
  module load. So on the phone, the order in which `@trikey/core/random` and its noble imports
  evaluate relative to `installPolyfills` is safe: noble would throw before the polyfill, never
  return weak bytes.

**Platforms**
- **The guardian:** `main.ts` imports `pin-random.ts` first. That module checks
  `globalThis.crypto === webcrypto` and pins `webcrypto.getRandomValues` (`getrandom(2)`).
- **The phone:** `index.ts` imports `src/platform/polyfills.ts` first. That installs
  `getRandomValues` backed by `expo-crypto`'s `getRandomValues`, which calls native
  `ExpoCrypto.getRandomValues` with no `Math.random` fallback (unlike `getRandomBytes`). It only
  installs when the global is missing, and then pins. `expo` (SDK winter runtime) installs no
  `getRandomValues` of its own. `random.native.ts` asserts the pin after importing
  `react-native-get-random-values`, so its debugger `Math.random` fallback can never become the
  source unnoticed.
- **guardian-web** makes no keys or secrets; only `src/api/mock.ts` uses `crypto.getRandomValues`.

**Key generation**
- Key 2: 32 bytes, then `entropyToMnemonic` (`packages/wallet/src/keys.ts:24`,
  `packages/recovery-key/src/keys.ts:37`). `generateMnemonic` is not used anywhere.
- The phone's nostr key and the silent-payment scan, spend and helper keys are derived from key 2's
  seed on separate hardened branches (NIP-06 `m/44'/1237'/0'/0/0`, BIP 352 `m/352'/c'/0'/{0',1'}/0`,
  BIP 84 `m/84'/c'/1'`), so they add no new entropy source.
- The Recovery Kit seed: 16 bytes (128 bits). It is wiped after `confirmKitSaved` and in
  `newVaultWithNewKit`'s `finally`.
- The guardian setup seed: 32 bytes, then BIP 39, then a 64-byte seed, sealed at once.
- `trikey/key3/v1`: the domain separation is correct (a tag plus length-prefixed network, pairing id
  and phone pubkey, then `c`), and the HMAC is keyed with the guardian seed. So the phone cannot
  bias or cancel the guardian's contribution, and the same `c` in another context gives another
  key. The guardian's own key (no mix) and the mixed keys are separated by the HMAC. On ordering,
  the guardian seed is fixed before the phone chooses `c`, and the phone never learns key 3.
  (A dishonest guardian can ignore `c`; DESIGN.md says so.)
- The guardian's nostr identity: `randomSecretKey`, separate from key 3.

**Nonces and per-message randomness**
- NIP-44: every `nip44.encrypt` in shipped code passes an explicit nonce from
  `secureRandomBytes(32)` (`transport.ts:145`).
- NIP-59: a fresh wrap key per wrap, from `randomSecretKey`, zeroed after use. The back-dating of the
  seal and the wrap is drawn independently. The rumor keeps the real time, per NIP-59.
- ECDSA: RFC 6979, low-S. Schnorr: BIP 340 (see I1). BIP 137: verified only, high-S refused.
- Keystore: Argon2id (default t=3, m=64 MiB, p=1), a fresh 16-byte salt and 24-byte XChaCha20 nonce
  on every seal, the header in the AAD, and the KDF parameters bounded on read.
- `.tkb` backup:
  - a fresh 32-byte data key and 24-byte nonce;
  - per-slot nonces, a fresh 16-byte Argon2 salt per recovery-code slot, and a 32-byte HKDF salt
    per passkey slot;
  - the slot AAD binds the backup id and slot type;
  - the recovery code is 120 random bits, so its strength does not rest on the KDF.
- Silent-payments scan key at rest: a random 32-byte file key, a fresh 24-byte nonce per
  registration, and AAD binding the phone and `B_spend`.
- Web sessions: 32-byte tokens stored as sha256, idle and maximum expiry. The pairing secret is
  32 bytes, compared in constant time, with a 5-minute TTL and 5 failures. The pairing session id
  is 12 bytes, message ids 16 bytes, temp file names 6 bytes (not security-relevant), and
  secure-store key tags 8 bytes.
- Passkey challenge and PRF salt: `secureRandomBytes`.

**Storage and lifetime**
- Seeds, data keys and KEKs are zeroed in `finally` blocks throughout. The signer copies its key
  and wipes it on lock.
- The guardian's log redaction drops any field whose name matches
  `pass|secret|seed|mnemonic|priv|key|psbt|token|auth|cookie`. `RandomSourceError` messages carry no
  random bytes. `key3Mix` errors do not echo the value.
- `c`, its context and the nostr key are stored unencrypted, by design and as documented. The scan
  key is outside the passphrase, as documented.

**Tests run**

`npm ci`, then `vitest run` in:
- `packages/core`: 52 passed, 79 skipped (the consensus verifier is not built). This includes
  `random.test.ts` and the lint.
- `packages/protocol`: 143 passed.
- `apps/guardian`: 311 passed, 1 skipped.

`random.test.ts` covers zero-filled, stuck, repeated and replaced sources, a missing source, a
throwing source, short draws, lengths out of range, `secureRandomInt` range and coverage, and
scalar redraw. It does not cover a cycling or low-entropy source (see L3).
