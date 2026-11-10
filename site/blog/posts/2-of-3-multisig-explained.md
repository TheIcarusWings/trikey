---
title: "2-of-3 Multisig Explained: How It Works and What It Costs"
description: "How 2-of-3 bitcoin multisig works, what each pair of keys is for, how it compares with single-sig, and the real costs: fees, backups and complexity."
date: 2026-11-10
slug: 2-of-3-multisig-explained
keywords: [2-of-3 multisig, bitcoin multisig explained, singlesig vs multisig, multisig wallet descriptor, is multisig worth it]
draft: false
---
A 2-of-3 multisig wallet holds bitcoin behind three keys and lets any two of them spend. Lose one key and the other two still move your money. Have one key stolen and the thief still cannot spend. That is the whole idea, and it is enforced by Bitcoin itself, not by a company or an app. This article explains how it works under the hood, what each pair of keys is good for, how it compares with an ordinary single-key wallet, and what it costs you in fees, backups and care.

## What "2-of-3" means

A normal bitcoin wallet has one private key (in practice, one seed phrase that produces many keys). Whoever holds that seed can spend. This is called **single-sig**: one signature is enough.

A **multisig** wallet replaces that single key with a rule: *M signatures out of N possible keys*. In a 2-of-3 wallet there are three keys, usually kept on three different devices or in three different places, and any two of them must sign before coins can move. The three keys are equal: no key is "the main one" as far as Bitcoin is concerned.

The rule is part of the coins themselves. When you receive bitcoin to a multisig address, the address commits to a script that says "two valid signatures from these three public keys". Every node on the network checks that rule before accepting a spend. No server can waive it, and no single key can break it.

## How a 2-of-3 wallet works under the hood

You do not need these details to use multisig, but they explain the backup advice later on.

### Three extended public keys

