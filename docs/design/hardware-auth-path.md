# The hardware authorization key path on Trezor, Ledger and QR devices

Status: sections 1-6 written 2026-10-31 against `main` at 0.1.5; section 7 (QR devices, built) added 2026-11-06;
section 8 (Coldcard over NFC, built) added 2026-11-06.
Device behaviour was read from firmware and SDK source, not tested on hardware.

A code audit flagged an unconfirmed risk: that Trezor refuses `signMessage` at our authorization key path
with "Forbidden key path" under the default Strict safety checks. **It does not.** No Trezor refuses the
path. Trezor firmware before core 2.13.0, and every Model One firmware, shows a path warning first; the user
must accept it before the device signs. Ledger signs with no warning. The recommendation is to keep the path,
because moving it would break a security check on the guardian, and to make small phone-side changes.

## 1. What we sign with

`authKeyPath()` (`packages/wallet/src/keys.ts`) is `<BIP 48 account>/0/0`, so `m/48'/0'/0'/2'/0/0` on
mainnet and `m/48'/1'/0'/2'/0/0` on test networks. That key is the hardware key in the wallet's first
receive address. The phone derives its pubkey from the BIP 48 account xpub it already has, with no extra
device call (`readHardware`, `packages/wallet/src/wallet.ts`). It signs pairing proofs, the rules a wallet
starts with (the policy text with `seq=0`, at `pair`, `wallet.add` and `hosted.pair`, since the 2026-11 security
review; DESIGN.md rule 4), `hardware.confirm` proofs, approvals and recovery access with
`hw.signMessage(rec.auth.path, text)` (`signWithAuthKey`, same file). The guardian requires this key to sit below the hardware account by non-hardened steps and to
derive from the hardware xpub in the descriptor (`authKeyMismatch`, `apps/guardian/src/policy/engine.ts`).

- Trezor: `TrezorSigner.signMessage` calls `connect.signMessage({ path, coin, message })` with no
  `scriptType` (`apps/mobile/src/hardware/trezor/signer.ts`).
- Ledger: `LedgerSigner.signMessage` sends the path and text to the Bitcoin app
  (`apps/mobile/src/hardware/ledger/signer.ts`).

## 2. Trezor

### What Connect sends

When no `scriptType` is given, Connect infers it from the path and changes SPENDMULTISIG to SPENDADDRESS.
From `@trezor/connect-core` 10.0.1, `lib/api/signMessage.js`:

```js
const scriptType = payload.scriptType || getScriptType(path);
...
script_type: scriptType && scriptType !== 'SPENDMULTISIG' ? scriptType : 'SPENDADDRESS',
```

`getScriptType` (`@trezor/connect-common` 10.0.1, `lib/utils/pathUtils.js`, installed in our
`node_modules`) maps `48'/x'/x'/2'` to `'SPENDWITNESS'`. So for our path Connect sends **SPENDWITNESS**.
The `SignMessage` params schema accepts an explicit `scriptType`. SPENDMULTISIG would be sent as
SPENDADDRESS, and core's `sign_message` raises "Unsupported script type" for anything other than
SPENDADDRESS, SPENDP2SHWITNESS or SPENDWITNESS.

### Core firmware (Model T, Safe 3, Safe 5)

