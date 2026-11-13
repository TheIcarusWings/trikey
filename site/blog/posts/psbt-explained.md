---
title: "PSBTs: How Several Devices Sign One Bitcoin Payment"
description: "What a PSBT (partially signed bitcoin transaction) is, what's inside one, how it moves between devices by USB, QR or file, and what each signer must check."
date: 2026-11-13
slug: psbt-explained
keywords: [what is a psbt, partially signed bitcoin transaction, multisig signing, air-gapped signing, hardware wallet]
draft: true
queue: 11
---
If you've used a hardware wallet with desktop software, or set up a multisig wallet, you've met the letters **PSBT**, often as a file to save, a QR code to scan or a step called "export the transaction". It stands for *Partially Signed Bitcoin Transaction*, and it's the reason a payment can be built on one device, signed on another, co-signed on a third, and broadcast from a fourth, without any of them sharing a private key. This post explains what a PSBT is, what's inside one, how it travels, and what each device should check before it signs.

## The problem a PSBT solves

A bitcoin transaction says "spend these coins, send this much here and the rest back to me", and it needs a valid signature for each coin it spends. In a simple software wallet, one program does everything: picks the coins, builds the transaction, signs it with the key it holds, and broadcasts it.

That breaks down as soon as the key lives somewhere else. A hardware wallet holds the key but has no internet connection and doesn't know which coins you own. A multisig wallet needs signatures from two or more devices, often in different places. Each signer needs to see the same proposed transaction, plus enough information to check it and to sign it, and somebody has to collect the signatures at the end.

Before PSBTs, every wallet and device maker solved this its own way, and the formats didn't talk to each other. [BIP 174](https://github.com/bitcoin/bips/blob/master/bip-0174.mediawiki) defined one common format in 2017, and today it's what nearly every wallet and hardware device uses to pass unsigned and partly signed transactions around.

## What's inside a PSBT

A PSBT is a small binary file, often shown as base64 text. It holds:

- **The unsigned transaction**: which coins (inputs) it spends and which addresses (outputs) it pays, with the amounts.
- **For each input, what a signer needs to know.** That includes the coin being spent: its amount and script, and often the whole earlier transaction that created it. It also includes, for multisig, the script that says which keys may sign.
- **Derivation hints**: for each key involved, the fingerprint of the device it belongs to and the path to it. A hardware wallet uses these to find its own key, and to recognise which outputs are its own change.
- **Signatures, as they are added**, one per key per input.

What it never holds is a private key. A PSBT is safe to pass through a computer, a phone, a USB stick or a QR code: the worst a tampered PSBT can do is ask a device to sign something wrong, which is exactly what the device's screen is there to catch.

## The life of a PSBT

BIP 174 describes the work as a set of roles. One program often plays several of them, but the steps are always the same.

1. **Create.** The wallet software (the *coordinator*) picks the coins, the payment and the change, and writes the unsigned transaction into a new PSBT.
2. **Update.** It adds what signers will need: the coins' details, the multisig script, the key paths.
3. **Sign.** Each signing device reads the PSBT, shows you what it's about to approve, and adds its signature. In a 2-of-3 multisig, two devices do this, one after the other or in parallel.
4. **Combine.** If devices signed separate copies, the coordinator merges them into one PSBT with all the signatures.
5. **Finalise.** Once enough signatures are in, it assembles them into the exact form the network expects for that script.
6. **Extract and broadcast.** It turns the PSBT into an ordinary signed transaction and sends it to the network.

