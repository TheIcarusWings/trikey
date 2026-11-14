---
title: "Storing a Seed Phrase: Paper, Metal, and Where Not To"
description: "How to store a seed phrase safely: paper or metal, where to keep it, the places never to put it, and how to test the backup before you rely on it."
date: 2026-11-14
slug: seed-phrase-storage
keywords: [how to store a seed phrase safely, seed phrase backup, metal seed backup, bitcoin self-custody, seed phrase storage]
draft: true
queue: 12
---
The 12 or 24 words your wallet showed you when you set it up are the wallet. The device, the app and the PIN are conveniences on top. Whoever holds the words can rebuild the keys on any compatible device and spend, and if the words are gone along with the device, nobody can bring the coins back. So the most important security decision most bitcoin holders make isn't which wallet to buy. It's where those words live. This post covers what to write them on, where to keep them, the places that cause most losses and thefts, and how to check the backup works.

## What you're actually storing

A **seed phrase** (also called a recovery phrase or mnemonic) is a list of words from a fixed list of 2,048, defined by [BIP 39](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki). The words encode a large random number, the seed, from which the wallet derives all its keys. The last word includes a checksum, so a wallet can usually tell when a word is wrong, though it can't tell you which.

Two things follow:

- **Order matters.** The same words in another order are a different seed (or an invalid one). Number every word.
- **Spelling is forgiving, in one specific way.** BIP 39's English list is built so that the [first four letters identify each word uniquely](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki#wordlist). That's why many metal backups have room for only four characters per word.

If your wallet also uses a **passphrase** (sometimes called a "25th word"), that is a separate secret: the words without it open a different, usually empty wallet. It needs its own backup, stored apart from the words.

## Paper: fine, if you respect its limits

Paper is cheap, quick, and readable by anyone in the future, which counts for more than people expect. Its weaknesses are just as plain: fire, water, fading, and being thrown away by someone who didn't know what it was.

To make paper last:

- Use a pencil or archival ink, on decent paper. Avoid thermal paper (receipt rolls) and inkjet printing.
- Write clearly, in capitals, with the word number before each word.
- Keep it in a sealed plastic sleeve or bag against damp.
- Label it so a family member won't throw it away, without saying exactly what it is: "Important. Do not discard. Ask [name]."

Paper is a reasonable choice for a modest amount, or as a second copy kept alongside a metal one.

## Metal: for fire, flood and time

Stamped, engraved or tile-based metal backups survive what paper won't. House fires commonly reach temperatures that destroy paper but not stainless steel or titanium. Designs vary a lot in how well they hold up, though. Jameson Lopp has tested many of them against heat, acid and crushing and publishes [the results by device](https://jlopp.github.io/metal-bitcoin-storage-reviews/) (checked November 2026). Check how a design did before you rely on it.

Things that matter more than the brand:

- **Material.** Stainless steel or titanium. Aluminium and brass melt at temperatures a house fire can reach.
- **Stamped or engraved beats loose tiles,** which can shift or fall out if the case is crushed or deformed.
- **Four letters per word** is enough for BIP 39, as above. Check them against the official list while you stamp.
- **Write it yourself, offline.** Don't buy a plate with a seed already on it, and don't use any service that "generates" or "engraves" your seed for you. The seed should exist only on your device and on the metal you made.

## Where to keep it

There's no single right place. There is a right way to think about it: a backup has to be **reachable by you** (and by your heirs) and **unreachable by everyone else**, and the two pull in opposite directions.

Good options, depending on your situation:

- **A hidden spot at home**, inside something fire-resistant, if the amount is modest and nobody else in the house is a concern.
- **A second location you control or trust:** a relative's home, or a safe-deposit box. Note that a bank box may be hard to reach quickly, and its rules on access after death vary.
- **Two copies in two places**, so one fire or one flood doesn't take both.

What to avoid is keeping the words **in the same place as the device**. A burglar who finds the hardware wallet and the words together has everything; one who finds only the device has a locked box.

### More copies, or fewer?

Each copy guards against loss and adds a place a thief can look. For a single-key wallet, two well-separated copies is the usual compromise. If you find yourself wanting five copies, or worrying about every one of them, that's the sign a single seed is carrying too much. [Single-sig or multisig](/blog/single-sig-vs-multisig) explains when spreading the risk across several keys beats adding more copies of one.

