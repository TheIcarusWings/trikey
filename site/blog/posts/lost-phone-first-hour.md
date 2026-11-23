---
title: "Lost Your Phone? The First Hour for Your Bitcoin"
description: "Phone lost or stolen with a bitcoin wallet on it? What to do in the first hour, in order: lock it, protect your accounts, secure the wallet, and avoid the scams."
date: 2026-11-23
slug: lost-phone-first-hour
keywords: [phone stolen bitcoin wallet what to do, lost phone crypto wallet, stolen phone bitcoin, lost phone bitcoin recovery, mobile wallet security]
draft: true
queue: 21
---
Your phone is gone: left in a taxi, lifted from a table, snatched from your hand. If a bitcoin wallet was on it, the next hour matters more than the next week. Most of the damage from a stolen phone happens fast, because a thief who has your phone and your passcode can move quickly. This post is a checklist for that first hour, in the order that protects the most. It assumes nothing about which wallet you use. A section near the end covers how a multisig setup changes the picture.

## First, take a breath and work out what you're facing

Three questions decide how urgent this is:

1. **Was the phone locked, and did the thief see your passcode?** A phone stolen while unlocked, or by someone who watched you type your code, is the dangerous case. A locked phone with a strong passcode buys you time.
2. **What could the phone spend?** A mobile wallet's coins, exchange apps that are logged in, and any account that sends codes by text message to that number.
3. **Do you have your seed phrase or wallet backup somewhere else?** If yes, you can move your coins away from the phone's keys. If no, the phone may be the only copy.

Answer those in your head and start the list.

## Minutes 0 to 10: lock the phone down

- **Find a second device.** A laptop, a friend's phone, a computer at the nearest shop. Everything below needs one.
- **Mark the phone as lost.** Use Apple's Find My (iCloud) or Google's Find Hub (android.com/find) to lock it, show a message, and see where it is. On Android, Google's [theft protection page](https://support.google.com/android/answer/15146908) also describes a Remote Lock you can use at android.com/lock with just your phone number (checked November 2026).
- **Don't chase it.** If the location shows somewhere unfamiliar, tell the police, don't go yourself. No amount of bitcoin is worth a confrontation.
- **Erase later, not now.** Remote erase stops you tracking the phone, and you may need the phone's location for the police. If you're sure the phone is gone and your wallet backup is safe, erasing is fine, but decide that after the next steps.

## Minutes 10 to 30: protect what the phone number and accounts can reach

- **Change your Apple ID or Google password**, and sign out the lost phone from your account's device list. That stops it being used to reset other things.
- **Call your mobile carrier** to suspend the SIM, so texts with login codes stop arriving on the lost phone. Ask for a SIM lock or port-out PIN while you're on the line. Your number receives login codes, which is what makes it valuable to a thief.
- **Secure your email,** since email resets almost everything: change the password, sign out other sessions, check the recovery options.
- **Exchanges and custodial apps:** log in from the other device, change the password, revoke the lost phone's session, and freeze withdrawals if the service lets you. Many have an emergency "disable account" option.

## Minutes 30 to 60: secure the wallet itself

What you do here depends on how your wallet is set up.

**A single-key wallet on the phone, with your seed phrase written down elsewhere:** assume the thief may get into it eventually. On a device you trust, set up a **new** wallet with a **new** seed, then restore the old seed only long enough to move everything to the new wallet. Do it now, not tomorrow. Never restore your seed into an unfamiliar app or website to "check" the balance. [Storing a seed phrase](/blog/seed-phrase-storage) covers keeping the new one safe.

**A single-key wallet with no backup:** the phone is the only copy of the keys. If the phone has a strong passcode and the wallet its own PIN or biometric lock, the coins may be safe from the thief, but they're also out of your reach until the phone comes back. Keep tracking it, report it, and next time write the seed down.

**Coins on a hardware wallet that the phone only watched:** the keys aren't on the phone, so the thief can't spend them. Still treat the phone's companion app as exposed: it reveals your balance and addresses. That's a privacy loss, not a theft.