`sign_message` runs
`await validate_path(keychain, address_n, validate_path_against_script_type(coin, msg))`
([sign_message.py](https://github.com/trezor/trezor-firmware/blob/main/core/src/apps/bitcoin/sign_message.py)).
`validate_path` ([paths.py](https://github.com/trezor/trezor-firmware/blob/main/core/src/apps/common/paths.py))
handles two separate cases:

```python
keychain.verify_path(path)          # Strict + path not in keychain -> "Forbidden key path"
if not keychain.is_in_keychain(path) or not all(additional_checks):
    await show_path_warning(path)   # otherwise: warning screen the user can accept
```

The Bitcoin keychain always includes `PATTERN_BIP48_SEGWIT = "m/48'/coin_type'/account'/2'/change/address_index"`
for segwit coins, Testnet included
([keychain.py](https://github.com/trezor/trezor-firmware/blob/main/core/src/apps/bitcoin/keychain.py),
`_get_schemas_for_coin`). So our leaf path is never Forbidden. The only question is the script-type check:

- **Up to core 2.12.5:** for SignMessage with SPENDWITNESS, `validate_path_against_script_type` accepted
  only the single-sig patterns (BIP 84 and GreenAddress), so the leaf failed the check and the device warned.
  Trezor's own device test at the parent of the fix
  ([test_signmessage.py @ f6cf509](https://github.com/trezor/trezor-firmware/blob/f6cf509/tests/device_tests/bitcoin/test_signmessage.py))
  records it:
  `pytest.param("m/48h/0h/0h/2h/0/0", S.SPENDWITNESS, WARN, id="leaf_2h-segwit")`, where
  `WARN` means "Signs, but shows the unknown derivation path screen first". All three script types gave WARN
  for the leaf. Only the account node `m/48h/0h/0h/2h` was FORBIDDEN ("Not in the keychain, so refused
  outright rather than warned about").
- **Core 2.13.0 and later** (tag `core/v2.13.0`, changelog dated 21 October 2026: "Allow signing messages
  with multisig keys and exportable account nodes. [#7717]"). Commit
  [d4e4d13](https://github.com/trezor/trezor-firmware/commit/d4e4d13) adds:

  ```python
  if SignMessage.is_type_of(msg):
      patterns |= _get_patterns_for_script_type(coin, script_type, multisig=True)
  ```

  With SPENDWITNESS this pulls in `PATTERN_BIP48_SEGWIT`. The test now lists
  `pytest.param("m/48h/0h/0h/2h/0/0", S.SPENDWITNESS, id="leaf_2h-segwit")` under `VECTORS_BIP48_SIGNS`
  ("no warning"). The other script types at this leaf still warn (`VECTORS_BIP48_WARN`), so on 2.13.0
  SPENDWITNESS, which is what Connect sends, is the only one that signs without a warning.

The Prompt safety level changes nothing here. It skips only the Forbidden check; the warning comes from the
script-type check, which runs at every level.

### Model One (legacy firmware, up to 1.14.2)

`fsm_msgSignMessage` calls `fsm_checkCoinPath(coin, msg->script_type, ..., has_multisig=false, ...,
show_warning=true)` ([fsm_msg_coin.h](https://github.com/trezor/trezor-firmware/blob/main/legacy/firmware/fsm_msg_coin.h)).
In `coin_path_check` ([crypto.c](https://github.com/trezor/trezor-firmware/blob/main/legacy/firmware/crypto.c)),
the BIP 48 branch with `full_check` requires `valid = valid && has_multisig;`, which a message never has.
The structural (non-full) check passes, so Strict does not answer "Forbidden key path". The device shows
`fsm_layoutPathWarning()`: **"Wrong address path for selected coin. Continue at your own risk!"**, without
the path, then the address and the message. Commit d4e4d13 touched only core, so this holds for 1.14.2.
Connect also caps Model One messages at 1024 bytes (`validateModelOneMessageSize`); ours are at most 240.

## 3. Ledger (Bitcoin app 2.x, Flex included)

`handler_sign_message`
([sign_message.c](https://github.com/LedgerHQ/app-bitcoin-new/blob/develop/src/handler/sign_message.c),
app 2.5.1, same on `master`) has **no path check**: it formats the path, shows it and signs. The NBGL flow
(`ui_sign_message_and_confirm_flow`, `src/ui/display_nbgl.c`) shows two fields, "Path" and "Message content".
There is no unusual-path warning for message signing. A hash appears instead of the text only above
`MAX_DISPLAYBLE_MESSAGE_LENGTH (10 * MESSAGE_CHUNK_SIZE)` = 640 bytes (`src/ui/display.h`), or for
non-printable text. So our 216- and 240-character texts show in full. The signature header is
`27 + 4 + parity` (compressed P2PKH); Trezor's with SPENDWITNESS is 39-42. The guardian accepts 27-42
and verifies by pubkey (`apps/guardian/src/policy/bip137.ts`).

## 4. Verdict

| Device | At `m/48'/{0,1}'/0'/2'/0/0`, default settings |
|---|---|
| Ledger, Bitcoin app 2.x | Signs. Shows the path and the full text. No warning. |
| Trezor core 2.13.0+ (Safe 3/5, Model T if it gets 2.13) | Signs. No warning (Connect sends SPENDWITNESS). |
| Trezor core ≤ 2.12.5 | Unknown derivation path warning; signs once the user accepts it. |
| Trezor Model One, all firmware | "Wrong address path for selected coin" warning; signs once accepted. |
| Any Trezor, account node `m/48'/x'/0'/2'` (not our path) | ≤ 2.12.5 and Model One: Forbidden under Strict. |

## 5. Should the key move? No.

The obvious alternative is a BIP 84 key such as `m/84'/c'/0'/0/0`. It signs without a warning on every
Trezor (SPENDWITNESS matches `PATTERN_BIP84`) and on Ledger. It costs more than it gains:

1. **It breaks the binding the guardian checks.** Today the guardian accepts only a key that derives from
   the hardware xpub in the descriptor (`authKeyMismatch`), the same key the user checks with
   `displayAddress` on the device. A BIP 84 key is unrelated to the descriptor, so the guardian would have to
   take it on trust from the phone. A phone that is compromised at pairing, or at `hardware.confirm` after
   the hardware wallet is replaced, could then register a key of its own as the "hardware" key and approve
   policy loosening alone. Today that attack fails with "authorization key does not derive from the hardware
   xpub at its path". Restoring the binding would need an extra proof, such as a signature by a multisig
   leaf key over the BIP 84 pubkey, which brings back the very signature that warns.
2. **Privacy.** `m/84'/0'/0'/0/0` is the first receive address of the user's ordinary single-sig account
   in Trezor Suite and Ledger Live. The guardian, and anyone who reads its state, would learn it and could
   watch that address. A spare account such as `84'/c'/100'` avoids this but is still unbound (point 1).
3. **More device steps.** The phone can no longer derive the key from the xpub it already holds. It needs a
   separate public key export at a hardened path: another Suite Lite round trip on Trezor. Rotation with a
   replaced device loses the guardian's "expected key" (PROTOCOL.md, Wallet rotation, step 4).

Moving to a dedicated purpose would make every device warn, Ledger excepted. Moving to the account node gets
Forbidden on older Trezors. No other path is accepted cleanly by both vendors and still bound to the multisig.

The warning that remains is limited: Model One, and core devices not yet on 2.13.0. Trezor already fixed
it for core. It is handled better by telling the user what to expect than by weakening the guardian's check.

## 6. Recommendation and the code that changes

Keep `m/48'/c'/0'/2'/0/0`. No change to the protocol or the guardian, and no migration. Paired wallets
(0.1.x alpha) keep working as they are.

1. `apps/mobile/src/hardware/trezor/signer.ts`, `signMessage`: pass `scriptType: 'SPENDWITNESS'` when the
   path is `48'/x'/x'/2'/...`, so the warning-free behaviour on 2.13.0 does not depend on Connect's path
   inference. Add `scriptType?: 'SPENDWITNESS'` to `signMessage` in `apps/mobile/src/hardware/trezor/types.ts`.
   Update the expected call in `apps/mobile/src/hardware/trezor/trezor.test.ts`, which today uses an `84'`
   path. Better: test with the real auth path.
2. `apps/mobile/src/data/device.ts`, `signMessage` prompt: for Trezor, say before the device asks:
   "An older Trezor, or a Trezor Model One, first warns about an unknown or wrong path. That is expected
   for Trikey's key `<path>`; the newest Trezor firmware does not show it." Also show the address the
   device displays next: P2WPKH of the auth pubkey, which the phone can compute. The user can then check the
   key before accepting the warning. `signWithAuthKey` in `packages/wallet/src/wallet.ts` already emits the
   prompt; the address can be derived from `rec.auth.pubkey`.
3. `packages/wallet/src/keys.ts`, `authKeyPath` comment: replace "Devices may warn about an unusual path"
   with the facts above (Trezor ≤ 2.12.5 and Model One warn; Ledger and Trezor 2.13.0+ do not).
4. `apps/mobile/src/hardware/trezor/errors.ts`: keep the "forbidden key path" mapping. It is still right
   for other paths, and for the account node on older firmware.
5. `docs/alpha-test-plan.md`: add a Trezor step to sign a pairing proof on core 2.12.x, on 2.13.0 and on
   a Model One, and record which screens appear. Nothing in this note has been tested on a device yet.

Detecting the firmware version, to show the hint only when it applies, needs Connect `getFeatures` through
Suite Lite. Whether Suite Lite's deep link exposes it is unverified, so the hint above is worded to hold for
every model.

## 7. QR devices (built 2026-11-06; untested on devices)

Air-gapped devices sign the same text at the same path over a **text QR**, the format Sparrow and Specter use. The phone
shows one QR:

```
signmessage m/48h/<coin>h/<account>h/2h/0/0 ascii:<text>
```

and scans the answer: a QR of the base64 65-byte BIP 137 signature, or Coldcard's armored block
(`-----BEGIN BITCOIN SIGNED MESSAGE-----`, the text, then the address and the signature), which Coldcard writes over NFC
and to microSD. Every parser read accepts the `h` notation (Coldcard `cleanup_deriv_path`, Jade's libwally
`bip32_path_from_str`, Keystone, embit, Passport). The phone (`apps/mobile/src/hardware/qr/message.ts`,
`QrSigner.signMessage`) derives the expected key from the account xpub the device exported, and before returning the
signature checks that an armored block's text is Trikey's, that its address is the key's (legacy, nested or native
segwit), and that the signature verifies. A wrong key, path, account or text stays on the scan screen as a hint naming
the path, so the owner can sign again; `signWithAuthKey` then checks it once more. The device's header byte (31-34 for
the legacy address type every one of them writes for a `48'` path) is fine: the guardian takes 27-42.

The owner picks the model when adding the device (a key export that names it fills in "Other"; Settings changes it),
because the current `qr` kind does not say which device it is. The capability table is
`packages/wallet/src/qr-devices.ts`. From the firmware sources (Coldcard 09766a1, Jade a59d14c, Keystone 3 3690bf1,
Passport 83d1d576, KeyOS 4ea7bc9, SeedSigner ada81cd, Krux 28d14c2, Specter DIY bec1ab1):

| Model | Signs at `m/48'/c'/a'/2'/0/0` by text QR | What it shows; limits | Deterministic |
|---|---|---|---|
| Coldcard Q | Yes (`decoders.py`, no path check in `auth.py`) | Text, path, legacy address. 2-240 ASCII characters, no space at either end, never three in a row (`msgsign.py`) | RFC 6979 |
| Jade / Jade Plus | Yes, in QR mode (`qrmode.c`) | Text cut after about 188 characters with "...", the path, a hash; signs all of it | RFC 6979 (no anti-exfil over QR) |
| Keystone 3 | Yes in code (`qrcode/mod.rs`, `sign_msg` takes any path) | Text and path; no address for a `48'` path | RFC 6979 |
| Passport Prime | Yes, from the account the path names (`message_signing.rs`) | Text, path, legacy address | RFC 6979 |
| Specter DIY | Yes (`signmessage.py`) | Text, path, legacy address | RFC 6979 |
| Passport gen 2 | No: the QR flow maps `48'/x'/x'/2'` to P2WSH and stops before signing. **A microSD file works (built, below)** | Text in full (scrolled to the end), legacy address. No space at either end, at most 3 in a row, file ≤ 4096 bytes | RFC 6979 (trezor-crypto) |
| Krux | No: "Unsupported script type" for purpose 48 over QR. **A microSD file works (built, below)** | About 10 lines of text then "…" (M5StickV ~120 characters, larger screens ~210), legacy address | RFC 6979 (embit/libsecp256k1) |
| SeedSigner | No: "Not implemented" for `48h` paths. **Decided: payments only** (DESIGN.md) | | |
| Coldcard Mk4 | No camera: over NFC instead (section 8) | | |

Text lengths: Coldcard's 240 is exactly `MAX_APPROVAL_MESSAGE_LENGTH`, and the longest text Trikey can build (a version 3
policy approval with a 16-digit sequence) is 238 characters; a test (`packages/wallet/test/qr-devices.e2e.test.ts`)
fails if any text grows past the smallest limit. On Jade's screen the pairing text (114), notes key (60), unlock key
(156), cancel-recovery (about 135) and resume or retire (about 82) show in full; a policy approval (about 190-238) and
recovery access (199 or 223) are cut, with the values first and the end of `hash=` and `expires=` cut off. The phone
says so on Jade's screen.

Notes and hardware unlock sign the same text twice when they are turned on (`hardware_not_deterministic` if the two
differ); the QR screen says "(1 of 2)" and "(2 of 2)" and that the device will show the same text twice. Models that
cannot sign are refused with their reason, and the connect screen says so before a guardian wallet is started, offering
Recovery Key mode. Not built: Jade over USB, BIP 322 proofs (Jade over Bluetooth is section 9, BitBox02 section 10).
docs/alpha-test-plan.md step 18e lists the QR device tests, 18f the microSD ones; NFC is section 8 and step 18g,
Bluetooth section 9 and step 18h, BitBox02 section 10 and step 18i.

### microSD (Passport gen 2, Krux; built 2026-11-06, untested on devices)

Both refuse the key over a text QR because their QR flows take the address type from the path's purpose, and 48 is
multisig. Their microSD flows take it from the file, and sign at any path. The capability table marks them
`messageMethod: 'microsd'`; `QrSigner.signMessage` dispatches on it to one *file request* on the QR bridge
(`apps/mobile/src/hardware/qr/sd-message.ts`, `bridge.ts`, `ui/qr-bridge-host.tsx`, `platform/device-files`).

**Passport gen 2** (passport2 83d1d576). Account Tools > Sign a Message > Sign with microSD
(`menus.py` `sign_message_submenu`) opens `HealthCheckMicrosdFlow(normal_signing=True)`
(`flows/health_check_microsd_flow.py`):

- The file list hides names with `-signed` (`is_signable`); the read stops at `MSG_SIGNING_MAX_LENGTH` = 4096 bytes and
  must be UTF-8.
- `HealthCheckCommonFlow.validate_lines` (`flows/health_check_common_flow.py`): `splitlines`, then 2 or 3 lines: the text,
  the path, and an optional address type (`get_addr_type_from_string`; default `AF_CLASSIC`, legacy). A file that starts
  with `signmessage ` is read as Sparrow's one-line request instead, whose address type comes from the path (P2WSH for
  ours: it fails), so Trikey never writes one. `validate_sign_text` (`utils.py`): printable ASCII, no space at either
  end, fewer than 4 spaces in a row; the path must start with `m` and `cleanup_deriv_path` takes `h`.
- It shows the text (`LongTextPage`, scrolled to the end) and "Sign message with this address?" with the legacy
  address, signs (`sign_text_file_task` → `sign_message_digest_recoverable` → trezor-crypto `ecdsa.sign`, header 31-34;
  `ecdsa_sign_digest` under `USE_RFC6979 1`, or `zkp_ecdsa_sign_digest`, libsecp256k1's default nonce), and writes
  `RFC_SIGNATURE_TEMPLATE` (`public_constants.py`: the armored block with the text, the address and the base64
  signature) to `<name>-signed-NNN.<ext>` next to it (`pick_filename` numbers from 001 and requires an extension). No
  QR of the answer.

Trikey writes `<text>\n<m/48h/<coin>h/<account>h/2h/0/0>\n` as `trikey-<purpose>.txt`.

**Krux** (krux 28d14c2). Sign > Message > Load from SD card (`pages/home_pages/sign_message_ui.py`):

- `_sign_at_address_from_sd`: every line stripped, empty lines dropped; the last line must be `p2pkh`, `p2sh-p2wpkh`,
  `p2wpkh` or `p2tr`; the one before it the path (`_is_valid_derivation_path`: `m`, then numbers with `'`, `h` or `H`);
  the lines before that are the text, joined by `\n`. The network comes from the path's coin type.
- It shows "Message:" with the text (`max_lines` = `TOTAL_LINES - 10`, or `- 7` on the M5StickV and Cube, then "…":
  about 120 characters on the M5StickV's 16-character lines, about 210 on the others for Trikey's texts, which wrap at
  spaces), "Address:" with the address of the named type, then "Sign?". It signs with `key.sign_at` (embit
  `secp256k1.ecdsa_sign_recoverable`, no nonce data: RFC 6979; header `27 + 4 + recid` whatever the type).
- It then offers "Sign to QR code" (a plain QR of the base64 signature) or "Sign to SD card": the armored block, no
  final newline, as `<name>-signed.txt` (`SIGNED_FILE_SUFFIX`; the name is prefilled on the device's keypad).
- A file that is not in that form falls through to `sign_standard_message`: the screen shows "SHA256:" and a hash, it
  signs that with the *account* key (DER) and writes a `.sig` file. The steps tell the owner to stop there, and the
  phone refuses a `.sig`.

Trikey writes `<text>\n<path>\np2pkh\n`: P2PKH because the header Krux writes is P2PKH's in BIP 137, so the armored
file verifies in any BIP 137 tool, and the address shown is the legacy one the other devices show for this key.

**The phone.** "Save the file" (`Directory.pickDirectoryAsync`: the card in a reader, or Files) or "Share the file"
(share sheet, a copy in its own cache folder, cleared before each share and at start); then "Open the signed file"
(document picker), or on Krux "Scan the signature instead". `parseSignedFile` refuses Trikey's own request, a `.sig` or
`.pub`, an empty, binary or oversized file, and in round 2 of 2 the signed file of round 1 (by its name); the armored
block's text must be Trikey's and its address the key's, and the signature must verify against the key derived from the
device's xpub (`checkMessageAnswer`). Each refusal is a hint on the same screen, never a silent accept. Notes keep the
double signature (two files): both firmwares are RFC 6979 by their source, so one would probably do, but the second
signature is what checks it on the owner's own device, and it is asked once.

**Afterwards, the card.** The signed file stays on the card, and for the notes that signature is the key (HKDF of
`r || s`, DESIGN.md "Notes that survive recovery"): with it and a copy of the guardian's `labels/` folder anyone reads
the notes. So once the signature checks, the phone puts a *notice* on the bridge before it returns it
(`sdCleanupNotice`): "Delete these files from the card now, and from any computer or email you copied them through",
the request and the signed file by name (the signed one as the file chooser named it: Passport `<name>-signed-001.txt`,
Krux `<name>-signed.txt`; only the request after Krux's Sign to QR code), one button, "I deleted them", no cancel. For
the notes it says "They can open your notes"; for the other texts that Trikey does not need them again. DESIGN.md,
"Cleaning up the card".

Not offered: hardware unlock (a card round trip after every guardian restart; the passphrase works).

## 8. Coldcard over NFC (built 2026-11-06; untested on devices)

The Coldcard Mk4 has no camera; it and the Coldcard Q have NFC. Trikey talks to them over it as a hardware kind of its
own, `coldcard-nfc` (`packages/wallet/src/nfc-devices.ts`; the phone side is `apps/mobile/src/hardware/nfc`), which
does everything a Ledger or Trezor does: key export, wallet registration, payments and Trikey's texts. Read from
Coldcard's firmware `master` 09766a1 (2026-11-04, github.com/Coldcard/firmware); **not tried on a device or a phone**.

**The link.** The Coldcard's NFC chip is an ST25DV64KC that plays an **NFC Forum Type 5 tag** (NFC-V, ISO 15693, 8 KiB),
not a Type 4 tag (`shared/nfc.py:1-9`; `docs/nfc-coldcard.md`, "Lower Layers"). The radio is off except while a menu
shares or waits (`set_rf_disable`, `nfc.py:144-166`), and NFC Sharing is off by default (Settings › Hardware On/Off,
`flow.py:144`). Either the Coldcard **shares**: it writes NDEF records behind a read-only capability container
(`CC_FILE`, `ndef.py:14`) and keeps them up until the owner presses OK or X (`share_loop`, `nfc.py:228-237`); or it
**receives**: it offers an empty writable tag (`CC_WR_FILE`, `ndef.py:17-20`), waits for the phone to write, and reads it
once the radio has been quiet for 3 seconds (`start_nfc_rx`, `nfc.py:492-523`, `min_delay=3000`), then wipes the tag.
Records are built by `ndefMaker` (`ndef.py:22-104`) and parsed by `record_parser` (`ndef.py:142-227`), which refuses
chunked records. The phone's OS (Android `Ndef`, iOS `NFCNDEFTag`) handles the capability container and the TLV; Trikey
reads and writes the NDEF message (`apps/mobile/src/hardware/nfc/ndef.ts`).

| Step | Coldcard menu | Phone | Records | Firmware |
|---|---|---|---|---|
| Key export (connect) | Settings › Multisig Wallets › Export XPUB, account, then 3 (Mk4) or NFC (Q) | reads | `application/json`: `{"p2wsh_deriv", "p2wsh" (SLIP-132 Zpub/Vpub), "p2wsh_desc", "account", "xfp"}` | `multisig.py:1590-1654` (`export_multisig_xpubs`), `export.py:69-71`, `nfc.py:368-373` (`share_json`) |
| Wallet registration | Settings › Multisig Wallets › Import, then NFC | writes | text: the Coldcard multisig setup file, as Trikey shows over QR | `nfc.py:637-658` (`import_multisig_nfc`: first record of 70+ bytes holding `pub` or `multi(`), `multisig.py:1447, 1992-2003` |
| Payment | Advanced/Tools › NFC Tools › Sign PSBT | writes | `urn:nfc:ext:bitcoin.org:sha256` (32 bytes), `urn:nfc:ext:bitcoin.org:psbt` (binary) | `nfc.py:525-576` (`start_psbt_rx`: any record over 100 bytes that tastes like a PSBT; the sha256 record is checked, "PSBT checksum mismatch", `auth.py:396-399`); menu `flow.py:396-405` |
| Signed payment | shared right after approval | reads | text label, `bitcoin.org:sha256`, `bitcoin.org:psbt`; or, finalized, text, `bitcoin.org:txid`, `bitcoin.org:sha256`, `bitcoin.org:txn` | `auth.py:893-949` (`done_signing`, same way out as in), `nfc.py:239-255` (`share_signed_txn`), `nfc.py:354-366` (`share_psbt`) |
| Text to sign | Advanced/Tools › NFC Tools › Sign Message | writes | text: `signmessage m/48h/<coin>h/<acct>h/2h/0/0 ascii:<text>` | `nfc.py:705-719` (`start_msg_sign`: 1 to 3 lines), `msgsign.py:296-308` (`parse_msg_sign_request`, Sparrow form first), `msgsign.py:265-283` (text rules), `auth.py:152-214` (`ApproveMessageSign`, no path check) |
| Signature | shared right after OK | reads | text: the armored block (`-----BEGIN BITCOIN SIGNED MESSAGE-----`, text, P2PKH address, base64 signature) | `nfc.py:721-726` (`msg_sign_done`), `msgsign.py:18-29` |

Sizes: the Coldcard shares nothing of `MAX_NFC_SIZE` = 8000 bytes or more (`nfc.py:23`, "PSBT is too large to share via
NFC", `nfc.py:356-358`). The phone refuses up front a PSBT whose signed copy would reach it (about 110 bytes per input
the Coldcard signs, `PSBT_SIGNATURE_BYTES`), with "spend fewer coins" in words; in practice that is a few dozen inputs.

**What the phone checks**, as over QR: the export must name the device's fingerprint and hold the account asked for; a
signed PSBT must carry a valid signature of this fingerprint on every input it owns (`assertDeviceSignedAll`), and a
SHA-256 record, when present, must match; an armored answer must carry Trikey's text, an address of the key at the path
(legacy, nested or native segwit) and a signature that verifies against the key derived from the account xpub
(`checkMessageAnswer`); `signWithAuthKey` checks it once more. A wrong answer stays on the screen as a hint. When the
wallet connects its own Coldcard again it passes what it knows (`KnownHardware`: fingerprint and account key), so a
payment or a text is one send and one read, without reading the export first; the checks above are what keep a wrong
Coldcard out.

**The tap**, as the owner sees it: the phone shows the Coldcard menu to open and a button, **Send to the Coldcard** or
**Read from the Coldcard**. On Android the app says "Hold the phone to the Coldcard…" (reader mode, NFC-V only, so no
other app is offered the tag); on iOS the system's own "Ready to Scan" sheet appears. Where to hold it
(`docs/nfc-coldcard.md`): a Mk4 over the 8 key, a Q on the screen. NFC off, the phone moving away, the wrong thing
shared: a hint and **Try again**; Android also offers its NFC settings.

**Platform.** `react-native-nfc-manager` 4.2.0 (MIT; Android `android.nfc`, iOS Core NFC; its Android dependencies are
React Native and the Kotlin standard library only, so the build without Google code keeps it; a test checks its manifest
and Gradle file). Android: the library's manifest asks for `android.permission.NFC` and declares `android.hardware.nfc`
**not required**, so phones without NFC still install the app. iOS: Core NFC needs the "NFC Tag Reading" capability
(`com.apple.developer.nfc.readersession.formats` = `TAG`; App Store Connect refuses `NDEF` there for recent SDKs, and
`TAG` covers the NDEF session the library opens) and `NFCReaderUsageDescription`. A free Apple developer account
("personal team") cannot sign that capability, so it is **off by default**: only `TRIKEY_IOS_NFC=1`
(`apps/mobile/ios-nfc.js`) writes the entitlement and the usage text (`plugins/with-ios-nfc.js`) and links the library
on iOS (`react-native.config.js`); without it the iOS build has no NFC code at all, CI checks there is no NFC
entitlement or pod, and the app lists "Coldcard by NFC" as unavailable with the reason. At run time the app asks the
library whether NFC is supported and on.

**Not done, or to check on a device:** that Core NFC writes NDEF to the Coldcard's Type 5 tag (the firmware's notes say
phones handle NFC-V; writing from an iPhone is untested); how long a large PSBT takes; whether Android's NDEF stack
writes the 3-byte TLV length the Coldcard's `ccfile_decode` reads (it should: it is the NFC Forum T5T format);
Coldcard's PushTx and "Verify Address" over NFC are not used. USB (Mk4 over Android OTG) is not built.

## 9. Jade over Bluetooth (built 2026-11-06; untested on devices)

A Blockstream Jade or Jade Plus over Bluetooth LE (or another board running Jade's firmware with Bluetooth) is a hardware kind of its own, `jade-ble`
(`packages/wallet/src/ble-devices.ts`; the phone side is `apps/mobile/src/hardware/jade`). Like a Ledger it does
everything for Trikey: key export, wallet registration, payments and Trikey's texts. In QR mode the same Jade keeps
working as before (section 7). Read from github.com/Blockstream/Jade at a59d14c (1.0.41, 2026-10-23): the firmware
(`main/`), its RPC documentation (`docs/index.rst`) and its Python client (`jadepy/`); the PIN server from
github.com/Blockstream/blind_pin_server at 62f97a1. **Not tried on a device or a phone.**

**The link.** One GATT service, 6e400001-b5a3-f393-e0a9-e50e24dcca9e, which the Jade advertises with its name ("Jade"
and six hex digits; `main/ble/ble.c:40-50, 246-261`; `jadepy/jade_ble.py:28-31`). The phone writes requests to
6e400002-… (write with response) and the Jade answers by indications on 6e400003-… (`ble.c:125-148`). Both
characteristics need an encrypted, authenticated link (`BLE_GATT_CHR_F_WRITE_ENC | _AUTHEN`, `READ_ENC | _AUTHEN`), so
the first subscription or write makes the phone pair: LE Secure Connections with numeric comparison, bonding and MITM
protection (`ble.c:502-515`; `BLE_SM_IOACT_NUMCMP` at `ble.c:724-783` shows the number on the Jade for the owner to
confirm; the phone shows the same number in its own system dialog). A write carries at most MTU - 3 bytes, never more
than 512 (`ble.c:69-79`; jadepy writes 509-byte pieces with response, `jade_ble.py:31, 192-226`); Android asks for a
517-byte MTU, iOS picks its own. The Jade's indications are cut the same way (`write_ble`, `ble.c:300-330`).

**The messages.** CBOR maps, roughly JSON-RPC (docs/index.rst lines 13-21): a request `{id, method, params}` with an id
of 1 to 16 characters and a method of at most 32 (`main/utils/cbor_rpc.c:92-124`), a reply `{id, result}` or `{id,
error: {code, message, data}}`; `{log}` lines in between are skipped (`jadepy/jade.py:2334-2381`). There is no length
prefix: the Jade parses a message when its CBOR is complete and drops an incomplete one after 2 s of silence (3 s on the
first Jade; `main/wire.c:23-46, 103-173`), so the phone writes each message in one go and finds the replies' boundaries
the same way (`apps/mobile/src/hardware/jade/cbor.ts`, `rpc.ts`). A request is at most `MAX_INPUT_MSG_SIZE` (401 KiB on
units with PSRAM, as Jade's boards have; 17 KiB without) and a reply at most 3 KiB (`main/process.h:17-34`), so a
signed PSBT comes back in parts: `seqnum`/`seqlen` on each reply and `get_extended_data {origid, orig, seqnum, seqlen}`
for the next (`main/process/sign_psbt.c:43, 1269-1310`; docs/index.rst lines 43-84; `jade.py:1979-2026`). Error codes
(`cbor_rpc.h:13-23`): -32000 the owner declined, -32002 locked, -32003 another network, and the JSON-RPC ones.

| Step | Request | What the Jade does | Firmware |
|---|---|---|---|
| Version and state | `get_version_info` | `JADE_VERSION`, `JADE_STATE` (LOCKED, READY…), `JADE_INTERFACE` (BLE, QR, SERIAL), `BOARD_TYPE` (JADE_V2 is the Jade Plus) | `main/versioninfo.c:64-73`, docs/index.rst 134-183 |
| Unlock | `auth_user {network, epoch}`, then `pin {data}` | Asks the PIN on its own screen; answers `true`, `false` (wrong PIN) or an `http_request` (below) | `main/process/auth_user.c:399-503`, `pinclient.c` |
| Fingerprint | `get_xpub {network, path: []}` | The root xpub (allowed for this call only); the phone takes HASH160 of its key | `main/process/get_xpubs.c:22-35` |
| Account key | `get_xpub {network, path}` | The xpub at `m/48'/c'/a'/2'` (tpub on test networks) | same |
| Wallet | `register_multisig {network, multisig_name, descriptor: {variant: "wsh(multi(k))", sorted: true, threshold: 2, signers: [{fingerprint, derivation, xpub, path: []}]}}` | Checks its own key is a signer (`validate_signers`), shows the wallet, keeps it; the same wallet again returns at once | `main/process/register_multisig.c:27-136, 552-740`, `main/signer.c:10-84` |
| Address | `get_receive_address {network, paths: [[chain, index] ×3], multisig_name}` | Derives the address from the registered wallet and shows it; the phone compares it with its own | `main/process/get_receive_address.c:60-89, 256-260` |
| Payment | `sign_psbt {network, psbt}` | Shows the payment, signs its inputs (RFC 6979 with low-R grinding), returns the PSBT in parts | `main/process/sign_psbt.c:1100-1104, 1221-1310` |
| Text | `sign_message {path, message}` (no `ae_host_commitment`) | Shows the text (188 characters, then "..."), the hash and the path; returns the base64 65-byte signature | `main/process/sign_message.c:150-315`, `main/wallet.c:1485-1531` |

Network names (`main/utils/network.c:14-21`): `mainnet`; `testnet` for testnet and signet (the same `tb` addresses);
`localtest` for regtest. The wallet name is a storage key on the Jade: 1 to 15 characters from `!` to `~`, no space
(`main/storage.c:418-435`, `main/multisig.h:10`), so "Trikey savings" is registered as `Trikey-savings`.

**Does Jade need the wallet registered?** To sign, no: `sign_psbt` signs every input whose derivations carry its
fingerprint. To recognise change, yes: only an input matching a registered wallet lets it check the change output
against that wallet and leave it off the screen; without one it "abandons" change detection and shows the change as a
payment (`sign_psbt.c:883-958`, outputs at 653-700). Trikey registers it when the wallet is set up, as for a Ledger.

**Unlocking: the PIN server.** A Jade's keys are encrypted under a key it rebuilds from the PIN and a secret held by a
"blind oracle" PIN server; over Bluetooth or USB the host relays (docs/index.rst 363-462). After `auth_user` and the PIN
on the Jade, the reply is `{http_request: {params: {urls, method: "POST", accept: "json", data: {data}}, "on-reply":
"pin"}}` (`pinclient.c:68-127`, `process_utils.c:494-602`). `urls` are the PIN server's `/get_pin` (or `/set_pin`) and
its onion address: Blockstream's by default (`PINSERVER_URL` "https://j8d.io" and an onion, `pinclient.c:20-22`), or
the owner's own, set on the Jade ("Blind Oracle" in its settings, or `update_pinserver`). The phone POSTs `data` as JSON
to the **first `https://` URL that is not an onion** and sends the JSON answer to `pin` (`handle_pin`,
`pinclient.c:299-354`); `pin` answers `true`, `false`, or another `http_request` (changing the PIN asks `/set_pin` too).
It never uses plain `http://`, has no Tor to reach an onion, and calls nothing but `pin` with the answer. When no URL is
usable or the request fails it sends `pin` with no data: the Jade then asks "Failed communicating with Oracle - retry?"
(`PIN_CAN_RETRY`, `pinclient.c:323-330, 545-552`), and the phone shows why on its sheet. A custom server's own
certificate (`root_certificates`) cannot be added to the phone's TLS: such a server works only with a certificate
phones already trust. No PIN-server address is written in Trikey: it uses what the Jade sends.

What the PIN server learns: the payload is encrypted and signed between the Jade and the server (ECDH with the server
key built into the Jade, `pinclient.c` `generate_ske`, `encrypt_payload`); the phone only carries it. The server
recovers the Jade's own PIN-server public key from the signature and keeps its state under its hash
(blind_pin_server `pindb.py:106-131, 141-161, 206-250`): so it can tell this Jade's unlocks apart, sees when it unlocks
and how many wrong PINs in a row (three wipe the entry, and the Jade's keys with it), and sees the phone's IP address.
It never sees the PIN (only an HMAC of it under a key of the Jade, `get_pin_secret`), the seed, any key, address or
wallet. The phone shows this in one sentence before the first unlock over Bluetooth (and stops if the owner declines).
In QR mode Trikey contacts no PIN server: a Jade used with a SeedQR (a temporary wallet, in memory only) asks none, and
one unlocked with "QR PIN Unlock" has the owner carry the same exchange by QR codes through another app
(`main/qrmode.c:1708-1800`, Blockstream's blkstrm.com/qrpin page), so the PIN server still sees that unlock, but not
from Trikey.

The Jade clears its keys when the Bluetooth link that unlocked them drops (`main/process/dashboard.c:2719-2731`), so
every connection asks for the PIN again: one for setting up and pairing, one per payment, one per text (notes, unlock).

**Trikey's texts.** `sign_message {path, message}` without `ae_host_commitment` is the legacy flow (docs/index.rst
1381-1428): `wallet_sign_message_hash` calls `wally_ec_sig_from_bytes(..., EC_FLAG_ECDSA | EC_FLAG_RECOVERABLE)` with
no host entropy (`wallet.c:1503-1517`); libwally signs with `secp256k1_ecdsa_sign_recoverable` and its default nonce
function with no extra data (libwally-core 3bf543cd `src/sign.c:364-422`, `src/internal.c:363-367`: RFC 6979), and Jade
replaces only libwally's secp256k1 context, not its nonce function (`main/utils/wally_ext.c:126-144`). The header is
`27 + 4 + recid` (`sign.c:414`), a compressed P2PKH header, as the guardian takes. So the same text gives the same
signature every time, which notes and hardware unlock need; the app still signs them twice and compares. With
`ae_host_commitment` the Jade would use anti-exfil (`sign_message.c:221-293`): random-looking, and a 64-byte signature;
Trikey never sends it. The Jade shows the first 188 characters, then "..." (`ui.h:11`, `sign_message.c:43-51` in
`confirm_sign_message`), the hash and the path, and signs the whole text; the phone says so when a text is longer. The
phone derives the key from the account xpub the Jade gave and checks the signature (`checkMessageAnswer`) before it
returns it; the wallet checks it once more.

**Payments and anti-exfil (decided: not on this path).** Jade's anti-exfil protocol (host commitment, signer
commitment, then the host's entropy and a check that the signature's nonce commits to it) stops a malicious Jade from
leaking key 1 through its nonces. It exists only on the older `sign_tx` flow (`use_ae_signatures`, then one `tx_input`
per input with `ae_host_commitment`, then `get_signature` with `ae_host_entropy`; docs/index.rst 1632-1744,
`main/process/sign_tx.c:451, 584-605`). `sign_psbt`, the path that takes Trikey's PSBTs and checks change against the
registered wallet, has none: it signs with `wally_psbt_sign_input_bip32(..., EC_FLAG_GRIND_R)` and reads no host
entropy (`sign_psbt.c:1100-1104`). Moving payments to `sign_tx` would mean a second signing path: the raw transaction,
each input's script and the full previous transaction (required unless there is a single witness input,
`sign_tx.c:674-678`), change described separately, and a verifier for the sign-to-contract commitment (secp256k1-zkp
`ecdsa_s2c`), which has no maintained JavaScript implementation. Trikey uses `sign_psbt` without anti-exfil: what
anti-exfil guards against is malicious firmware on the Jade (Jade's firmware is open source, reproducibly built and
verified by its secure boot), and key 1 alone moves nothing in the 2-of-3; a leaked key 1 together with a stolen phone
would, which is why this is written down as a limit (DESIGN.md, "Jade over Bluetooth") and a candidate for later. Every
signature the Jade returns is verified against the transaction before it is merged, and every input that names this
Jade must carry its signature (`assertDeviceSignedAll`).

**Platform.** `react-native-ble-plx` 3.4.0 (MIT), already linked for the Ledger transport, whose single shared
`BleManager` both use; Android: RxAndroidBle on the platform's Bluetooth API, no Google code, so the build without
Google keeps it (nothing new to scan in the APK); iOS: Core Bluetooth. Android 12 and later ask for "Nearby devices"
(`BLUETOOTH_SCAN`, declared `neverForLocation`, and `BLUETOOTH_CONNECT`, through the library's config plugin in
app.json); older Android asks for location, which it needs for any scan. iOS: `NSBluetoothAlwaysUsageDescription`
(now naming the Jade). The PIN-server request is a plain `fetch` (OkHttp on Android, URLSession on iOS); the app has no
host allowlist, and https needs nothing more on either platform. Jade firmware 0.1.47 or later (`sign_psbt` with a
network; CHANGELOG.md).

**Not done, or to check on a device:** the pairing dialogs on Android and iOS, and a Jade whose pairing was reset (the
phone must forget it too); the MTU Android gets and the time a large PSBT takes; whether the change of a Trikey payment
is left off the Jade's screen; a custom PIN server; Jade over USB (Android OTG) is not built; anti-exfil (above).

## 10. BitBox02 over USB-C and Bluetooth (built 2026-11-06; untested on devices)

A BitBox02 or BitBox02 Nova is the hardware kind `bitbox02` (`packages/wallet/src/bitbox02.ts`; the phone side is
`apps/mobile/src/hardware/bitbox02`). Like a Ledger it does everything for Trikey: key export, wallet registration,
payments and Trikey's texts. Read from github.com/BitBoxSwiss/bitbox02-firmware at b27f5f68 (2026-11-04; tags
`firmware/v9.27.1` and `v9.27.2`), its official clients bitbox-api-rs 0663f04 and bitbox-api-ts da3519d (npm
`@bitboxswiss/bitbox-api` 0.4.0), and BitBoxApp 2f3e4f4. Paths are under `src/rust/bitbox02-rust/src/` unless they
start with `src/` or `messages/`. **Not tried on a device or a phone.**

**Why Trikey speaks the protocol itself.** The Rust client's WASM package is gone (bitbox-api-rs CHANGELOG, "Remove the
`wasm` feature ... the TypeScript library is now maintained in BitBoxSwiss/bitbox-api-ts"), and Hermes has no
WebAssembly anyway. The pure TypeScript `@bitboxswiss/bitbox-api` connects only through WebHID or the BitBoxBridge (its
transport is internal and its `exports` refuse a deep import), its peers are noble 1.x and bitcoinjs-lib 7 (Trikey has
noble 2.x and bitcoinjs-lib 6), and it keeps its pairing in `localStorage`. BitBox publishes no Android or iOS bindings
(BitBoxApp runs its Go backend through gomobile). So the app implements the subset it needs in TypeScript (about 2,000
lines with comments, links included), on the libraries it already has (`@noble/curves` x25519 and secp256k1, `@noble/hashes`, `@noble/ciphers`
chacha20poly1305), and its tests replay the real implementations' vectors (below).

**The links.**

- *USB-C, Android* (both models): vendor `0x03eb`, product `0x2403` (bitbox-api-ts `constants.ts`; BitBoxApp
  `res/xml/device_filter.xml`); interface 0, its IN and OUT endpoints, 64-byte reports by `bulkTransfer`, as BitBoxApp's
  Android app does (`GoViewModel.java:44-91`). No React Native library does generic USB HID, so the app has its own
  Expo module, `modules/trikey-usb-hid` (Kotlin, `android.hardware.usb` only, no Google code, both Android builds):
  list, Android's permission dialog (an explicit, mutable `PendingIntent`), open, a reader thread, write, close, unplug.
  `android.hardware.usb.host` is declared not required. iOS gives apps no USB HID.
- *Bluetooth LE, the Nova* (Android and iOS; BitBoxApp `frontends/ios/.../Bluetooth.swift`): service
  `e1511a45-f3db-44c0-82b8-6c880790d1f1`; the phone writes reports to `799d485c-d354-4ed0-b577-f8ee79ec275a` with response,
  as many whole 64-byte reports per write as the MTU allows, at most five (`:562-580`); the Nova notifies reports on
  `419572a5-9f53-4eb1-8db7-61bcab928867` (`:288-299`). The first connection bonds: LE Secure Connections, the Nova shows
  a six-digit code and so does the phone's system dialog (`src/da14531/da14531_handler.c`, `CTRL_CMD_PAIRING_CODE`). Each
  report reaches the main chip as one USB frame (`_hww_handler`: payload must be `USB_REPORT_SIZE`). BitBoxApp's
  Android app has no Bluetooth, so a Nova over Bluetooth on Android is untried by anyone.

**The layers** (each in its own file, each tested on its own):

| Layer | What | Firmware / client |
|---|---|---|
| Framing (`framing.ts`) | U2F HID: an init report (channel `0xff00ff00`, command `0xC1`, big-endian length, 57 bytes) and continuations (sequence 0-127, 59 bytes), zero-padded to 64 | bitbox-api-rs `u2fframing.rs`; `FIRMWARE_CMD = 0x80 \| 0x40 \| 0x01` |
| HWW (`hww.ts`) | `i` (info: version, platform 0 BitBox02 / 2 Nova, edition, unlocked, initialized); `0x00` + request; ACK `0x00`, NOT_READY `0x01` (the owner is still deciding: poll with `0x01` every 200 ms), BUSY `0x02`, NACK `0x03`; `0x03` reset (9.28.0+) | `src/hww.c` (`hww_req_t`, `_api_info`, `_reset_session`) |
| Session (`session.ts`, `noise.ts`) | `u` unlock (the password on the device; `2` = no wallet yet), `h`, `H` × 2 (Noise_XX_25519_ChaChaPoly_SHA256, prologue = the protocol name, phone = initiator), `v` (the pairing code), `n` + ciphertext for every request | `hww.rs:71-128`, `hww/noise.rs:61-136`, `src/rust/bitbox-noise/src/noise_xx.rs:85-96` |
| Messages (`proto.ts`) | hand-written protocol buffers for ~25 messages | `messages/hww.proto`, `btc.proto`, `common.proto`, `antiklepto.proto` |
| Anti-klepto (`antiklepto.ts`) | host commitment, signer commitment, check | `src/rust/bitbox-secp256k1/src/lib.rs:146-255` |

**Pairing.** After the handshake the BitBox02 answers `0` (it knows this phone's Noise key, or the link is Bluetooth,
already paired with its six digits: `hww/noise.rs:91-98`) or `1` (it wants the code confirmed). The phone also asks
when it has not seen the BitBox02's Noise key before, as the official clients do. Then the phone shows the first 20
characters of the base32 handshake hash as `ABCDE FGHIJ` / `KLMNO PQRST` (`workflow/pairing.rs:9-22`) and sends `v`; the
BitBox02 shows "Pairing code" with the same characters and the owner confirms it there (or rejects: the firmware answers
`1` and resets the channel). Each side then remembers the other's key, so the next session skips it. The phone keeps its
own Noise key and the BitBox02s' keys in the app's key-value store (`trikey.bitbox02.pairing.v1`): it only spares the
owner the code for a BitBox02 this phone already paired with; the password and every approval are still asked on the
device. A Nova over Bluetooth shows the code too the first time (the phone has not seen it), after the six digits.

**Requests** (the session is encrypted; responses are checked as listed):

| Step | Request | What the BitBox02 does | What the phone checks |
|---|---|---|---|
| Fingerprint | `RootFingerprintRequest` (hww.proto 24) | 4 bytes | 4 bytes, compared with the wallet's record by the wallet |
| Account key | `BTCPubRequest {coin, keypath m/48'/c'/0'/2', xpub_type XPUB/TPUB, display false}` | `48'/c'/a'/2'` is a known multisig keypath: no "unusual keypath" warning (`bitcoin.rs:93-158`, `bitcoin/keypath.rs:44-69, 152-167`) | network family, depth, child number |
| Wallet | `BTCIsScriptConfigRegisteredRequest`, then if needed `BTCRegisterScriptConfigRequest {coin, multisig {threshold 2, three XPub, our_xpub_index, P2WSH}, keypath, name, AUTO_XPUB_TPUB}` | validates its key at our index (`multisig.rs:262-300`), shows the name, "2-of-3" and the keys, keeps the hash of the **sorted** xpubs (`multisig.rs:32-116`); the script is BIP 67 sorted (`multisig.rs:302-330`), so it is Trikey's `sortedmulti` | name 1-30 characters, no space at either end (`util/src/name.rs`) |
| Address | `BTCPubRequest {keypath account/chain/index, script_config multisig, display true}` | needs the wallet registered; shows the name and the address (index ≤ 10000) | equal to the phone's own |
| Payment | `BTCSignInitRequest {coin, [multisig at account], version, inputs, outputs, locktime, unit sat}`, then the BitBox02 asks: `INPUT` i (pass 1), `PREVTX_INIT/INPUT/OUTPUT` of its previous transaction (hashed and checked against the outpoint, its output against the value and script: `signtx.rs:346-431`), `OUTPUT` k (change as `ours` with keypath: derived and not shown, `signtx.rs:997-1017`), then `INPUT` i again (pass 2) | in pass 2 each input carries `host_nonce_commitment`; the BitBox02 answers `HOST_NONCE` with its nonce commitment, the phone sends the nonce (`antiklepto_signature`), the BitBox02 signs (`signtx.rs:1316-1360`) | anti-klepto on every signature; each signature verified against the transaction (`mergePartialSignatures`); every input signed (`assertDeviceSignedAll`) |
| Text | `BTCSignMessageRequest {coin, P2WPKH at m/48'/c'/0'/2'/0/0, msg, host_nonce_commitment?}` | 9.27.1+: shows "External service key", the key's P2WPKH address, the text; signs sha256d of the BIP 137 message; answers `r \|\| s \|\| recid` (`bitcoin/signmsg.rs:24-176`) | anti-klepto (except notes and unlock), then the BIP 137 signature `[31 + recid] \|\| r \|\| s` verified against the key derived from the account xpub (`checkMessageAnswer`) |

Every input of a payment must be the wallet's own (the BitBox02 signs only its own inputs and wants every input's
keypath) and carry its previous transaction (Trikey's PSBTs do). Coin: BTC on mainnet, TBTC on testnet and signet, RBTC on
regtest (`bitcoin.rs:79-90`: both editions have all three).

**Texts and determinism.** `signmsg.rs` takes a simple script config, P2WPKH or P2WPKH-P2SH, at a standard receive path
or any path under `45'` or `48'` up to depth 10 (`:31-41, 72-85`); `48'` from v9.27.1 (CHANGELOG: "allow signing messages
with keys in the m/48' application namespace"). It signs with `secp256k1_anti_exfil_sign`: `k = RFC6979(key, z, extra =
Hash_d(host nonce))`, `k' = k + Hash_p(R || host nonce)` (tags `s2c/ecdsa/data`, `s2c/ecdsa/point`). With a commitment the
host nonce is the phone's random one (anti-klepto, checked: the signature's `r` must be `x(R + Hash_p(R || nonce)·G)`);
without one it is 32 zero bytes (`:155-160`, "Preserve the historical zero-contribution S2C signature; this differs from
plain RFC6979"): **deterministic, but not RFC 6979**. The tests reproduce the firmware's own vectors with that formula
(`signmsg.rs` tests at `m/48'`, `m/45'`, `m/84'`, `TEST_MNEMONIC` in `keystore.rs:940`) and check that plain RFC 6979 gives
another signature. So:

- pairing, approvals, recovery access, cancel-recovery, resume and retire: **with** anti-klepto;
- notes and hardware unlock, which need the same signature every time (`SignMessageContext.purpose`): **without**; the app
  signs twice and compares, as for every device;
- a notes key or unlock slot made with a BitBox02 opens only with a BitBox02 holding that seed (Ledger, Trezor,
  Coldcard and Jade sign the same text with plain RFC 6979, so differently), and the reverse. After restoring the seed on
  another brand, turn notes on again and set up the hardware unlock again (`BITBOX02_SIGNATURE_NOTE`; the phone says so
  on the device prompt for those two).

Why the difference matters: the authorization key is `account/0/0`, a non-hardened child of the account key, so a nonce
that leaks it, together with the account xpub, gives the account's private key (key 1). Anti-klepto stops a BitBox02
with malicious firmware from choosing such nonces; without it (notes, unlock, and every other brand) the firmware is
trusted not to.

**The tests** (`apps/mobile/src/hardware/bitbox02/*.test.ts`, `apps/mobile/src/data/real-bitbox02.test.ts`): the framing
against bitbox-api-rs's vectors; the Noise transcript of the Rust `noise-protocol` crate for fixed keys (as copied in
bitbox-api-ts `test/noise.test.ts`), message by message, the handshake hash and the first ciphertext; the pairing code
against `workflow/pairing.rs` `test_confirm`; anti-klepto against the Rust vectors (bitbox-api-ts
`test/eth-antiklepto.test.ts`); the message signatures against `signmsg.rs`; protocol buffers against hand-encoded bytes.
Then a fake BitBox02 (`apps/mobile/src/hardware/test/fake-bitbox02.ts`) written from the firmware: NOT_READY while "the
owner" decides, the Noise responder, the pairing code, registration by sorted-xpub hash, addresses, the signing flow with
its own BIP 143 sighash and previous-transaction check, S2C signatures; and made to misbehave (a signature over another
sighash, a nonce it did not commit to, a missing signature, another key or text, another address, a key at another
path, a broken ciphertext). The app's wallet service pairs it with the in-process guardian, turns notes on and co-signs
a payment.

**Platform.** USB: the module above (compiled by the Android build; it runs only on a phone). Bluetooth:
`react-native-ble-plx` 3.4.0, already linked for Ledger and Jade, one shared `BleManager`; Android 12+ "Nearby devices",
iOS `NSBluetoothAlwaysUsageDescription` (now naming the BitBox02 Nova). Firmware **9.27.1** or later (2026-08-31);
older firmware is refused at connect with "update it with the BitBoxApp".

**Not done, or to check on a device:** Android's USB permission dialog and the HID endpoints on real phones (USB-C OTG,
the BitBox02 powered by the phone); a Nova over Bluetooth on Android (never done by BitBoxApp) and the MTU each phone
gets; how a 240-character text looks on the BitBox02's screen; the time a payment with many inputs takes (every previous
transaction goes through the device); BitBoxApp's "Bluetooth enabled" switch on the Nova; the session reset of firmware
9.28.0 (unreleased when this was written, coded from the firmware's `master`).
