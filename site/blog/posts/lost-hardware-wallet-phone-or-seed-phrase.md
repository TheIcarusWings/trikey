---
title: "Lost Your Hardware Wallet, Phone or Seed Phrase?"
description: "What happens to your bitcoin if you lose a hardware wallet, a phone or a seed phrase, case by case, with the steps to take and the scams to avoid."
date: 2026-11-10
slug: lost-hardware-wallet-phone-or-seed-phrase
keywords: [lost hardware wallet, lost seed phrase, phone stolen bitcoin wallet, recover bitcoin wallet, lost bitcoin keys]
draft: false
---
Your bitcoin is not inside your hardware wallet or your phone. It sits on the blockchain, locked to keys, and a device is only a safe place to keep and use those keys. So what losing a device means depends on one question: **do you still have another way to produce the same keys?** This guide goes through the common cases, from a lost device with a good backup to a lost seed phrase, for single-key wallets and for multisig, and says what to do in each.

## First, three rules that apply to every case

1. **Nobody can recover keys for you.** No support desk, "recovery service" or website can bring back a lost seed phrase. People who search for help after a loss are a favourite target for scams: fake support numbers, paid "recovery" firms and pages that ask you to type your seed words. Never enter seed words on a website or give them to anyone.
2. **If a key may be in someone else's hands, move the coins.** A backup lets you restore, but it does not make the lost copy harmless. When in doubt, send everything to a new wallet with fresh keys.
3. **Act on the backup you actually have.** Check it before you need it: the words are legible, the order is right, and any passphrase is recorded somewhere you will find it.

## Single-key wallets: case by case

### You lost the hardware wallet but have the seed phrase

Your funds are safe. Restore the seed phrase on a new device (same brand or any other that supports the standard, usually [BIP 39](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki)), add the passphrase if you used one, and check that your balance appears.

Then decide whether to move the coins. The lost device is protected by its PIN, and most devices wipe or permanently lock themselves after a number of wrong PINs, but you cannot know who has it or what they can try. If the amount matters, create a new wallet with a new seed, back it up, and send everything to it.

### The device was stolen

Same steps, with more urgency. Restore from your seed on another device and move the funds to a fresh wallet before a thief has time to work on the PIN or the device.

### You still have the device but lost the seed phrase

Nothing is lost yet, but you are one accident away from it. Do not wait:

1. Set up a new wallet with a new seed and write that seed down carefully.
2. Check the new backup (many devices offer a "verify backup" step).
3. Send all funds from the old wallet to the new one.

Avoid trying to "recover" the old seed through software or online tools. A new, properly backed-up wallet is faster and safer.

### Your seed phrase may have been seen

A photo in the cloud, a sheet left in a drawer that someone else opened, words typed into a website: treat the seed as compromised. Move everything to a new wallet with a new seed now. Restoring or "securing" the old seed does nothing.

### You lost both the device and the seed phrase

If there is no other copy of the seed and no wallet file on an old computer, the coins cannot be moved by anyone. This is the hard edge of self-custody, and the main reason people move to setups with more than one key.

### A phone wallet was lost or stolen

For a single-key wallet on a phone, the seed phrase backup is everything. If you have it, restore it on another device and move the funds to a new wallet: the old phone still holds a copy of the key, protected only by its screen lock and the app's own lock. Also lock or erase the phone remotely and secure the email and phone number accounts it was signed into.

## Multisig wallets: losing one key is survivable

In a [2-of-3 multisig](/blog/2-of-3-multisig-explained) wallet any two keys spend, so losing one key is an inconvenience, not a loss.

### The recovery routine

1. Use the two keys you still have.
2. Create a new wallet: the two surviving keys plus a fresh third key (often at a new account on the same devices).
3. Send everything from the old wallet to the new one.
4. Back up the new wallet's descriptor and the new key.

Why move instead of just replacing the lost device? The old wallet's rule includes the lost key forever. If someone finds that key, they hold one of the three. Moving to a new wallet takes it out of the picture.

### What you need besides the keys

Two seeds alone are usually not enough to find the coins. Your wallet software also needs the **descriptor**: the three public keys and how they are combined. Keep a copy of it with each key backup. It holds no secret (it cannot spend), but it shows your balance and history to whoever reads it.

### When two keys are lost

If two of three keys are gone, a 2-of-3 wallet is in the same position as a single-key wallet with no backup. Restore whatever seeds you have from their backups before you consider anything else.

## Why some wallets make you wait

Some wallets let a single surviving key start a recovery, but only after a waiting period, with alerts sent to you during it. The point is to make a stolen key slow and noisy rather than fast and silent: if you did not start the recovery, you have days to cancel it. We cover this in [Delay & Notify: why recovery should wait](/blog/delay-and-notify-time-locked-recovery).

## How Trikey approaches it

[Trikey](https://trikey.app) is a 2-of-3 wallet with a hardware wallet (key 1), your phone (key 2) and the Trikey Guardian on your own home server (key 3). Its recovery flows follow the cases above:

| What you lost | What happens in Trikey |
|---|---|
| Phone, with its backup | Restore the phone key on a new phone from your encrypted backup file and recovery code. No waiting. |
| Phone, no backup | The hardware wallet lets a new phone reach the guardian, and a recovery starts. It waits 7, 14 or 30 days (your choice), alerts you and your alert contacts every day, and any of you can cancel it. Then the money moves to a new 2-of-3 wallet. |
| Phone stolen | A thief with an unlocked phone can spend at most your daily limit. Raising the limit needs the hardware wallet. Starting a recovery pauses phone-only payments. |
| Hardware wallet | Restore its seed words on a new device, or use the phone and guardian to run the same waiting-period recovery. |
| Hardware wallet stolen | It is PIN-locked and one key of three. A recovery someone starts with it triggers the daily alerts, and you cancel it. |
| Home server dies or is stolen | The phone and hardware wallet still move any amount. "Replace guardian" moves the coins to a new wallet with a new guardian. The guardian keeps key 3 encrypted and locks itself after any restart, so an unplugged box is useless to a thief. |

Because the wallet is a standard `wsh(sortedmulti(2,…))` descriptor, any two of your keys can also move the coins in another multisig wallet, without Trikey.

The full table, including the cases where a thief and the owner each hold one key, is in the design document's [recovery flows](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#recovery-flows) and [threat model](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#threat-model). The site's [pick a key to lose](/#missing) section walks through it with short videos.

**Status:** Trikey is pre-alpha and has **not been audited**. Use it on test networks (signet, testnet4 or regtest); if you try mainnet, use only an amount you can afford to lose. The [testers guide](https://github.com/TheIcarusWings/trikey/blob/main/docs/testers.md) includes a step where you delete the app and restore from your backup, which is worth rehearsing with any wallet.

## FAQ

### Is my bitcoin gone if I lose my hardware wallet?

No, not if you have the seed phrase (and passphrase, if you used one). Restore it on a new device. Consider moving the funds to a fresh wallet afterwards.

### Can the manufacturer recover my wallet?

No. Hardware wallet makers do not have your seed. Anyone claiming to recover a wallet for a fee, or asking for your seed words, should be treated as a scam.

### I forgot my PIN but have the seed. What now?

Most devices wipe or lock themselves after too many wrong attempts, and many let you reset them. Either way, restore from the seed phrase on the reset device or a new one.

### Should I move my coins after restoring?

If the lost device or seed could be in someone else's hands, yes. A restore gives you access; only a move to new keys makes the lost copy worthless.

### What do I need to recover a multisig wallet?

Enough keys to meet the threshold (two of three for 2-of-3) and the wallet's descriptor. With both, any multisig-capable wallet can rebuild it.