Each of the three devices holds its own seed and exports an **extended public key** (an xpub) for a multisig account. A common standard for the account path is [BIP 48](https://github.com/bitcoin/bips/blob/master/bip-0048.mediawiki), for example `m/48'/0'/0'/2'` for a native segwit multisig account on mainnet. The xpub lets the wallet derive public keys but not spend.

### One address per index, from all three keys

For each new receive address, the wallet takes the next public key from each of the three xpubs and builds a script that requires two signatures from those three keys. Today that script is usually wrapped as a **P2WSH** (native segwit) output, so the address starts with `bc1q` and is longer than a single-sig one.

### The descriptor ties it together

The full recipe for the wallet, "2 of these three xpubs, at these paths, in a P2WSH script", is written as an **output descriptor**. For a 2-of-3 it looks like this (shortened):

```
wsh(sortedmulti(2,[f00d1234/48h/0h/0h/2h]xpub6E.../0/*,[ab12cd34/48h/0h/0h/2h]xpub6F.../0/*,[99887766/48h/0h/0h/2h]xpub6D.../0/*))
```

`wsh` is the P2WSH wrapper, `sortedmulti(2, …)` means "two of these keys, sorted into a fixed order", and each bracket names the device fingerprint and path a key came from. Descriptors are standardised in [BIP 380](https://github.com/bitcoin/bips/blob/master/bip-0380.mediawiki) and [BIP 383](https://github.com/bitcoin/bips/blob/master/bip-0383.mediawiki), and Bitcoin Core documents them in its [descriptors guide](https://github.com/bitcoin/bitcoin/blob/master/doc/descriptors.md). The descriptor holds no secret, but it is essential: without the other keys' xpubs, your seed alone cannot find your coins.

### Signing passes a PSBT around

To spend, one device creates a **Partially Signed Bitcoin Transaction** ([BIP 174](https://github.com/bitcoin/bips/blob/master/bip-0174.mediawiki)), signs it, and hands it to a second device, which adds its signature. Once two signatures are in, the transaction is complete and can be broadcast. The PSBT can travel over USB, Bluetooth, a QR code, an SD card or a network message; the signatures are what matter.

## What each pair of keys is for

Because any two keys spend, a 2-of-3 setup gives you three different pairs. Good designs give each pair a job:

- **Everyday pair.** Two keys that are easy to reach together, for routine spending.
- **Big-decision pair.** A pair that includes a key kept offline, for large payments or for changing how the wallet behaves.
- **Recovery pair.** The two keys you still have when one is lost or stolen. They move everything to a new wallet with a fresh third key.

The important property: **no single key can spend, and no single loss locks you out.** Both of those are true at the same time, which a single-key wallet cannot offer.

## Single-sig vs 2-of-3: what you are trading

People ask whether multisig is "worth it". The honest answer is that it changes which risks you carry rather than removing risk.

| | Single-sig (one seed) | 2-of-3 multisig |
|---|---|---|
| One key lost | Funds lost unless the seed backup exists | Still spendable with the other two |
| One key stolen or seed photographed | Thief can spend everything | Thief cannot spend alone |
| Backups to keep | One seed (plus passphrase, if used) | Each key's backup plus the descriptor |
| Transaction size and fees | Smallest | Larger inputs: two signatures and the script |
| On-chain privacy | Looks like most wallets | A spend reveals a 2-of-3 script |
| Setup and recovery effort | Low | Higher: registration, address checks, more steps |

A single seed is a **single point of failure** in both directions: it can be lost, and it can be found. Adding a [BIP 39](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki) passphrase spreads that risk across two items, but whoever learns both still holds a complete key, and losing the passphrase loses the funds.

Multisig removes the single point of failure but adds moving parts. If you store two of the three keys in the same drawer, you are back to one point of failure, with more complexity. If you lose the descriptor and one key, recovery can become very hard.

For a small amount you spend often, a well-backed-up single-sig wallet is a reasonable choice. As the amount grows, or if theft or a single mistake worries you more than complexity does, 2-of-3 starts to pay for itself.

## What multisig does not fix

- **Two keys in one place.** A burglar who finds two keys in the same house holds a spending pair.
- **Coercion.** If someone can force you to use two keys, multisig alone does not stop them. Waiting periods and limits help more here (see [Delay & Notify: why recovery should wait](/blog/delay-and-notify-time-locked-recovery)).
- **Signing the wrong thing.** If malware swaps the destination address and you approve it on both devices without reading the screen, the payment goes out. Devices that show the address you are paying, and the wallet's own change, are what protect you (see [choosing a hardware wallet for multisig](/blog/hardware-wallet-for-multisig)).
- **Lost metadata.** Without the descriptor (or all the xpubs), the keys you hold may not be enough to find the coins.

## 2-of-3 or 3-of-5?

Larger setups such as 3-of-5 tolerate two lost keys and make theft harder, but every payment needs three devices and every recovery more coordination. For an individual, 2-of-3 is the common middle ground: one loss is survivable, one theft is harmless, and only two devices are needed to sign.

## How Trikey approaches it

[Trikey](https://trikey.app) is an open-source 2-of-3 wallet in which you hold all three keys, and each pair has one job:

- **Key 1, any hardware wallet** (Ledger, Trezor, Coldcard, Jade, BitBox02 and others), kept in a drawer.
- **Key 2, your phone**, behind its biometrics.
- **Key 3, the Trikey Guardian**, an app on your own home server (Umbrel, Start9 or plain Docker).

Phone plus guardian is the everyday pair: the guardian co-signs phone payments only within a daily limit you set. Phone plus hardware wallet is the big-decision pair: larger payments and any loosening of the rules. Hardware wallet plus guardian is the recovery pair for a lost phone, behind a waiting period with daily alerts.

Under the hood every Trikey wallet is a plain `wsh(sortedmulti(2,…))` descriptor on BIP 48 paths, the same kind of script shown above. That choice is deliberate: it is the multisig script every major hardware wallet can co-sign, and it means any multisig-capable wallet can recover the coins with two of your keys, without Trikey. The reasons, and what was left out (taproot multisig, miniscript, MuSig2), are in the [design document's decisions](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#decisions-so-far).

**Status:** Trikey is pre-alpha and has **not been audited**. Use it on test networks (signet, testnet4 or regtest); if you try mainnet anyway, use only an amount you can afford to lose. The [testers guide](https://github.com/TheIcarusWings/trikey/blob/main/docs/testers.md) explains how to try it.

## FAQ

### Is 2-of-3 multisig safer than a single hardware wallet?

It removes the single point of failure: one lost or stolen key no longer decides the outcome. It is only safer if you keep the three keys apart and back up the descriptor. Done carelessly, it adds ways to make mistakes.

### Can I recover a multisig wallet with just the seed words?

Usually not with two seeds alone. You also need the third key's xpub, which is in the descriptor. Keep a copy of the descriptor with each key backup; it reveals your balance and history to whoever reads it, but it cannot spend. More in [bitcoin inheritance without a company](/blog/bitcoin-inheritance-without-a-company).

### Does multisig cost more in fees?

Yes. Each multisig input carries two signatures and the script, so it is larger than a single-sig input and costs more to spend. Fewer, larger coins keep the difference small.

### Can I mix hardware wallet brands in one multisig?

Yes, and many people do, so that one vendor's bug does not affect every key. Each device must support the script type and, ideally, let you register the wallet and check addresses on its screen.

### How is multisig different from splitting a seed (Shamir or SLIP-39)?

A split seed is still one key: the shares are combined into the full seed when you need it, at which point it exists in one place. Multisig keeps the keys separate forever; each device signs on its own and no device ever holds the others' keys.
