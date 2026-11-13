---
title: "Collaborative Custody Compared: Who Holds the Third Key?"
description: "Bitkey, Casa, Unchained, Nunchuk and DIY multisig compared fairly: who holds which key, what each key can do, and what happens if a company goes away."
date: 2026-11-13
slug: collaborative-custody-compared
keywords: [collaborative custody, Bitkey alternative, Casa vs Unchained, Nunchuk assisted wallet, multisig custody comparison]
draft: false
---
"Collaborative custody" means a [2-of-3 multisig](/blog/2-of-3-multisig-explained) wallet in which you hold two keys and a company holds the third. It sits between handing your bitcoin to an exchange and carrying every key alone. Several good products work this way, and they differ in what the company's key is allowed to do. This article compares the main models by the question that matters most: **who holds the third key, and what can that key do?** It is written to be fair: each model has real strengths, and the right choice depends on what you want help with.

Product details change. Everything below is taken from each provider's public documentation as of November 2026; check their current pages before deciding.

## The four models

### 1. An exchange or custodian holds everything

The simplest option: the company holds the keys, and you hold an account. Recovery is a password reset. The trade-off is that the bitcoin is the company's to move, freeze or lose, and your access depends on its solvency and its policies. Not self-custody, but worth naming as the baseline.

### 2. You hold one key (single-sig)

One hardware wallet and one seed phrase. Fully yours, simple and cheap, and every company could disappear without effect. The risk is that the seed is a single point of failure for both loss and theft (see [what happens if you lose a key](/blog/lost-hardware-wallet-phone-or-seed-phrase)).

### 3. You hold two keys, a company holds one

The collaborative model. No party can spend alone: not you with one key, not the company with its key. What the company's key does varies:

- **A recovery key.** The company signs only to help you after you lose a key. Day to day, you spend with your own two keys.
- **A co-signing key with rules.** The company's server co-signs everyday payments from your phone, within limits, so you do not need your hardware wallet for small amounts. It also runs a delayed recovery.

### 4. You hold all three keys

Do-it-yourself multisig with a coordinator such as Sparrow, Nunchuk, Specter or Electrum, and three hardware wallets or seeds kept in different places. No company in the loop at all. The trade-off is that you are your own support desk, and everyday spending means fetching two devices.

## The providers, briefly

### Bitkey (Block)

A 2-of-3 with three fixed roles: an app key on your phone, Bitkey's own hardware device, and a server key held by Block. Block's server co-signs with your phone up to a daily limit you set, so small payments do not need the hardware. Over the limit, the hardware device signs. If you lose a key, **Delay + Notify** recovers it after a seven-day waiting period with alerts, and you can cancel a recovery you did not start. An **Emergency Exit Kit** lets you move your funds with your phone key and hardware key without Block's servers. The roles are fixed: you cannot swap in another hardware wallet or a different cosigner.

Good fit for: people who want everyday phone payments with a hardware backstop and a company that runs the server.

### Casa

A 3-key vault (2-of-3) in which you hold a mobile key and a hardware key, and Casa holds the **Casa Recovery Key**. Casa's documentation says it holds only that key and cannot move funds with it alone; it exists to help you recover when you lose access to one of your keys. Casa also documents recovering without Casa (for example in Sparrow) and offers larger vaults and inheritance services.

Good fit for: people who want a guided setup, a recovery partner and support, with day-to-day spending on their own keys.

### Unchained

A 2-of-3 vault in which you hold two keys (usually two hardware wallets) and Unchained holds one. Unchained's key acts as a backup and recovery key. Its help pages describe **external recovery**: spending from the vault with your two hardware wallets, the wallet configuration file and another multisig wallet (Caravan or Sparrow), without the Unchained platform. It also offers larger quorums, inheritance and financial services built around the vault.

Good fit for: larger holdings, people who want a long-term custody partner and an established company behind it.

### Nunchuk

A wallet app that does both: fully self-managed multisig (every key yours) and **assisted wallets**, in which Nunchuk holds a Platform Key. Its documentation describes using that key for day-to-day co-signing and spending limits, on paid plans. It also offers inheritance planning.

