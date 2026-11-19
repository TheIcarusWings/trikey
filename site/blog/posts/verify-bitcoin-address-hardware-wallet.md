---
title: "How to Check a Bitcoin Address on Your Hardware Wallet"
description: "How to verify a bitcoin address before sending or sharing it: what the hardware wallet's screen proves, what it can't, and a short routine that catches swaps."
date: 2026-11-13
slug: verify-bitcoin-address-hardware-wallet
keywords: [how to verify a bitcoin address before sending, verify receive address hardware wallet, address poisoning, clipboard malware, multisig change address]
draft: true
queue: 10
---
A bitcoin payment can't be reversed. If the address is wrong, the coins are gone, and the most common way for an address to be wrong is not a typo but a swap: malware, a poisoned transaction history or a tampered web page puts someone else's address where yours should be. A hardware wallet's screen is the tool that catches it, but only if you know what to look at and what that screen can and can't prove. This post walks through both directions, receiving and sending, and ends with a routine short enough to use every time.

## Why the computer or phone screen isn't enough

Your computer or phone runs a lot of software: the browser, extensions, the wallet app, whatever else is installed. Any of it, if malicious, can change what you see. Three well-known tricks:

- **Clipboard swapping.** Malware watches the clipboard. When you copy something that looks like a bitcoin address, it replaces it with the attacker's. You paste, glance at the first few characters, and send.
- **Address poisoning.** An attacker sends a tiny payment from an address that starts and ends like one you use, so it appears in your history. Later you copy "the usual address" from the list and get theirs.
- **A tampered page or app.** A fake or compromised wallet app shows a receive address that isn't yours at all.

