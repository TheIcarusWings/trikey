---
title: "What a Wallet Descriptor Is, and Why Your Heirs Need It"
description: "A multisig wallet descriptor is the map that finds your coins. What it contains, why seed words alone aren't enough, and how to back it up for your heirs."
date: 2026-11-12
slug: wallet-descriptor-explained
keywords: [multisig wallet descriptor backup, output descriptor, bitcoin inheritance, 2-of-3 multisig, wallet recovery]
draft: true
queue: 9
---
If you hold bitcoin in a multisig wallet, you've probably been told to "back up the descriptor" as well as your seed words. It sounds like a technical extra. It isn't. For a multisig wallet, the descriptor is what turns a pile of keys back into a wallet with coins in it. Lose it together with one key and recovery can go from an afternoon's work to very hard indeed. This post explains what a descriptor is, reads one line by line, and shows how to store it so that you, or the people who inherit from you, can use it.

## The short answer

A **wallet descriptor** (in full, an *output descriptor*) is one line of text that describes exactly which addresses belong to a wallet: which public keys are involved, how they are combined, and which script type wraps them. It holds **no private keys**. It cannot spend anything. But without it, wallet software may not know where to look for your coins.

For a single-key wallet that hardly matters, because the standard paths are few and wallets try them for you. For multisig, it matters a great deal.

## Why seed words are not enough for multisig

A seed phrase produces one key. A 2-of-3 multisig wallet's addresses are built from **three** keys at once: for each address, the wallet takes a public key from each of the three, sorts or orders them, and builds a script that needs two signatures. Change one ingredient and you get a completely different address.

So to find your coins, the software needs to know all three public keys, even if you only have two seeds to sign with. It also needs to know:

- the script type (for example native segwit P2WSH, or the older nested or legacy forms);
- how many signatures are required (2 of 3, 3 of 5…);
- whether the keys are sorted or kept in a fixed order;
- the derivation path each key came from.

Imagine you hold two seed phrases and the third device is gone. Your two seeds can sign, but they can't tell you the third key's public key. Unless it was written down somewhere, the wallet can't rebuild a single address, and the coins are invisible. They are still there on the blockchain, but you can't find them or spend them.

The descriptor holds all of that in one place. That's why it is sometimes called the wallet's **map**: the seeds are the keys to the doors, and the descriptor tells you which doors are yours.

## Reading a descriptor

