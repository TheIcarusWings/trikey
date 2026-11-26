---
title: "Recovering a Multisig Wallet Without the App That Made It"
description: "How to recover a multisig wallet without its coordinator app: what you need, how to import the descriptor elsewhere, and how two keys sign and send."
date: 2026-11-26
slug: recover-multisig-without-app
keywords: [recover multisig wallet without coordinator, multisig recovery, import multisig descriptor, wallet descriptor, psbt, 2-of-3 multisig]
draft: true
queue: 24
---
A multisig wallet is usually run by one app, the **coordinator**: it knows every key, builds payments, and passes them to each device to sign. Apps get discontinued, companies close, phones break and app stores remove listings. The coins don't depend on any of that. They sit on the bitcoin network, locked by a script that any software following the standards can rebuild. This post explains what you need to get them out without the original app, how the process works step by step, and where it usually goes wrong.

## The short answer

To spend from a multisig wallet without its original app, you need three things:

1. **The wallet's descriptor**, or the facts it contains: every key's extended public key (xpub), its fingerprint and derivation path, the script type, and how many signatures are required.
2. **Enough keys to sign**: two of three for a 2-of-3. Each one can be a hardware wallet that still works, or its seed words entered into a replacement device.
3. **Another wallet program that supports multisig descriptors and PSBTs.** Bitcoin Core does, and several desktop wallets do as well.

With those, recovery is mechanical: import the descriptor, check the first address, build a payment, sign it with two keys, and send it.

## Why the app was never the wallet

A coordinator app is a convenience. It stores the wallet's public setup, watches the blockchain for its addresses, and moves a payment between devices. It doesn't hold the coins and, in a well-designed self-custody setup, holds none of the keys either.