## Where never to put it

Most stolen seeds weren't taken from a safe. They were typed or photographed somewhere online. Never put your seed phrase:

- **In a photo,** including on your phone. Photos sync to cloud accounts automatically.
- **In a cloud note, email, password manager, chat or document,** however private it feels. One compromised account then means stolen coins.
- **Into any website or app other than the wallet you're restoring,** on a device you trust. Nobody legitimate will ever ask for it: not support staff, not an exchange, not a "wallet validation" page, not a recovery service.
- **On a printer or copier** you don't control. Many keep copies of what they print.
- **In a will or other document that will be read by others,** such as one filed with a court. Your heirs need to know *where* the backup is and how to use it, not the words themselves.

If you ever think your words have been seen, assume the wallet is compromised. Set up a new wallet with a new seed, and move the coins to it.

## Test the backup before you need it

A backup you've never restored from is a guess. Two ways to test it without risk:

1. **Restore to a second device**, or to the same device after a reset, using only the written words. Check the restored wallet shows the same first receive address as the original. Many hardware wallets also offer a "check backup" feature that compares the words you enter without wiping anything.
2. **Do it again a year later.** Ink fades, tiles shift, and you'll be glad to know where the words still are and that they still work.

Test with a small amount first if you're unsure, and do it on a device, never in a website.

## Planning for the people after you

A seed phrase your family can't find, or doesn't know how to use, is as lost as one burnt in a fire. Without writing the words anywhere new, leave clear instructions: that the backup exists, where it is, what kind of wallet it restores, and who to ask for help. For a multisig wallet, the instructions also need the wallet's descriptor, which [What a wallet descriptor is](/blog/wallet-descriptor-explained) explains. [Bitcoin inheritance without a company](/blog/bitcoin-inheritance-without-a-company) walks through a complete plan.

## How Trikey handles backups

[Trikey](/) is an open-source 2-of-3 wallet in which you hold all three keys: a hardware wallet, your phone, and either the Trikey Guardian on your own home server or a printed Recovery Key. Because any two keys can spend, a single lost or seen backup isn't the end of the wallet. The backups still matter:

- **Key 1, the hardware wallet,** has its own seed words, stored as in this post. The design advises keeping them outside the home, so a burglar who finds the phone and the home server doesn't also find the hardware wallet's words ([threat model](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#threat-model)).
- **Key 2, the phone,** is backed up as an encrypted file holding the key and the wallet's descriptor, opened with a recovery code. You choose where the file goes ([mobile app](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#mobile-app-react-native)).
- **In Recovery Key mode** (no home server), key 3 is a printed Recovery Kit: a QR code and words, plus the descriptor. The kit is deliberately not encrypted, so there's no extra password to lose. Its instructions start with "keep this sheet apart from your hardware wallet's seed words", because anyone with both could spend ([Recovery Key mode](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#recovery-key-mode-no-home-server)).

**Status:** Trikey is pre-alpha and has **not been audited**. Try it on test networks (signet, testnet4 or regtest); if you use mainnet anyway, use only an amount you can afford to lose. The [testers guide](https://github.com/TheIcarusWings/trikey/blob/main/docs/testers.md) explains how.

## FAQ

### Is it safe to store my seed phrase in a password manager?

It's convenient, but it puts the seed online: anyone who gets into that account, or the device it's unlocked on, can take everything. Keep it offline, on paper or metal.

### Should I split my seed phrase into parts?

Not by cutting the word list in half: each half gives an attacker a large head start, and losing one half loses the wallet. If you want to spread risk across places, use a scheme designed for it, such as multisig, rather than an improvised split.

### Can I encrypt my seed phrase?

You can, but the encryption key becomes one more thing to lose, and forgetting it locks you out as surely as losing the words. For most people, good physical storage beats encryption.

### What if a word on my backup is unreadable?

With the other words in order, one missing word can usually be recovered: the checksum rules out most of the 2,048 candidates, and checking the rest against an address you know the wallet used finds the right one. Do it with offline software on a device you trust, never a website, and move the coins to a new wallet afterwards if the backup was damaged.

### How often should I check my backup?

Once when you make it, by restoring, and then about once a year, or whenever you move house or change where it's kept.