A hardware wallet is a separate small computer with its own screen. Its software derives addresses from your keys itself, so what it displays doesn't depend on the computer it's plugged into. Trezor calls this the [Trusted Display](https://trezor.io/learn/a/what-is-a-trusted-display) and makes the point plainly: it shows the address the device itself generated, or the transaction it's about to sign. It can't tell you whether an address someone else gave you is the right one. (Checked November 2026.)

That one sentence sets out the whole job. On the receiving side, the device can prove an address is yours. On the sending side, it can only prove what you're about to sign, and you must check that against something you trust.

## Receiving: prove the address is yours

Before you hand out an address, or send coins to yourself from an exchange, show it on the device.

1. In your wallet app, open **Receive** and choose the option to show or verify the address on the device. Wording varies: "Show on device", "Verify address", "Display address".
2. The device displays the address. Compare it **character by character** with what the app shows, or at least the first eight, the last eight and a stretch in the middle. Attackers can generate addresses that match the start and end; matching the middle too is much harder.
3. Confirm on the device only if they match. If they don't, stop: something between the device and the screen is lying.
4. Share the address from the app as usual, then compare once more where it lands (the exchange's withdrawal form, the message you're sending), because clipboard malware strikes after the check.

Some devices can also show the address as a QR code on their own screen, so the other party can scan it from the device itself.

### Multisig: register the wallet first

For a single-key wallet the device can derive the address alone. A **multisig** address is built from several keys, so the device needs to know the other keys too. Devices that support it let you **register** the multisig wallet once: you import the wallet's setup (its descriptor or a setup file), the device shows the details for you to approve, and stores them. Blockstream's [guide to registering a multisig on Jade](https://help.blockstream.com/hc/en-us/articles/10893386053785-How-do-I-register-an-M-of-N-multisig-with-Jade) describes how registration then lets the device verify receive addresses and check change automatically when signing.

Two practical points:

- **Check the first address on every device.** In a 2-of-3, each device that can display multisig addresses should show the same first receive address. A device that shows a different one has a different picture of the wallet, and that is exactly the kind of mismatch you want to find before any coins arrive. [2-of-3 multisig explained](/blog/2-of-3-multisig-explained) covers why each key matters.
- **Write the first address down with your backup.** When you or your heirs restore later, the first address the restored wallet shows should be the same.

## Sending: check what you are about to sign

When you pay, the device shows each output of the transaction (the address and the amount) and the fee. It can't know whether the address belongs to the person you mean to pay. Your job is to compare it with a copy you trust.

1. **Get the address from a source the attacker can't easily reach.** Best: the recipient's own device screen, read to you, or a second channel. Ask over a call, or confirm in a different app from the one the address came in. For a regular payee, keep the address you verified the first time in a note you control, not in your transaction history.
2. **Compare on the device, not the computer.** Read the address on the hardware wallet's screen, character by character, against your trusted copy.
3. **Check the amount and the fee.** A fee that's a large share of the payment is a reason to stop.
4. **Check that change returns to you.** Most payments have a second output, the change, going back to your own wallet. Good devices mark it as change, or hide it, only when they can prove it's yours: for single-key wallets from the derivation path, for multisig only after the wallet has been registered. If an output you don't recognise appears, or the device can't confirm the change, stop and find out why.
5. **Send a small test first** to a new address, if the amount justifies the extra fee. Ask the recipient to confirm it arrived, then send the rest to the same verified address.

Never copy an address from your transaction history. That's exactly where address poisoning puts its look-alikes. [Address poisoning and clipboard malware](/blog/address-poisoning-clipboard-malware-daily-limit) goes deeper into how both attacks work.

## What the device can't protect you from

- **A wrong address you approve anyway.** If you confirm without reading, the device has done its part.
- **An address that was wrong from the start.** If a scammer convinces you their address is your exchange's, the device will faithfully show their address.
- **Addresses the device can't interpret.** Some newer address formats are turned into a different-looking output before signing. For example, a silent payment address (`sp1…`) becomes an ordinary taproot output (`bc1p…`), so the device can't check it against what you typed. The wallet app should show both so you can compare.
- **A device or firmware you didn't get from the maker.** Buy from the manufacturer or an authorised seller, and follow the device's own checks when setting it up.

## A one-minute routine

For every payment and every address you share:

1. Show it on the device.
2. Compare start, middle and end against your trusted copy.
3. Check the amount, the fee and the change.
4. Confirm on the device only if all three match.
5. For a new payee or a large amount: test first, confirm by a second channel.

That's it. It takes a minute, and it defeats the attacks that empty the most wallets: the ones that never touch your keys, only what you see.

## How Trikey handles it

[Trikey](/) is an open-source 2-of-3 wallet in which you hold all three keys: a hardware wallet, your phone, and either the Trikey Guardian on your own home server or a printed Recovery Key.

- **Registration and the first address.** On devices that need it (Ledger, BitBox02, Jade, Coldcard), the app registers the wallet on the device and shows the first address there ([mobile app](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#mobile-app-react-native)). For every supported device, the vault's first address is shown on the device's own screen for you to compare ([hardware wallets by feature](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#hardware-wallets-by-feature)).
- **No address before the device has confirmed one.** In Recovery Key mode, the app shows, copies or shares no vault address until the device has shown the first one and you've confirmed it matches. A swapped key export would otherwise put someone else's key in the vault ([Recovery Key mode](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#recovery-key-mode-no-home-server)).
- **Limits for the attacks that slip through.** If malware gets a phone payment past you, the guardian co-signs phone-only payments only up to a daily limit you set, so, unless you have turned the limit off, a swapped address costs at most that much without the hardware wallet ([rules the guardian enforces](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#rules-the-guardian-enforces)).

[Choosing a hardware wallet for multisig](/blog/hardware-wallet-for-multisig) compares what different devices show on screen.

**Status:** Trikey is pre-alpha and has **not been audited**. Try it on test networks (signet, testnet4 or regtest); if you use mainnet anyway, use only an amount you can afford to lose. The [testers guide](https://github.com/TheIcarusWings/trikey/blob/main/docs/testers.md) explains how.

## FAQ

### Do I need to verify the address every time?

Every time you share a new receive address, and every time you pay. Verification takes seconds, and the attacks it stops are silent: you'd only notice after the coins have left.

### Is checking the first and last few characters enough?

Not on its own. Attackers generate look-alike addresses that match the start and end; check a stretch in the middle too, or the whole address for large payments.

### My hardware wallet shows a different address from the app. What now?

Don't use either. Disconnect, check you're using the official app from the maker or a trusted source, and try again. If they still differ, assume the computer or phone is compromised and get help from the device maker's support (who will never ask for your seed words).

### Can a hardware wallet protect me when I paste an address from an email?

It shows you exactly what you'll pay, so it protects you only if you compare it with a copy you trust. Confirm addresses from emails or chats through a second channel before paying.

### Why does my multisig device say it can't verify the change?

Usually because the multisig wallet isn't registered on that device, so it can't prove the change output belongs to you. Register the wallet (most devices take a descriptor or setup file), check the first address, and try again.
