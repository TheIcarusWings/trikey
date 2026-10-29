# Trikey — design

Trikey is a Bitkey-style 2-of-3 bitcoin wallet in which **every key belongs to
the user**. No company runs a server, a guardian or a cosigner for anyone.

```
Key 1  Hardware wallet     any device: Ledger, Trezor, Coldcard, BitBox02, Jade, Keystone, Passport, SeedSigner, Krux
Key 2  Phone key           in the mobile app, behind Face ID
Key 3  Trikey Guardian     an app on the user's own Umbrel or Start9

Vault: wsh(sortedmulti(2, key1, key2, key3))
```

The guardian does what Bitkey's server does: it co-signs phone-only payments
under a daily limit and runs Delay & Notify recovery. The difference is that it
runs on the user's own home server.

Visual walkthrough (private canvas): https://claude.ai/artifact/NV7SCZja8ik9LAvuCPgegx

## Decisions so far

| Topic | Decision | Why |
|---|---|---|
| Script | Plain `wsh(sortedmulti(2,…))`, BIP48 paths (`m/48'/coin'/0'/2'`) | The only script every hardware wallet can co-sign, Trezor included. Miniscript, taproot multisig and MuSig2 all exclude major devices. |
| Key 3 | Trikey Guardian on the user's Umbrel or Start9 (both in the MVP) | Bitkey's features with no third party |
| No home server | Recovery Key mode (below) | Same script; Bitcoin's timelock rules enforce the limit |
| Key 2 backup | Encrypted cloud backup, unlocked by passkey | The user picks the cloud. Losing the backup is survivable: see the recovery flows. |
| Optional extra | Timelocked heir/backstop path for miniscript-capable devices | Opt-in only, so the default stays universal |
| First client | React Native mobile app | Ledger Bluetooth and Trezor Connect have JS SDKs |
| UI kit | shadcn/ui: react-native-reusables + NativeWind in the app, shadcn/ui + Tailwind in the guardian web UI. Zinc neutrals, Geist type, light and dark themes. | One set of tokens and components across the phone and the home server |
| Transport | Nostr: NIP-44 encryption inside NIP-59 gift wraps | Outbound-only connections, no accounts, relays see ciphertext |
| Later | Guardian for family (invite-only hosting) | See the end of this document |