Descriptors are standardised in [BIP 380](https://github.com/bitcoin/bips/blob/master/bip-0380.mediawiki) and the BIPs that follow it, and Bitcoin Core documents them in its [descriptors guide](https://github.com/bitcoin/bitcoin/blob/master/doc/descriptors.md). Here is a 2-of-3 one, shortened (so its checksum is only an illustration):

```
wsh(sortedmulti(2,[f00d1234/48h/0h/0h/2h]xpub6E.../<0;1>/*,[ab12cd34/48h/0h/0h/2h]xpub6F.../<0;1>/*,[99887766/48h/0h/0h/2h]xpub6D.../<0;1>/*))#q7k2s9xm
```

Piece by piece:

- **`wsh( … )`**: "witness script hash", the native segwit wrapper for scripts ([BIP 382](https://github.com/bitcoin/bips/blob/master/bip-0382.mediawiki)). Addresses start with `bc1q` on mainnet.
- **`sortedmulti(2, …)`**: a multisig script needing 2 signatures from the keys listed, which are sorted into a fixed order for each address ([BIP 383](https://github.com/bitcoin/bips/blob/master/bip-0383.mediawiki)). Sorting means the order you list the keys in doesn't change the addresses.
- **`[f00d1234/48h/0h/0h/2h]`**: the key's origin. `f00d1234` is the **master fingerprint** of the device or seed it came from, a short ID that helps match keys to devices. `48h/0h/0h/2h` is the derivation path, here the [BIP 48](https://github.com/bitcoin/bips/blob/master/bip-0048.mediawiki) path for a native segwit multisig account on mainnet. The `h` means "hardened", the same as `'`.
- **`xpub6E...`**: the extended public key for that account. It can produce public keys and addresses, never signatures.
- **`/<0;1>/*`**: which addresses to derive. `0` is the receive chain, `1` the change chain, and `*` means "every index: 0, 1, 2…". The `<0;1>` form puts both chains in one line ([BIP 389](https://github.com/bitcoin/bips/blob/master/bip-0389.mediawiki)); older software writes two descriptors instead, one ending `/0/*` and one `/1/*`.
- **`#q7k2s9xm`**: an eight-character **checksum** (BIP 380). If a character is mistyped when the descriptor is copied by hand, the checksum no longer matches and software refuses it, rather than silently building the wrong wallet.

Everything in that line is public information. That's what makes it safe to copy and keep in several places, with one important caveat.

## The privacy caveat

A descriptor can't spend, but it can **see**. Anyone who reads it can derive every address of the wallet, then look them up on a block explorer to see your balance and every payment in and out. That's a reason to keep it private, not to keep it scarce. The descriptor's risk is privacy. Losing it costs you access. Weigh those two the other way round from seed words: spread descriptor copies widely enough that one always survives, but only where people you trust can see them.

## How to back it up

A practical plan for a 2-of-3:

1. **Keep a copy with each key's backup.** If your seed words are in three places, put a copy of the descriptor in all three. Then any two locations you can reach hold two seeds *and* the map.
2. **Use paper, and a digital copy if you like.** Print it, ideally with a QR code of the same text, since several hundred characters are tedious to type. An encrypted file in your own storage works too. Paper is not encrypted, so store it where the privacy caveat above is acceptable.
3. **Write the first receive address next to it.** After an import, the wallet should show that exact address first. If it shows a different one, something is wrong (a typo, a different script type, a missing key) and nothing should be sent to it.
4. **Label it in plain words.** "This is the map of our 2-of-3 bitcoin wallet. It cannot spend. Two of the three keys are also needed." Your heirs may not know what `wsh(sortedmulti(…))` means.
5. **Update it if the wallet changes.** Replacing a key makes a new wallet with a new descriptor. Retire the old copies once the coins have moved, so nobody restores the wrong one.

Some tools package the descriptor with extra setup details in a standard file. [BIP 129](https://github.com/bitcoin/bips/blob/master/bip-0129.mediawiki), "Bitcoin Secure Multisig Setup", describes such a format for registering and backing up a multisig wallet. If your software offers an export of that kind, it's a good thing to keep alongside the plain descriptor.

## Why your heirs need it most

You might remember, years from now, which wallet app you used and roughly how it was set up. Your heirs won't. They will arrive with an inheritance letter, two devices or seed phrases, and no idea of script types or derivation paths.

With the descriptor, the job is mechanical: import it into wallet software that supports multisig descriptors (Bitcoin Core does, through `importdescriptors`, as its [descriptors guide](https://github.com/bitcoin/bitcoin/blob/master/doc/descriptors.md) shows), check that the first address matches, connect two of the keys, and sign. Without it, they may need specialist help, and some combinations of lost information can't be recovered at all.

That is why a good inheritance plan names the descriptor explicitly and says where every copy is. [Bitcoin inheritance without a company](/blog/bitcoin-inheritance-without-a-company) walks through the rest of such a plan. If you're still deciding on a setup, [2-of-3 multisig explained](/blog/2-of-3-multisig-explained) covers how the keys and pairs work. If a key is already missing, [lost your hardware wallet, phone or seed phrase?](/blog/lost-hardware-wallet-phone-or-seed-phrase) covers what to do first.

## What not to do

- **Don't put seed words in the same file as the descriptor**, encrypted or not. The descriptor is meant to be spread around. Seeds are not.
- **Don't rely on a single app's cloud account as the only copy.** Accounts get closed, apps get discontinued, and passwords get forgotten. Keep at least one copy you can read without any particular app.
- **Don't edit a descriptor by hand** to "fix" it. If the checksum fails, find a better copy.
- **Never paste a descriptor, or anything else about your wallet, into a website** offering to "recover" or "check" your coins. A descriptor alone can't steal anything, but it tells a scammer exactly how much you hold and makes you a target.

## How Trikey handles the descriptor

[Trikey](/) is an open-source 2-of-3 wallet in which you hold all three keys. Its wallets are plain `wsh(sortedmulti(2,…))` descriptors on BIP 48 paths, the same form as the example above, so any multisig-capable wallet can import one and recover the coins with two keys, without Trikey ([design decisions](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#decisions-so-far)). The wallet core writes descriptors with the BIP 389 `<0;1>` form and the BIP 380 checksum.

Trikey keeps the descriptor wherever a key's backup is:

- **The phone's backup** is an encrypted file holding key 2 *and* the descriptor, opened with a recovery code you keep ([mobile app](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#mobile-app-react-native)).
- **In Recovery Key mode** (no home server), the printed Recovery Kit includes the descriptor for other wallet software, next to a QR code and the words that rebuild it ([Recovery Key mode](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#recovery-key-mode-no-home-server)).
- **For the optional Savings wallet**, the app prints a one-page wallet map: the checksummed descriptor as text and as a QR code, each key's device, fingerprint, path and xpub, and the first receive address to check an import against. The page holds no secret, and it says so, along with the privacy warning above ([Savings](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#savings-optional)).

**Status:** Trikey is pre-alpha and has **not been audited**. Try it on test networks (signet, testnet4 or regtest); if you use mainnet anyway, use only an amount you can afford to lose. The [testers guide](https://github.com/TheIcarusWings/trikey/blob/main/docs/testers.md) explains how.

## FAQ

### Is a wallet descriptor the same as an xpub?

No. An xpub is one key's public half. A descriptor combines one or more xpubs with the script, paths and threshold, so it describes the whole wallet. A multisig descriptor contains several xpubs.

### Can someone steal my bitcoin with my descriptor?

No. It contains only public keys. They can see your balance and history, which is why you should keep it private, but they can't sign anything.

### I only have a single-sig wallet. Do I need the descriptor?

It helps but is rarely essential, since wallets check the standard single-key paths when you restore a seed. Writing down the script type (for example "native segwit, BIP 84") does most of the job.

### What if I lost the descriptor but still have all three seeds?

Then you can usually rebuild it: each seed gives its xpub at the usual multisig path, and you can try the common script types until the first address matches your records. It's slower and needs care, which is why a saved copy is worth having.

### How many copies should I keep?

At least one with each key's backup, so any set of locations that holds enough keys also holds the map. More copies cost you privacy, not security.
