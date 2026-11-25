---
title: "Rehearse Your Recovery Before You Need It"
description: "How to test a bitcoin wallet recovery safely: what a rehearsal proves, how to run one for a single key or a multisig, and the mistakes it catches in time."
date: 2026-11-25
slug: rehearse-bitcoin-recovery
keywords: [test bitcoin wallet recovery, test seed phrase backup, bitcoin recovery rehearsal, multisig recovery test, signet testnet4]
draft: true
queue: 23
---
Most people write down their seed phrase once, put it somewhere safe, and never look at it again. Then one day the phone breaks or the hardware wallet goes missing, and that sheet of paper is all they have. That's a bad moment to find out a word was misspelled, the passphrase was never written down, or nobody remembers which wallet app made the multisig. A backup you have never restored from is a guess. This post shows how to turn it into a fact: what a recovery rehearsal checks, how to run one safely for a single key and for a multisig, and how often to repeat it.

## What a rehearsal proves

A rehearsal is a restore you do on purpose, while everything still works, so mistakes cost nothing. It answers questions that looking at the backup can't:

- **Are the words right?** A misspelled or swapped word often goes unnoticed until a wallet refuses the phrase. Worse, a wrong word can sometimes still pass the phrase's built-in check and quietly open an empty wallet.
- **Is everything written down?** A passphrase (sometimes called a "25th word"), a PIN, the wallet's script type, and for multisig the **descriptor**: whatever was only in your head is missing from the backup.
- **Does it open the right wallet?** The test is simple: the restored wallet's first receive address must match the one you use today.
- **Can you, or someone else, follow it?** Steps that are obvious today may not be in five years, or to an heir who has never used a hardware wallet.

## Before you start: safety rules

A rehearsal handles your real secrets, so it must not create new ways to leak them.

- **Never type your seed words into a website**, a computer, or a phone app you don't already trust with that key. No real wallet support process asks for them.
- **Restore onto a hardware wallet or into the same kind of app you use**, not into a new tool you found for the occasion.
- **Never photograph the backup** to "make it easier", and put it back where it lives as soon as you're done.
- **Don't wipe your only device to test it.** If the backup turns out to be wrong, you have just lost the only working copy of the key. Use a spare device, or a check that doesn't wipe (below).
- **Do it alone, somewhere private.** Your seed shouldn't be visible to visitors, cameras or a video call.

## Rehearsing a single-key wallet

Before you start, note the wallet's **first receive address** (most apps show it in a list of addresses, or as the first one they ever gave you) and the current balance.

1. **Use a check that doesn't wipe, if your device has one.** Some hardware wallets can compare words you enter on the device itself with the seed they hold, without erasing anything. The device's manual calls it something like "check backup" or "recovery check". The words stay on the device and never touch a computer.
2. **Or restore onto a spare device.** Initialise the spare as "restore from recovery phrase", enter the words on the device, and add the passphrase if you use one.
3. **Compare the first receive address** shown on the restored device with the one you noted. Same address, same wallet. A different address means a word, the passphrase or the script type is wrong. Stop and work out which before you rely on this backup.
4. **Check that the balance appears** in your wallet app once it's connected to the restored device.
5. **Wipe the spare device** afterwards, unless you plan to keep it as a second copy, and store it like one.

If the restore failed, the backup has just done its job by failing now rather than later. Fix it: write a new copy from the device that still works, rehearse again, and destroy the old one safely. [Storing a seed phrase](/blog/seed-phrase-storage) covers where the corrected copy should go.

## Rehearsing a multisig wallet

A multisig wallet needs more than seed words to restore: it needs the wallet's descriptor, the one line of text that lists every key and how they combine. [What a wallet descriptor is](/blog/wallet-descriptor-explained) explains why. A multisig rehearsal checks three things.