Options considered and dropped, with research in the earlier pages under `docs/`:
- company cosigner (Bitkey's model);
- threshold guardians run by providers;
- miniscript multi-guardian;
- timelock-only;
- pre-signed vaults;
- covenants, which are not active on Bitcoin.

## Components

```
Phone app (key 2) ──┐                           ┌── Trikey Guardian (key 3) ── Bitcoin Node + Electrs
                    ├── nostr relays (E2EE) ────┤        on the same Umbrel / Start9
Hardware (key 1) ───┘   outbound only           └── alerts: nostr DMs to the user's devices and contacts
```

### Mobile app (React Native)
- **Key 2:** BIP39 seed, encrypted at rest with a key from the Secure Enclave or Android Keystore. Those chips can't hold secp256k1 keys directly, so they wrap the seed instead. Unlocking needs biometrics.
- **Hardware wallets:**
  - Ledger over Bluetooth (`@ledgerhq/device-signer-kit-bitcoin`);
  - Trezor via `@trezor/connect`;
  - air-gapped devices via PSBT QR (UR/BBQr).
- **Wallet registration** on devices that need it (Ledger, BitBox02, Jade, Coldcard), plus showing the first address on the device.
- **Cloud backup of key 2 + the descriptor:**
  - XChaCha20-Poly1305 under a random data key;
  - the data key is wrapped by a passkey PRF slot (WebAuthn L3, iOS 18+, Google Password Manager);
  - more unlock slots can be added later, such as a Recovery Code.

### Trikey Guardian (Docker container)
- **Packaging:** one image, shipped as an Umbrel app (`umbrel-app.yml`, depending on `bitcoin` + `electrs`) and a Start9 service package.
- **Chain data and broadcasting** go through the local node and Electrs. No public servers are used.
- **Web UI on the box:**
  - pairing QR;
  - status (locked or unlocked);
  - activity log;
  - current rules;
  - recoveries in progress.
- **Keeps key 3 only in memory.** On disk it is encrypted. After any restart the guardian is *locked* until the user unlocks it with:
  - **the hardware wallet:** a deterministic secret obtained over the phone. The mechanism is still open; see "Open questions".
  - **or a passphrase:** stretched with Argon2id.
  
  A stolen, unplugged box is useless.
- **Holds no backup of key 3.** If the box dies, phone + hardware sweep to a new wallet with a fresh guardian ("Replace guardian").

## Rules the guardian enforces

The rules follow Bitkey's own spend rules and recovery code (`server/src/api/mobile_pay/src/spend_rules`, `server/src/api/recovery`).

1. **Inputs belong to the wallet.** The guardian rebuilds every input script from the descriptor. It requires `nonWitnessUtxo` and checks it against the txid, which blocks the segwit v0 fee attack.
2. **One existing signature per input,** valid under `SIGHASH_ALL`.
   - **Phone signature:** the everyday path. It counts against the daily limit.
   - **Hardware signature:** only accepted as part of a recovery.
3. **Daily limit.** The guardian counts `Σinputs − Σchange` (the fee included) over a rolling 24 hours, keyed by outpoint:
   - a replayed transaction is never counted twice;
   - an RBF replacement counts as the larger of the old and new amounts.
4. **Loosening the rules needs the hardware wallet.** That covers raising the limit, shortening the delay, changing the sweep fee cap, and adding or removing alert contacts. The phone alone can only tighten: lower the limit or lengthen the delay.
   - **How the hardware wallet approves:** a BIP137 `signmessage` signature from a single-sig key recorded at pairing. Ledger, Trezor and Coldcard all support it. The signed text is one line that shows the new values in clear, so the user checks them on the device screen:
     `Trikey policy v1 wallet=<id> seq=<n> limit=<sats> delay=<d>d feecap=<sats> contacts=<k> hash=<policyHash> expires=<ISO8601Z>`
   - The guardian rebuilds this text from the request and never trusts text from the phone. The sequence number must increase (by at most 1000), and an approval is valid for at most 24 hours.
   - The wallet id in the text stops an approval from being replayed against another wallet that uses the same hardware key.
   - No rule changes are accepted while a recovery is running.
5. **Delay & Notify (7, 14 or 30 days, as in Bitkey):**
   1. A recovery starts with a sweep signed by the surviving key, going to a new wallet that keeps that key.
   2. Starting it pauses phone-only payments.
   3. The guardian then sends daily nostr DM alerts to every registered device and contact.
   4. Any of them can cancel. If the cancel comes from someone other than the holder of the key that started the recovery (a "contested" cancel), phone-only payments stay paused until the hardware wallet signs a `resume-phone` approval.
   5. After the delay, the guardian co-signs the sweep and broadcasts it.
6. **Sweep fee cap.** Recoveries can't burn funds through fees.

## Protocol (nostr)

- **Identity:**
  - The phone's nostr key is derived from the key 2 seed (NIP-06 path).
  - The guardian has its own key, shown in the pairing QR together with its relays.
- **Messages:** JSON-RPC rumors (kind 21420, in the ephemeral range) inside NIP-59 gift wraps (kind 1059), encrypted with NIP-44 to the guardian's pubkey. The full wire format is in [`packages/protocol/PROTOCOL.md`](packages/protocol/PROTOCOL.md).
- **Methods:**

  | Method | Purpose |
  |---|---|
  | `pair` | Pair the phone with the guardian |
  | `sign` | Ask for a co-signature |
  | `policy.get` | Read the current rules |
  | `policy.update` | Change the rules (hardware-signed) |
  | `recovery.start` | Start a recovery |
  | `recovery.cancel` | Cancel a recovery |
  | `recovery.status` | Check a recovery |
  | `guardian.unlock` | Unlock after a restart |
  | `guardian.status` | Read guardian state |

- **Every request carries:**
  - an id, so retries are idempotent;
  - a NIP-40 expiry;
  - the hash of the PSBT it refers to.
- **Replay protection:** old rumors are dropped.
- **Relays:** several, with the user's own relay optional (Umbrel has a Nostr Relay app).
- **No public standard exists** for PSBT exchange over nostr, so this is our own spec. Publish it as a NIP draft once it's stable.

## Recovery flows

| Situation | Keys | What happens |
|---|---|---|
| Everyday payment | phone + guardian | Within the limit, Face ID only |
| Big payment, raise the limit | phone + hardware | The guardian isn't involved |
| New phone, backup available | none | Restore key 2 with the passkey, no waiting |
| Lost phone, no backup | hardware + guardian | Delay & Notify, then a sweep to a new wallet |
| Lost hardware wallet | none, or phone + guardian | Restore the seed words, or use Delay & Notify |
| Someone fakes a recovery | any device or contact | Tap Cancel on the alert |
| Guardian offline or locked | phone + hardware | Phone-only payments wait until it's back |
| Guardian dies or is stolen | phone + hardware | "Replace guardian": sweep to a new wallet |

## Threat model

- **Stolen phone:** the thief can spend at most the daily limit. They can't raise it, because that needs the hardware wallet. A recovery they start triggers the alerts.
- **Burglary (phone + home server):**
  - An unplugged guardian is locked, so the burglar holds one usable key.
  - If the thief keeps the guardian powered, they can only reach the daily limit, and any recovery triggers the 7-day alerts.
  - Tell users to keep the hardware wallet's seed words outside the home.
- **Remote compromise of the home server** gives up one key of three. That's the same exposure as Bitkey's server being breached.
- **Malicious relays** can drop messages but can't read or forge them.
- **Contested recovery** (a thief cancels a genuine recovery): phone-only spending stays paused, so the thief can't drain either. Same as Bitkey.
- **The guardian's clock:** a recovery only completes once both the system clock and the chain's median time past have passed the end of the delay, so a clock pushed forward alone can't shorten it.
- **The web UI has no login of its own.** It relies on the platform's app proxy (Umbrel's `app_proxy`, Start9's interfaces) to authenticate, so the guardian's port must never be exposed beyond it.
- **The guardian's nostr key is stored unencrypted** (mode 0600), so a locked guardian can still answer the phone and receive an unlock. It can't sign transactions.
- **Electrs and the node are trusted** for chain data; headers are checked to link up but not for proof of work.
- **Nuisances, not thefts:**
  - Anyone who knows a wallet address can send a coin after a recovery starts. That blocks completion, because the sweep must spend every coin, until the user starts the recovery again.
  - Anyone who sees the guardian's npub on a relay can burn a 5-minute pairing code with wrong attempts.
  - Anyone with web access can delay unlocks through the rate limit.

## Recovery Key mode (no home server)

Built in [`packages/recovery-key`](packages/recovery-key) (`@trikey/recovery-key`). The app drives it through one facade, `RecoveryKeyWallet`, whose methods follow the `RK-*` screens.

- **Keys.** The vault is the same `wsh(sortedmulti(2, phone, hardware, recoveryKey))` on BIP 48 as guardian mode.
  - Key 1, the hardware wallet: its BIP 48 account key.
  - Key 2, the phone: one seed with two accounts. BIP 48 for the vault, BIP 84 (`m/84'/c'/0'`) for the **spending balance**, a single-key `wpkh` wallet the phone spends from with Face ID alone (it also restores in any BIP 84 wallet).
  - Key 3, the **Recovery Key**: a fresh 12-word BIP 39 seed made in memory and printed on the Recovery Kit, or a second hardware wallet, of which only the xpub is needed (the kit is then a wallet map with no secret). The user proves the kit is saved by typing three of its words or scanning the printout; then key 3 is wiped from the phone and only its xpub stays. (An NFC card is still a later option.)
- **Refills are a chain pre-signed by phone + hardware** (default 8 × 200,000 sats, weekly).
  - Refill *k* spends output 1 (the vault change) of refill *k−1* with `nSequence` = 1,008 (BIP 68, blocks), pays the refill amount to a fresh spending address (output 0) and the rest to a fresh vault change address. Segwit inputs only, so every txid is fixed before signing; the unsigned previous refill is each link's `nonWitnessUtxo`, so hardware wallets can check amounts.
  - Whoever holds the signed chain, at most one refill confirms in any 1,008-block window. The fake chain in the tests enforces BIP 68 and a thief broadcasting every refill every block gets exactly one per period.
  - **Refill 1 of the first batch has no timelock**, so the spending balance is usable the day the wallet is made (the screen says "Refill 1 · today"). A timelock there would only delay the owner: the thief's limit comes from the links. **Later batches do need one**, or a new batch would hand out a second refill inside the same period: their first refill carries `nLockTime` = last refill height + period − 1 (and `nSequence` = period when it spends an earlier refill's change). "Approve more" while the chain is live simply appends links to its last refill, so nothing is reset.
  - The phone only broadcasts a refill while the spending balance is below one refill, so unused refills do not pile up on the phone. The scheduler runs when the app opens or from a background task.