A later standard, [BIP 370](https://github.com/bitcoin/bips/blob/master/bip-0370.mediawiki) ("PSBT version 2"), changes how the transaction is stored inside the file so inputs and outputs can still be added after creation, which helps when several people build one transaction together. Most single-owner wallets still use the original version, and the ideas above apply to both.

## How a PSBT travels

Because a PSBT is just data, it can move between devices in whatever way they share:

- **A cable or Bluetooth.** The device and the app talk directly; you only see the confirmation on the device.
- **A file.** Save it to a microSD card or USB stick, put it in the device, sign, and bring the signed file back.
- **QR codes.** The app shows the PSBT as a QR code, the device's camera reads it, and the device shows the signed result as a QR code for the app to read. A PSBT is often too large for a single QR code, so it's split into an animated series. Two formats are common: Blockchain Commons' [UR](https://developer.blockchaincommons.com/animated-qrs/) and Coinkite's [BBQr](https://github.com/coinkite/BBQr) (both checked November 2026).
- **NFC.** Some devices let you tap the phone against them to pass the PSBT across.

Signing over QR codes or files is called **air-gapped** signing: the signing device never connects to anything, so the only thing that crosses to it is the PSBT itself, which you can see and check.

The way the PSBT travels doesn't change what's signed. A signature commits to the transaction itself, so a PSBT that's altered in transit either fails to verify or shows the change on the device's screen.

## What a signer must check

The device's screen is the only part of the process you can trust when the computer or phone might be compromised. Before you approve, check:

- **Every output's address and amount**, against a copy of the address you trust. Read it on the device, not on the computer: start, middle and end.
- **The fee.** A fee that's a large share of the payment is a reason to stop.
- **The change.** It should be marked as change, or hidden, because the device can prove it returns to your wallet. For multisig, that proof needs the wallet registered on the device. If an output appears that you don't recognise, don't sign.

There's also a check you mostly can't see, done by the device itself: **are the input amounts real?** The fee is the inputs minus the outputs, so a device that can't trust the input amounts can't trust the fee it shows you. For the older segwit script types used by most multisig wallets today, a signature doesn't commit to the amounts of the *other* inputs. A malicious coordinator could, in principle, lie about amounts across two signing rounds and turn a modest fee into a huge one. The defence is to include each input's whole previous transaction in the PSBT, so the signer can check the amounts against the transaction ID itself. Many wallets and devices now include or ask for it.

## Common problems

- **"Unknown input" or "can't sign".** The device doesn't recognise any of its own keys in the PSBT. It's the wrong device, or the wallet is set up with a different key or path.
- **The device warns that change can't be verified.** For multisig, the wallet probably isn't registered on that device. Register it from the descriptor and check the first address. [What a wallet descriptor is](/blog/wallet-descriptor-explained) explains what it contains.
- **The PSBT is "missing UTXO data".** The coordinator didn't include the previous transactions the device wants. Updating the wallet software usually fixes it.
- **A signed PSBT won't finalise.** Not enough valid signatures yet, or two signatures from the same key. Check which devices actually signed.

## How Trikey uses PSBTs

[Trikey](/) is an open-source 2-of-3 wallet in which you hold all three keys: a hardware wallet, your phone, and either the Trikey Guardian on your own home server or a printed Recovery Key. Every payment is a PSBT passed between them.

- **The phone is the coordinator.** It builds the PSBT and signs with key 2. It then reaches the second signer, a hardware wallet over Bluetooth, USB-C or NFC, or an air-gapped device by animated QR (UR or BBQr) ([mobile app](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#mobile-app-react-native), [hardware wallets by feature](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#hardware-wallets-by-feature)). Or it sends the PSBT to the guardian over encrypted nostr messages ([protocol](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#protocol-nostr)).
- **The guardian checks before it co-signs.** It rebuilds every input's script from the wallet's descriptor, and it requires each input's full previous transaction and checks it against the transaction ID, the defence described above. It co-signs a phone payment only within the daily limit you set ([rules the guardian enforces](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#rules-the-guardian-enforces)).
- **The vault is a standard script.** `wsh(sortedmulti(2,…))` on BIP 48 paths, so any multisig-capable wallet can build and sign PSBTs for it without Trikey ([design decisions](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#decisions-so-far)).

[Choosing a hardware wallet for multisig](/blog/hardware-wallet-for-multisig) compares what different devices show when they sign.

**Status:** Trikey is pre-alpha and has **not been audited**. Try it on test networks (signet, testnet4 or regtest); if you use mainnet anyway, use only an amount you can afford to lose. The [testers guide](https://github.com/TheIcarusWings/trikey/blob/main/docs/testers.md) explains how.

## FAQ

### Is a PSBT file dangerous to share?

It holds no private keys, so it can't be used to spend on its own. It does reveal the coins and addresses involved, so treat it as private, like a bank statement.

### Can someone change a PSBT after I sign it?

They can change the file, but not usefully: your signature covers the transaction's inputs and outputs, so any change to those makes the signature invalid.

### Do I need a PSBT for a single-key hardware wallet?

You're using one already. Most desktop and mobile apps pass a PSBT to the device behind the scenes, even when it's plugged in by cable.

### What's the difference between a PSBT and a raw transaction?

A raw transaction is the finished, fully signed thing the network accepts. A PSBT is the work-in-progress around it: the same transaction plus the information signers need, and the signatures collected so far.

### Why does my air-gapped device show an animated QR code?

The PSBT is larger than one QR code can hold, so it's split into frames. Hold the camera steady until every frame has been read; the order doesn't matter.
