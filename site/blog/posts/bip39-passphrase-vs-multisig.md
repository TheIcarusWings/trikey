---
title: "A Passphrase or Multisig? What Each Protects"
description: "BIP 39 passphrase vs multisig: how a passphrase works, what it protects and doesn't, how multisig differs, and when to use one, the other, or both together."
date: 2026-11-22
slug: bip39-passphrase-vs-multisig
keywords: [bip39 passphrase vs multisig, bip39 passphrase, 25th word, singlesig vs multisig, bitcoin self-custody]
draft: false
---
Once your seed phrase is written down and stored, the next worry is obvious: what if someone finds it? Two common answers come up. One is to add a **passphrase**, sometimes called the "25th word", so the seed alone isn't enough. The other is to move to **multisig**, so no single key is enough. Both protect against a found seed. They protect against different things after that, and they fail in different ways. This post explains how each works, puts them side by side, and helps you choose.

## How a BIP 39 passphrase works

A seed phrase is a list of words that encodes a random number. The wallet turns those words into the seed it derives all keys from. [BIP 39](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki#from-mnemonic-to-seed) defines that step so it takes a second, optional input: a passphrase of your choice. Words plus passphrase produce one seed; the same words with a different passphrase, or none, produce a completely unrelated seed and wallet.

Three consequences matter in practice:

- **The words alone open a different wallet.** Someone who finds your seed phrase, but not the passphrase, restores a wallet that has nothing to do with your funds. Often it's empty. Some people deliberately keep a small amount there as a decoy.
- **There's no "wrong passphrase" error.** Every passphrase is valid. Type it slightly differently, a capital letter or an extra space, and you get another valid, empty wallet, with no warning. The seed words have a checksum that catches typos; the passphrase doesn't.
- **Nobody can reset it.** The passphrase isn't stored on the device. Lose it and the wallet behind it is gone, as permanently as a lost seed. Trezor's own [passphrase guide](https://trezor.io/learn/a/passphrases-and-hidden-wallets) says so plainly: neither it nor anyone else can recover a forgotten passphrase (checked November 2026).

So a passphrase turns one secret into two. It is still **one key**: whoever holds both items holds the whole wallet.

## How multisig works

A multisig wallet doesn't make one key harder to use. It requires several keys. In a 2-of-3 wallet, there are three independent keys, each with its own seed phrase, usually on three different devices, and any two must sign each payment. [2-of-3 multisig explained](/blog/2-of-3-multisig-explained) covers the mechanics.

Its two defining properties:

- **One key is never enough to spend.** A found seed, a stolen device or a compromised phone gives the attacker one key of three.
- **One key can be lost without losing the wallet.** The other two still spend, and can move everything to a new wallet with a fresh third key.

The price is more to keep track of: three seeds, three places, and the wallet's **descriptor**, the record of all three public keys that the wallet needs to find its coins. [What a wallet descriptor is](/blog/wallet-descriptor-explained) explains why it matters.

## Side by side

| | Seed + passphrase | 2-of-3 multisig |
|---|---|---|
| Seed words found | Safe, unless the passphrase is found too | Safe: one key of three |
| Seed words *and* passphrase found | Everything can be taken | Still safe: one key of three |
| Passphrase forgotten (and the device reset or lost) | Funds lost | Not applicable |
| The device lost, and the seed or the passphrase lost too | Funds lost | Still spendable with the other two keys |
| A device stolen while unlocked | Everything can be taken | One key; can't spend alone |
| Things to back up | Seed + passphrase, stored apart | Three seeds + descriptor, in separate places |
| Signing a payment | One device | Two devices |
| Fees | Single-key size | Larger, two signatures per input |
| Restoring | Any BIP 39 wallet, with both items | Multisig-capable software, two seeds and the descriptor |

The pattern: a passphrase adds protection against **theft of the backup**, but it also adds a new way to **lose** everything. Multisig protects against theft *and* loss of any one piece, at the cost of complexity.

## What a passphrase is good at

- **A found or photographed seed.** The most common reason to add one. If your seed backup is ever seen, the attacker gets an empty or decoy wallet.
- **Cheap and simple to add.** Many hardware wallets support it, and payments still need only one device.
- **Keeping one backup location honest.** If you store the seed at a relative's house, they hold something that can't spend on its own.

What it doesn't do:

- **It doesn't help against loss.** It makes loss more likely, because there are now two things that must both survive, and one of them can't be checked by the wallet.
- **It doesn't protect a device that's in use.** Once you've entered the passphrase on a device, that device holds the full key until it's locked again.
- **It's only as strong as the passphrase.** A short or guessable one, such as a name or a date, can be tried by anyone who has the seed. Use a long, random passphrase, and store it as carefully as the seed.

## What multisig is good at

- **Theft of any single key**, including a device in use, a phone with malware, or a found backup.
- **Loss of any single key**, so a fire, a broken device or a forgotten PIN isn't final.
- **Sharing access over time.** A family member or a second location can hold a key that can't spend alone, which makes inheritance practical.

And what it costs:

- **More setup and more care.** Three keys must really be kept apart; two in one drawer undoes most of the benefit.
- **The descriptor.** Losing it together with one key can make recovery very hard.
- **Higher fees and more steps per payment.**

## Using both

They aren't exclusive. You can add a passphrase to one or more of the keys in a multisig. A key protected that way is safe even if its seed backup is found. But that key now also depends on its passphrase surviving. Two practical notes if you do:

- **The passphrase changes the key.** A hardware wallet with a passphrase produces a different public key, so the passphrase must be set *before* the multisig wallet is created, and entered every time that key signs.
- **Record which keys have one.** Your recovery notes, and your heirs, need to know which seed needs a passphrase and where that passphrase is kept, without writing it next to the seed.

For most people, adding passphrases to a well-separated multisig is more complexity than benefit. Multisig already makes one found seed harmless.

## Choosing

- **A modest amount, one device, and the main fear is someone finding the backup:** a single seed with a strong passphrase, each stored separately, is a reasonable step up.
- **A larger amount, or worry about both theft and loss:** multisig is the stronger answer, because it covers losing a key as well as having one stolen.
- **Heirs who will need access:** multisig, with a clear plan. A passphrase is one more secret they must find, and it's easy to lose across years.

[Single-sig or multisig: when is one key enough?](/blog/single-sig-vs-multisig) works through those questions in more detail.

## Where Trikey fits

[Trikey](/) is an open-source 2-of-3 multisig wallet in which you hold all three keys: a hardware wallet, your phone, and either the Trikey Guardian on your own home server or a printed Recovery Key. It takes the multisig route: no single key can spend, and any one can be lost ([design decisions](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#decisions-so-far)). It adds rules on top of the script:

- **A daily limit.** The phone and the guardian together can only spend up to a limit you set; anything larger needs the hardware wallet, unless you choose to turn the limit off ([rules the guardian enforces](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#rules-the-guardian-enforces)).
- **A waiting period for recovery.** Replacing a lost key through the guardian waits out a delay with daily alerts, so a thief holding one key can't quietly take over ([Delay & Notify](/blog/delay-and-notify-time-locked-recovery)).
- **Backups with their own protection.** The phone's key is backed up as an encrypted file opened with a recovery code ([mobile app](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#mobile-app-react-native)). The printed Recovery Kit is deliberately not encrypted, so there's no extra password to forget; its instructions say to keep it apart from the hardware wallet's seed words ([Recovery Key mode](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#recovery-key-mode-no-home-server)).

**Status:** Trikey is pre-alpha and has **not been audited**. Try it on test networks (signet, testnet4 or regtest); if you use mainnet anyway, use only an amount you can afford to lose. The [testers guide](https://github.com/TheIcarusWings/trikey/blob/main/docs/testers.md) explains how.

## FAQ

### Is a passphrase the same as my device's PIN?

No. A PIN unlocks the device and is limited to it; reset the device and the PIN is gone. A passphrase is part of the key itself: it's needed on any device you restore to.

### Can I add a passphrase to an existing wallet?

Not to the same wallet. Adding a passphrase creates a new, different wallet, so you'd send your coins to it like any other move.

### How long should a passphrase be?

Long and random enough that nobody holding your seed could guess it: several random words, or a long random string. Avoid names, dates and anything about you.

### Where should I store the passphrase?

Somewhere separate from the seed: a different place, so one find doesn't reveal both. Never online, and never in the same envelope.

### Does multisig make passphrases pointless?

Not pointless, but usually unnecessary. A found seed in a 2-of-3 is already one key of three. Add a passphrase only if you have a specific reason and a plan for keeping it.