**A multisig wallet with a key on the phone:** the phone holds one key of several. Use your other keys to move the coins to a new wallet with a fresh key in the phone's place. The section below covers how that works in one design.

## The scams that follow a lost phone

People who've just lost a phone get targeted:

- **Fake "Find My" or Apple messages** with a link: "Your iPhone has been found, sign in to see its location." It's a phishing page to get your Apple ID password so the thief can unlock the phone. Treat any message that asks you to sign in through a link as phishing, and open Find My yourself instead.
- **Fake support** offering to help recover the wallet. Nobody needs your seed phrase to help you.
- **"Recovery services"** for stolen crypto. [Seed phrase phishing](/blog/seed-phrase-phishing) covers both scripts.

## Before it happens again

- **Turn on your phone's theft protections.** On iPhone, Apple's [Stolen Device Protection](https://support.apple.com/120340) requires Face ID or Touch ID for sensitive changes away from familiar places, with a one-hour security delay for the most critical ones. On Android, Theft Detection Lock and Offline Device Lock lock the screen if the phone is snatched or disconnected (checked November 2026).
- **Use a long passcode,** and shield it in public. Shoulder-surfing the passcode before stealing the phone is a common pattern.
- **Keep your seed phrase off the phone,** and don't keep large amounts in a phone-only wallet.
- **Don't receive login codes by SMS** where you can avoid it.
- **Rehearse.** Know where your backup is, and that you can restore it on another device.

[Lost your hardware wallet, phone or seed phrase?](/blog/lost-hardware-wallet-phone-or-seed-phrase) covers each loss case by case.

## How Trikey handles a lost or stolen phone

[Trikey](/) is an open-source 2-of-3 wallet in which you hold all three keys: a hardware wallet, your phone, and either the Trikey Guardian on your own home server or a printed Recovery Key. The phone holds one key of three, so losing it is designed to be survivable ([threat model](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#threat-model)):

- **A thief with the phone can spend at most your daily limit.** The guardian co-signs phone payments only up to the limit you set, and raising it needs the hardware wallet. If you turned the limit off, that protection is gone, and the design says so.
- **You can lock the guardian.** From its web page on your home network, a lock stops all co-signing, so even the daily limit is out of reach. If you allowed it, an alert contact can lock it for you by sending it the word `LOCK` ([rules the guardian enforces](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#rules-the-guardian-enforces)).
- **A new phone with your backup is immediate.** Restore the phone key from your encrypted backup file and recovery code. There's no waiting ([recovery flows](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#recovery-flows)).
- **A new phone without a backup takes the waiting period.** Your hardware wallet and the guardian move everything to a new wallet after a delay of 7, 14 or 30 days, with daily alerts to you and your contacts, so a thief can't do the same quietly ([Delay & Notify](/blog/delay-and-notify-time-locked-recovery)).

**Status:** Trikey is pre-alpha and has **not been audited**. Try it on test networks (signet, testnet4 or regtest); if you use mainnet anyway, use only an amount you can afford to lose. The [testers guide](https://github.com/TheIcarusWings/trikey/blob/main/docs/testers.md) explains how.

## FAQ

### Can a thief open my wallet app without my passcode?

Usually not on a modern phone with a strong passcode and the wallet's own lock. The risk rises sharply if they saw your passcode or took the phone while it was unlocked.

### Should I erase my phone remotely?

Once your wallet backup and accounts are secure, yes, if you don't expect to get the phone back. Erase it earlier if you have no backup of anything sensitive on it and the thief may have your passcode.

### Will my coins be lost if I never get the phone back?

Not if you have your seed phrase or wallet backup. Restore it on a new device and move the coins to a fresh wallet. Without a backup, a single-key phone wallet's coins are out of reach.

### Do I need to tell the police?

Yes. Report the theft, give the phone's IMEI from your carrier or the box, and note any crypto at risk. It rarely brings coins back, but it helps with insurance and with patterns the police track.

### How quickly can a thief drain a phone wallet?

With the phone and the passcode, in minutes. That's why the first hour matters, and why limits and multiple keys are worth having before it happens.