- **Fees** are fixed at signing and bumped by **CPFP**.
  - Pre-signed at the 6-block estimate, at least 3 sat/vB on mainnet (the minimum relay fee elsewhere), never more than 2% of the refill (a stored refill above 5% fails verification).
  - A stuck refill is sped up by a child spending its output 0, which the phone alone can sign; the child pays for parent + child at the current target (`speedUpRefill`). The scheduler offers it when a refill in the mempool is below the target.
  - Limit: a refill below the mempool's minimum fee cannot be bumped at all until package relay is available through the chain server (Esplora's `POST /tx` takes one transaction). Hence the floor. TRUC (v3) transactions plus package relay are the later fix.
- **Invalidation.** Any other spend of the chain's next input ends the chain. `payFromVault` spends coins the chain does not need first, so only a payment larger than those invalidates it, and it can sign a fresh batch from its change in the same hardware session. The app tells "my own payment or sweep" (a new batch is needed) from "a vault spend this phone did not make" (two keys are in other hands). A refill this phone did not broadcast is reported once as an unexpected broadcast.
- **The Recovery Kit** (format 1):
  - Payload: version, network, creation height, key 3 (16 bytes of entropy and its account, or an xpub record), the phone's and the hardware's account keys (74 bytes each: fingerprints, account, chain code, public key, so the descriptor comes back byte for byte), and a 4-byte checksum.
  - One QR code: `TRIKEYKIT1:` + base32, all QR alphanumeric characters, 25% error correction (65 × 65 modules).
  - Words for when the QR is damaged: the 12 Recovery Key words (a standard BIP 39 phrase) plus 116 "wallet map" words (the rest of the payload, 11 bits per BIP 39 word). Typos point at the word; four-letter abbreviations work.
  - The printed page (self-contained HTML) shows the title, date, network, the wallet fingerprint the app also shows, the QR, the words, the descriptor for other wallet software, and plain instructions, starting with "keep this sheet apart from your hardware wallet's seed words".
  - **Not encrypted by default.** A kit password would be one more thing to lose, and losing it turns the kit into nothing; the sheet alone moves nothing. Encryption would help only if the kit could be stored next to one of the other keys, which the instructions already forbid. The format reserves a flag for an optional passphrase later.