Good fit for: people who want one app that can start self-managed and add a company key later.

## Side by side

| | Exchange | Single-sig | Company holds 1 of 3 | You hold 3 of 3 |
|---|---|---|---|---|
| Who can spend alone | The company | You | Nobody | Nobody |
| A single lost key | Account reset | Funds at risk without backup | Recover with the other two | Recover with the other two |
| Phone-only everyday payments | Yes | Depends on the wallet | With a co-signing service (Bitkey, Nunchuk assisted) | Not usually |
| Help when things go wrong | Support desk | None | Support desk | None, or a friend |
| If the company disappears | Depends on the company | Nothing changes | You still hold two keys; keep the wallet configuration | Nothing changes |
| What the company sees | Everything | Nothing | Usually your wallet's addresses and transactions | Nothing |

## What a company key gives you, honestly

- **Someone to call.** Setup help, a recovery process and, for families, an inheritance process.
- **An always-on co-signer** for phone payments, without running any hardware yourself.
- **Accountability.** A company with a reputation and a legal identity.

## What it costs

- **Fees.** Most collaborative plans are subscriptions.
- **Dependence for what the key does.** If the company stops, its features stop; your two keys still recover, as long as you kept the wallet configuration.
- **Privacy.** A co-signer that checks your payments must see them, and usually knows your whole wallet.
- **Fixed choices.** Some products fix the hardware or the roles; others let you choose.

None of these is a flaw in a particular company. They are the shape of the model.

## How Trikey approaches it

[Trikey](/) keeps the everyday shape of the co-signing model, phone payments within a daily limit and a waiting-period recovery with alerts, and gives the third key back to you. The co-signer, the Trikey Guardian, is an app on your own home server (Umbrel, Start9, or a computer or NAS running Docker). The design document says it plainly: no company runs a server, a guardian or a cosigner for anyone.

- **Key 1:** a hardware wallet of your choice (Ledger, Trezor, Coldcard, Jade, BitBox02, Keystone, Passport, Krux or Specter DIY), not one brand.
- **Key 2:** your phone. With the guardian, it pays within your daily limit.
- **Key 3:** your guardian, which co-signs only within the rules your hardware wallet approved, and runs a 7, 14 or 30-day Delay & Notify recovery.
- **Recover anywhere:** a plain `wsh(sortedmulti(2,…))` descriptor, so any multisig wallet can move the coins with two of your keys.

What you give up compared with a company: there is no support desk, you keep a home server running, and if it goes offline, phone-only payments wait (your phone and hardware wallet still move any amount). A remote compromise of your home server gives up one key of three, the same exposure as a company's co-signing server being breached ([threat model](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#threat-model)). And unlike the products above, Trikey is not a finished product.

**Status:** Trikey is pre-alpha and has **not been audited**. Use it on test networks (signet, testnet4 or regtest); if you try mainnet, use only an amount you can afford to lose. The [testers guide](https://github.com/TheIcarusWings/trikey/blob/main/docs/testers.md) explains how to try it. Trikey is an independent open-source project and is not affiliated with any of the companies named here.

## FAQ

### What is the best Bitkey alternative?

It depends on what you like about Bitkey. For a company-run co-signer with phone payments, look at assisted multisig such as Nunchuk's. For a recovery partner with your own two keys, Casa or Unchained. For no company at all, do-it-yourself multisig, or a self-hosted co-signer such as Trikey once it is ready.

### Can the company in collaborative custody take my bitcoin?

Not alone: it holds one key of three, and the wallet needs two. It could refuse to sign, which is why you should always be able to spend with your own two keys.

### What happens to my funds if the company shuts down?

You still hold two keys. With the wallet's configuration (descriptor) and any multisig wallet, you can move the funds. Save that file today and test it once.

### Is collaborative custody still self-custody?

Most people count it as such, because no single party, the company included, can move the funds. You hold the majority of the keys.
