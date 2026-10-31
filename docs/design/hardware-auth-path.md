# The hardware authorization key path on Trezor and Ledger

Status: proposal, not built. Written 2026-10-31 against `main` at 0.1.5. Device behaviour was read from
firmware and SDK source the same day, not tested on hardware.

A code audit flagged an unconfirmed risk: that Trezor refuses `signMessage` at our authorization key path
with "Forbidden key path" under the default Strict safety checks. **It does not.** No Trezor refuses the
path. Trezor firmware before core 2.13.0, and every Model One firmware, shows a path warning first; the user
must accept it before the device signs. Ledger signs with no warning. The recommendation is to keep the path,
because moving it would break a security check on the guardian, and to make small phone-side changes.

## 1. What we sign with

`authKeyPath()` (`packages/wallet/src/keys.ts`) is `<BIP 48 account>/0/0`, so `m/48'/0'/0'/2'/0/0` on
mainnet and `m/48'/1'/0'/2'/0/0` on test networks. That key is the hardware key in the wallet's first
receive address. The phone derives its pubkey from the BIP 48 account xpub it already has, with no extra
device call (`readHardware`, `packages/wallet/src/wallet.ts`). It signs pairing proofs, `hardware.confirm`
proofs, approvals and recovery access with `hw.signMessage(rec.auth.path, text)` (`signWithAuthKey`, same
file). The guardian requires this key to sit below the hardware account by non-hardened steps and to
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
