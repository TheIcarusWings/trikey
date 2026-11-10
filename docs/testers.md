# Testing Trikey: a quickstart

Thank you for helping test Trikey. This page gets you from nothing to a working wallet on a **test network**, and tells
you how to report what you find. The full step-by-step is [alpha-test-plan.md](alpha-test-plan.md); this page points into it.

Trikey is **pre-alpha and not audited**. Test on **signet** or **testnet4**, with coins that have no value. If you test
on mainnet anyway, use only an amount you can afford to lose.

## What you need

- **A box for the guardian (key 3):** an Umbrel, or any computer or NAS that runs Docker. It needs a Bitcoin node and an
  Electrum server (Electrs or Fulcrum) **on the same test network** as your wallet. Signet is the easiest: small and
  quick to sync ([test plan, "Signet or testnet4 on the Umbrel"](alpha-test-plan.md#signet-or-testnet4-on-the-umbrel-path-b-only)).
- **A phone (key 2):** Android 7 or newer is easiest. An iPhone works too, but for now you build the app yourself on a
  Mac with a free Apple ID, and rebuild it every 7 days ([apps/mobile/README.md](../apps/mobile/README.md)).
- **A hardware wallet (key 1):** Ledger, Trezor, Coldcard, Jade, BitBox02, Keystone, Passport, Krux or Specter DIY.
  (A SeedSigner can't approve the guardian's rule changes, so it only works with Recovery Key mode.) Every device
  except the Ledger is **still untested on real hardware**, so a report on any of them is very welcome. Have its test-network app or mode ready (a Ledger needs "Bitcoin Test").
- **A nostr app** (Damus, Amethyst, Primal) with an account you can read: it becomes your alert contact.
- **Paper and a pen** for the recovery code.

## Set it up

The six [setup tutorials](https://trikey.app/#watch) show each step in a few minutes.

1. **Install the guardian.**
   - **Umbrel:** add the community app store `https://github.com/TheIcarusWings/trikey-umbrel-store` (App Store, ⋯,
     Community App Stores), then install **Trikey Guardian**.
   - **Docker:** download `trikey-guardian-compose.yml` and `trikey-guardian.env.example` from the
     [latest release](https://github.com/TheIcarusWings/trikey/releases) and follow
     [packaging/compose/README.md](../packaging/compose/README.md).

   Open it and choose a passphrase.
2. **Install the app.** Android: from [Zapstore](zapstore.md), with [Obtainium in one tap](https://trikey.app/obtainium),
   or the APK from the latest release. Trikey FOSS is the build without Google code.
3. **Create your wallet** on the same test network: connect the hardware wallet, scan the guardian's pairing code, pick
   a daily limit and a waiting period, add your alert contact, and write down the recovery code.
4. **Get test coins** from a signet or testnet4 faucet, and receive them.
5. **Try it:** a payment inside the limit (phone only), one over it (signed on the hardware wallet), lock and unlock the
   guardian, raise the limit. The [test plan's steps 7 to 10](alpha-test-plan.md#7-a-payment-inside-the-limit) say what
   you should see at each one.
6. **If you have time:** delete the app and restore it from your backup (step 11), and start a recovery as if you had
   lost the phone (step 12). The shortest waiting period is 7 days, so let it run in the background.

## Tell us what you found

- **Something broke or confused you:** open a [bug report](https://github.com/TheIcarusWings/trikey/issues/new?template=bug.yml).
- **You used a hardware wallet:** fill in a [hardware wallet test report](https://github.com/TheIcarusWings/trikey/issues/new?template=hardware-test.yml),
  **even if everything worked**. That's how the [beta checklist](beta-checklist.md) gets its devices ticked.
- **It could put funds at risk:** report it [privately](https://github.com/TheIcarusWings/trikey/security/advisories/new), not in a public issue.

**Never share** seed words, PINs, the guardian's passphrase, the recovery code, an nsec or a backup file, with anyone,
including us. Nobody working on Trikey will ever ask for them.

## What happens next

Trikey goes to **0.2.0-beta** when the [beta checklist](beta-checklist.md) is done: every hardware wallet tried at least
once, and a week or two of testers without a serious bug. Your reports are what gets it there.