What locks the coins is a script on the blockchain, built from the keys. A **descriptor** is the standard way to write that script down as one line of text ([BIP 380](https://github.com/bitcoin/bips/blob/master/bip-0380.mediawiki)), for example `wsh(sortedmulti(2, key A, key B, key C))` with each key's origin and path. Any program that reads descriptors rebuilds the same addresses from it. [What a wallet descriptor is](/blog/wallet-descriptor-explained) reads one line by line.

That's why the descriptor matters more than the app. With it, switching software is an afternoon's work. Without it, you have to rebuild it from the keys, which is harder and sometimes not possible at all (see "If the descriptor is lost" below).

## Step 1: gather what you have

Before installing anything, lay out what's available:

- **Descriptor copies.** Paper, a PDF, a QR code, a file exported from the old app, a "wallet backup" or "setup file" from a hardware wallet's registration. Several formats exist. Most carry the same facts, and a descriptor with its checksum (the `#` and eight characters at the end) is the easiest to use.
- **The first receive address**, if you wrote it down. It's the best check that an import worked.
- **Keys.** Which hardware wallets still turn on and unlock? Which seed phrases do you have, with passphrases if any?
- **The network and the rough balance**, so you'll know when you've found the coins.

## Step 2: import the descriptor as a watch-only wallet

In the new software, create a wallet that holds no private keys and import the descriptor into it. Bitcoin Core calls this a watch-only descriptor wallet: create a blank wallet with private keys disabled, then import the descriptor with `importdescriptors` ([Bitcoin Core descriptors guide](https://github.com/bitcoin/bitcoin/blob/master/doc/descriptors.md)). Desktop wallets usually offer an "import wallet" or "new multisig wallet from file or text" option.

Then check two things before going further:

- **The first receive address matches** the one you wrote down, or the one the old app and your hardware wallets showed. If it doesn't, stop. A wrong script type, a missing key, a different path or a typo gives a perfectly valid wallet that has never seen your coins.
- **The balance appears** once the software has scanned the blockchain. Bitcoin Core may need a rescan from the wallet's creation date.

A watch-only wallet holds nothing that can spend, so this step is safe for your coins. It does reveal your balance and history to that software, so use your own node or a server you trust where you can.

## Step 3: build the payment as a PSBT

Spending from a multisig means collecting signatures from several devices. The standard container for that is a **PSBT**, a partially signed bitcoin transaction ([BIP 174](https://github.com/bitcoin/bips/blob/master/bip-0174.mediawiki)). The watch-only wallet creates it: choose where the coins go (preferably a fresh wallet you control and have verified) and the fee, and save the unsigned payment. Bitcoin Core does this with `walletcreatefundedpsbt`, or in its Send tab by creating an unsigned transaction ([PSBT guide](https://github.com/bitcoin/bitcoin/blob/master/doc/psbt.md)). [PSBTs explained](/blog/psbt-explained) covers the format.

If a key is lost, send everything to a **new** wallet whose keys you all hold now. Don't keep using a multisig with a missing or exposed key: losing one more would leave you below the threshold.

## Step 4: sign with two keys

Pass the PSBT to the first device, by USB, a QR code or a microSD card depending on the device:

- **Check the screen.** The device shows the destination address and the amount. Compare them with what you meant to send, character by character.
- **Register the wallet if the device asks.** Many hardware wallets want to know the multisig setup before they'll sign for it, so they can check that change returns to the same wallet. Registration takes the same descriptor or setup file.
- **Sign, then repeat** with the second device. Some software signs in turn (one device after another), and some collects separate signatures and combines them. Bitcoin Core's guide describes both ways.

A seed phrase without its device can sign too: restore it onto a replacement hardware wallet, never into a website or a computer you don't fully trust.

## Step 5: finalise, send, and check

Once enough signatures are in, the software finalises the PSBT into an ordinary transaction and broadcasts it. In Bitcoin Core, that's `finalizepsbt` and then `sendrawtransaction`, which its PSBT guide lists. Then watch for the payment to confirm and check that it arrived in the new wallet.

## If the descriptor is lost

All is not lost, but it gets harder:

- **With all three seeds**, you can rebuild it: each seed gives its xpub at the usual multisig path (for most wallets today, [BIP 48](https://github.com/bitcoin/bips/blob/master/bip-0048.mediawiki)), and you try the common script types until the first address matches your records.
- **With two seeds and the third key's xpub** (from an old export, a hardware wallet's registration, or a printout), the same works.
- **With two seeds and nothing about the third key**, the addresses can't be rebuilt, because each one depends on all three public keys. The coins are still there, but nothing can find them.

That last case is why every key's backup should carry a copy of the descriptor.

## Where it goes wrong

- **The wrong script type.** Native segwit (`wsh`), nested segwit (`sh(wsh(…))`) and legacy (`sh`) give different addresses from the same keys.
- **`multi` vs `sortedmulti`.** One keeps the keys in the listed order, the other sorts them. Mixing them up changes every address.
- **A missing passphrase** on one of the seeds gives a different key, so a different wallet.
- **Testnet keys on mainnet**, or the reverse. The xpub prefix (`xpub` vs `tpub`) is a clue.
- **A gap in the address history.** If the old app skipped many addresses, the new software may stop scanning too early. Raise its look-ahead (often called the gap limit) and rescan.

Practise this once while everything still works, on a test network first (signet or testnet4), so the steps aren't new on the day you need them.

## How Trikey plans for this

[Trikey](/) is an open-source 2-of-3 wallet in which you hold all three keys: a hardware wallet, your phone, and the Trikey Guardian on your own home server. It was designed to be left: everything in this post works for a Trikey wallet in other software.

- **A plain, standard script.** Every Trikey wallet is a `wsh(sortedmulti(2,…))` descriptor on BIP 48 paths, chosen because it's the one script every major hardware wallet can co-sign. Any multisig-capable wallet can import it and spend with two keys ([design decisions](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#decisions-so-far)).
- **The descriptor travels with the phone's key.** The phone's backup is an encrypted file holding key 2 and the descriptor, opened with a recovery code you keep ([mobile app](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#mobile-app-react-native)).
- **Standard formats throughout.** The wallet core writes descriptors with the BIP 389 `<0;1>` form and the BIP 380 checksum, and devices sign standard PSBTs.

**Status:** Trikey is pre-alpha and has **not been audited**. Try it on test networks (signet, testnet4 or regtest); if you use mainnet anyway, use only an amount you can afford to lose. The [testers guide](https://github.com/TheIcarusWings/trikey/blob/main/docs/testers.md) explains how.

## FAQ

### Can I recover a multisig with just two seed phrases?

Only if you also have the descriptor or the third key's xpub. The two seeds can sign, but the addresses depend on all three public keys, so without the third the software can't find the coins.

### Which software can import a multisig descriptor?

Bitcoin Core can, as a watch-only descriptor wallet, and so can several desktop wallets that support multisig. Check the current documentation of the one you choose for "import descriptor" or "multisig from file".

### Do I need the same hardware wallet brand as before?

No. Any device that supports the script type and multisig signing can sign for any key, once its seed is restored on it.

### Is it safe to paste my descriptor into a new wallet?

Into software you trust and run yourself, yes: it can't spend. Never into a website offering to "recover" or "check" your coins. It shows them exactly what you hold.

### Should I move the coins after recovering?

If a key was lost or may have been seen, yes: to a new wallet whose keys you all hold. If you only changed software, you can keep the wallet as it is.