- **Chain data comes from an Esplora server** (`fetch` only, so it runs in Hermes). Defaults: mempool.space for signet and testnet4, blockstream.info for mainnet; the setting should point at the user's own server (Umbrel and Start9 both run one). A public server learns every address of the vault and the spending balance and the phone's IP address, so it can link them and watch every refill, but it cannot move or freeze coins. The server is trusted for confirmations and the tip, not for amounts: every coin signed for comes with its raw funding transaction checked against the txid.
- **Recovery is immediate,** with any two keys and no Delay & Notify. Each sweep moves every confirmed vault coin and replaces a refill a thief left in the mempool. The fee follows the estimate, capped at 100,000 sats and 5% of the vault.

  | Situation | Keys | Destination |
  |---|---|---|
  | Phone lost or stolen | kit + hardware, on a new phone | an address, or a new vault (new phone key, same hardware wallet at the next BIP 48 account, new kit) |
  | Hardware wallet and its seed words lost | kit + phone | an address, or a new vault (new hardware wallet, new kit) |
  | Recovery Kit lost or seen | phone + hardware | a new vault with a new kit (same devices, next account) |

- **Stored state** is one JSON document with an HMAC under a key in the secure store, and the refill chain's links and signatures are checked again on every open.
- **The trade-offs:**
  - keep the Recovery Kit apart from the seed words; anyone with both takes everything, with no undo window;
  - approve new refill batches every couple of months;
  - a vault payment larger than the coins outside the chain forces a fresh batch;
  - coins received after a batch stay outside the chain until the next fresh batch;
  - a thief with the phone gets the spending balance plus one refill per period until the owner sweeps;
  - a public chain server sees the whole wallet.