1. **The descriptor opens the right wallet.** Import the descriptor as a watch-only wallet into a second app that supports multisig descriptors, such as Bitcoin Core with `importdescriptors` ([descriptors guide](https://github.com/bitcoin/bitcoin/blob/master/doc/descriptors.md)). It holds no private keys, so this is safe for your coins (it does reveal your balance to that app). The first receive address must match the one you use today.
2. **Each key still signs.** For every key, check that its device or seed works: unlock each hardware wallet and confirm it still shows the wallet's first address, or restore a key's seed onto a spare device as above.
3. **Two keys can spend without the original app.** This is the step most people skip, and the one that matters if the app you set up with disappears. Build a small payment to yourself in the second app, sign it with two of the keys, and send it. If you'd rather not pay a fee on your real wallet, run the whole exercise on a test network first (next section).

Write down what you did and where you got stuck. Those notes belong with the descriptor copies, for you and for whoever comes after you.

## Rehearse on a test network first

Bitcoin has test networks whose coins are worthless: **signet** ([BIP 325](https://github.com/bitcoin/bips/blob/master/bip-0325.mediawiki)) and **testnet4** ([BIP 94](https://github.com/bitcoin/bips/blob/master/bip-0094.mediawiki)). Many wallets and hardware wallets can use them. A test-network rehearsal lets you practise the parts you'd never risk on real money:

- set up a wallet exactly the way your real one is set up;
- "lose" a device or a phone on purpose, and recover without it;
- go through the recovery screens, delays and confirmations once, so they aren't new on the day it matters.

Never reuse your real seed words on a test network. Make fresh test keys, so practising doesn't put the real words on any extra device.

## Rehearse the people part too

If someone else will need to recover your coins one day, a rehearsal only you can do is half a rehearsal. Without handing over any secret:

- **Read your inheritance notes as a stranger would.** Do they say where each key and each descriptor copy is, which app or which kind of software to use, and what *not* to do (never type seed words into a website, never trust someone who contacts them offering help)?
- **Walk a trusted person through the test-network version.** They learn the shape of the job, with worthless coins.

[Bitcoin inheritance without a company](/blog/bitcoin-inheritance-without-a-company) covers what those notes should contain.

## How often

- **Right after setup**, before you move real money in.
- **After any change**: a new device, a replaced key, a new passphrase, a new wallet app or a new descriptor.
- **Once a year** otherwise, for example at the same time as another yearly task. Devices change, apps change and memories fade.

If a key is already missing, skip ahead: [lost your hardware wallet, phone or seed phrase?](/blog/lost-hardware-wallet-phone-or-seed-phrase) covers what to do first.

## How Trikey helps you rehearse

[Trikey](/) is an open-source 2-of-3 wallet in which you hold all three keys: a hardware wallet, your phone, and the Trikey Guardian on your own home server.

- **Every recovery path is written down.** DESIGN.md has a table of who needs what in each situation: a new phone with its backup (the recovery code restores key 2 at once), a lost phone without a backup (the hardware wallet and the guardian, after a delay with alerts), a lost hardware wallet, or a lost guardian ([recovery flows](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#recovery-flows)).
- **A recovery code you can print.** The guardian's web page shows a "Recover on a new phone" code, which holds no secret, to keep with the hardware wallet ([recovery flows](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#recovery-flows)).
- **Test networks in the published app.** The app runs on signet and testnet4 as well as mainnet, so the whole recovery, Delay & Notify included, can be rehearsed with worthless coins. The delay runs in real days there too, so plan a week ([mobile app](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#mobile-app-react-native); [Delay & Notify](/blog/delay-and-notify-time-locked-recovery)).
- **Recovery without Trikey.** The wallet is a plain `wsh(sortedmulti(2,…))` descriptor on BIP 48 paths, so any multisig-capable wallet can import it and spend with two keys, and step 3 above works in other software ([design decisions](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#decisions-so-far)).

**Status:** Trikey is pre-alpha and has **not been audited**. Try it on test networks (signet, testnet4 or regtest); if you use mainnet anyway, use only an amount you can afford to lose. The [testers guide](https://github.com/TheIcarusWings/trikey/blob/main/docs/testers.md) explains how.

## FAQ

### Is it safe to enter my seed phrase to test it?

On the hardware wallet itself, or a spare one you trust, yes: that's what the device is built for. Never into a website, a computer program you don't already trust with that key, or a message to anyone.

### Do I have to move my coins after a rehearsal?

Not if the words went only into your own hardware wallet or a spare you then wiped or keep safely. If they were typed somewhere you now doubt, treat the key as exposed and move the coins to a new wallet.

### The restored wallet shows a different address. What's wrong?

Usually one of three things: a wrong or misordered word, a missing or mistyped passphrase, or a different script type or derivation path. Check the passphrase first (it's case-sensitive), then the words, then the wallet's settings.

### Can I test a multisig recovery without spending anything?

Partly. Importing the descriptor as watch-only and checking each device's first address cost nothing. Proving that two keys can sign in other software needs a payment, which you can make on signet or testnet4 for free.

### How long does a rehearsal take?

A single-key check takes a few minutes. A full multisig rehearsal, with a descriptor import and a test payment, can take an afternoon the first time and much less after that.