- **To check on real devices:** that each device signs inputs with `nSequence` = 1,008 and a non-zero `nLockTime`, and what it shows. Trezor needs the `sequence` passed explicitly when the PSBT is converted to its format. Ledger, Coldcard, BitBox02, Jade, Keystone and Passport sign PSBTs as given but may warn about the timelock. The test is to sign a batch on regtest or signet with each device, run every refill through `tools/consensus-verify`, and broadcast refill 2 before and after its 1,008 blocks.

## Later: guardian for family

Someone who runs a guardian can host one for a person they know.
- **How it works:** invite-only (QR or link), with a separate key per hosted wallet.
- **Privacy:** BIP 89 chaincode delegation (`packages/core/src/tweak.ts`) hides the guest's addresses and balance from the host.
- **The trust involved:** a dishonest host could skip the delay and suppress alerts while teaming up with a thief. The app must state this when an invite is accepted.
- **Later still:** two hosts could share the key 3 role.

## Open questions

1. **How the hardware wallet unlocks the guardian.** Rule changes now use BIP137 message signatures (see rule 4); which signing paths each device allows still has to be tested on real hardware. Unlocking with the hardware wallet is still open: Trezor has CipherKeyValue (SLIP-11), Ledger has no symmetric-key API. Until then, unlocking uses the passphrase.
2. **Notifications when the phone app is asleep.**
   - Nostr DMs reach the user's regular nostr app (zero infrastructure).
   - Real push on iOS needs Apple's push service, called with credentials only the app's publisher holds. That means running a stateless "empty ping" bridge, which conflicts with "we run nothing".
   - The guardian could also send email through the user's own SMTP settings.
3. **Defaults:** daily limit, delay (7 days?), relays.
4. **Start9 packaging details** (SDK version), and how the official Umbrel store submission works.

## Repository state

- `packages/core/`: descriptors (BIP380 checksum, BIP389 multipath), BIP48 wallets, PSBT build, sign, analyze and finalize, software signer. `tweak.ts` holds the BIP 89 tweak math, kept for family hosting.
- `packages/protocol/`: the nostr RPC (schemas, gift-wrap transport, replay guard, client and server, pairing URI, NIP-06 phone identity, an in-memory relay for tests). Spec in `PROTOCOL.md`.
- `apps/guardian/`: the guardian. `src/policy/` is the policy engine (spend checks, daily limit, rule changes with BIP137 approvals, Delay & Notify). Around it: key storage (Argon2id, m=64 MiB, t=3, then XChaCha20-Poly1305), lock/unlock, the nostr RPC server, NIP-17 alert DMs to contacts, an Electrum client (sweep completeness, broadcast, chain time) and the HTTP API for the web UI. Entry point `src/main.ts`.
- `apps/guardian-web/`: the guardian's web UI. Its API is in `API.md`.
- `apps/mobile/`: the React Native app. Every screen is built, on sample data; wallet, hardware and backup wiring are next.
- `packaging/`: Docker image, Umbrel community app store entry, Start9 package skeleton.
- `tools/consensus-verify/`: Rust tool that checks transactions against libbitcoinconsensus (Bitcoin Core's script verifier). It builds; tests don't use it yet.
- `design/`: the screen designs. `docs/`: earlier design pages (key 3 options, the refill design).

## MVP build order

1. **Guardian core** (TypeScript): nostr RPC, pairing, policy engine, Delay & Notify, lock/unlock, Electrs client. Integration tests against a local relay and libbitcoinconsensus.
2. **Packaging:** Docker image, then an Umbrel community app store entry, then a Start9 package.
3. **Mobile app:**
   - onboarding (hardware pairing, guardian pairing, backup);
   - home, send and receive;
   - recovery flows;
   - settings (limit, delay, contacts).
4. **Testnet and signet beta,** then an independent security review before mainnet.
