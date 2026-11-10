---
title: "Choosing a Hardware Wallet for Multisig: What Matters"
description: "The features that matter when a hardware wallet joins a multisig: wallet registration, address and change checks, PSBT, message signing and connections."
date: 2026-11-10
slug: hardware-wallet-for-multisig
keywords: [best hardware wallet for multisig, hardware wallet multisig registration, verify multisig address, hardware wallet message signing, multisig hardware wallet features]
draft: true
queue: 5
---
Almost every bitcoin hardware wallet can sign for a multisig wallet. Far fewer can *protect* you inside one. In a [2-of-3 multisig](/blog/2-of-3-multisig-explained), the hardware wallet is usually the key that stops a compromised phone or computer, so what matters is not the logo but what the device checks and shows on its own screen. This guide lists the features worth looking for, why each one matters, and the questions to ask before you buy. It does not crown a winner: firmware changes often, so check each vendor's current documentation for the features below.

## Why multisig asks more of a hardware wallet

With a single-key wallet, the device knows everything about the wallet: it holds the only key. In a multisig, it holds one key of three and has to trust the other two public keys it is told about. If malware on your computer or phone can swap one of those public keys, it can make "your" multisig addresses belong partly to the attacker, or make "change" go somewhere you do not control. BitBox's engineers described these attacks in detail in [how nearly all personal hardware wallet multisig setups are insecure](https://blog.bitbox.swiss/en/how-nearly-all-personal-hardware-wallet-multisig-setups-are-insecure/), and several vendors improved their firmware afterwards.

The features below are what close those gaps.

## 1. The script types you plan to use

Check that the device signs the multisig script your wallet uses. Native segwit multisig (P2WSH, usually on [BIP 48](https://github.com/bitcoin/bips/blob/master/bip-0048.mediawiki) paths) is the most widely supported. Taproot multisig and [miniscript](https://bitcoin.sipa.be/miniscript/) policies (timelocks, heir paths) are supported by fewer devices. If you want a timelocked recovery path, confirm support first.

## 2. Wallet registration

**Registration** means the device is shown the whole multisig wallet once (all public keys, the threshold, the script type), you approve it on the device's screen, and the device remembers it (or a proof of it). After that:

- it can show you receive addresses and confirm they belong to *this* wallet;
- it can recognise change going back to the same wallet, and show it as change rather than as a payment;
- a swapped public key produces a different wallet, which the device does not recognise.

Some devices store the wallet; others keep a short proof that the host sends back each time, as [Ledger's Bitcoin app](https://github.com/LedgerHQ/app-bitcoin-new) does with an HMAC. Some devices are stateless and rely on the details sent with each request. Ask how a device without registration verifies your cosigners and your change.

The [BSMS](https://github.com/bitcoin/bips/blob/master/bip-0129.mediawiki) standard (BIP 129) and output descriptors ([BIP 380](https://github.com/bitcoin/bips/blob/master/bip-0380.mediawiki)) are common ways to hand a wallet to a device.

## 3. Address verification on the device's screen

Before receiving a large amount, show the address on the hardware wallet and compare it with what your phone or computer shows. If malware changed the address on the computer's screen, the device's screen will not match. Look for:

- the **full address** on screen, not a shortened one;
- a check that the address belongs to the **registered** multisig, not just that it contains the device's own key;
- for best protection, the same address shown on **two different devices**.

## 4. Clear payment review

When you sign, the device should show every output's address and amount, the fee, and which outputs are change. If it cannot recognise change, it will show change as a payment to an address you cannot check by eye, and you lose the ability to spot a swap.

## 5. PSBT support and how it connects

Multisig transactions travel between signers as PSBTs ([BIP 174](https://github.com/bitcoin/bips/blob/master/bip-0174.mediawiki)). How the PSBT reaches the device is a trade-off:

| Connection | Strengths | Trade-offs |
|---|---|---|
| USB | Simple, fast | Needs a cable and a compatible port |
| Bluetooth | Works with phones | A wireless link to secure and pair |
| QR codes | Air-gapped, phone-friendly | Large transactions need animated QR codes |
| NFC | Tap to send, no cable | Phone support varies (iPhone apps need extra permissions) |
| microSD card | Air-gapped, any size | Slow; files can linger on cards and computers |

None is "the secure one". What matters is that the device shows and checks everything itself, whatever the channel.

## 6. Message signing at multisig paths

Some multisig wallets use the hardware wallet for more than payments: to approve a rule change, pair with a co-signer or prove ownership. They do it by asking the device to sign a short text with a key it controls, typically as a [BIP 137](https://github.com/bitcoin/bips/blob/master/bip-0137.mediawiki)-style signed message (or the newer [BIP 322](https://github.com/bitcoin/bips/blob/master/bip-0322.mediawiki)).

If a wallet you plan to use needs this, check three things:

- **Which key paths the device will sign a message with.** Some firmware only signs messages with single-key paths, or refuses multisig account paths.
- **How much text it shows.** A device that cuts the text after a fixed number of characters may hide the part you need to read.
- **That it shows the text at all.** A device that signs a message without displaying it is signing blind.

## 7. Protection against malicious firmware

A device with tampered firmware could, in theory, leak its key through the random values in its signatures. Some devices (for example the BitBox02 and Blockstream's Jade) support an **anti-exfil** or **anti-klepto** protocol in which the phone or computer contributes randomness and checks that the device used it. Also worth weighing: open-source firmware, reproducible builds, and how firmware updates are verified.

## 8. Mixing brands

In a multisig, using devices from different vendors means one vendor's bug or supply-chain problem affects only one key. The cost is learning two or three interfaces. Many people consider it worth it.

## A short checklist

- Does it sign my wallet's script type?
- Can I register the multisig and approve it on the device?
- Does it show full receive addresses and confirm they belong to the registered wallet?
- Does it recognise change?
- How does it connect to the phone or computer I will use?
- If my wallet needs message signing, will it sign at the paths it needs, and show the whole text?
- Is the firmware open source and reproducible?

## How Trikey approaches it

In [Trikey](/), the hardware wallet is key 1: it approves payments over your daily limit, every loosening of the rules, pairing with the guardian, and recovery access for a new phone. That puts more weight on the features above than a plain multisig does. From the design document's [hardware wallets by feature](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#hardware-wallets-by-feature):

- **Script:** plain `wsh(sortedmulti(2,…))` on BIP 48 paths, chosen because every major device can co-sign it.
- **Registration and address check:** the wallet is registered on devices that need it (Ledger, BitBox02, Jade, Coldcard), and the vault's first address is shown on the device for you to compare, for every device.
- **Approvals are signed messages** (BIP 137) of at most 240 characters, which show the new rules in clear, so you read them on the device's screen. Texts that name your alert contacts are kept within what the Jade displays before it truncates.
- **Connections:** Ledger over Bluetooth; Trezor through Trezor Suite Lite; Jade by QR or Bluetooth; BitBox02 over USB-C on Android (the Nova also over Bluetooth); Coldcard Q by QR, and Coldcard Mk4 or Q over NFC; Keystone 3, Passport Prime and Specter DIY by QR; Passport (2nd generation) and Krux by QR for payments and microSD for signed messages.
- **SeedSigner** signs payments but refuses messages at the multisig path Trikey's approvals use, so it works for payments and Recovery Key mode, not as the hardware wallet of a guardian wallet.
- **Anti-klepto** is used with the BitBox02 for payments and most texts.

The most important caveat: **only the Ledger has been tested on real hardware so far.** Support for every other device was written from its firmware's source code and official clients and is **untested on devices**. If you own one, a [hardware wallet test report](https://github.com/TheIcarusWings/trikey/issues/new?template=hardware-test.yml) on a test network is one of the most useful things you can contribute, even if everything works; the [testers guide](https://github.com/TheIcarusWings/trikey/blob/main/docs/testers.md) explains how to set up.

**Status:** Trikey is pre-alpha and has **not been audited**. Use it on test networks (signet, testnet4 or regtest); if you try mainnet, use only an amount you can afford to lose.

## FAQ

### Can I use any hardware wallet in a multisig?

Most current devices can sign standard P2WSH multisig. Whether they can register the wallet, verify addresses and recognise change varies, and those are what protect you.

### Do I need three hardware wallets for a 2-of-3?

No. Many setups use one or two hardware wallets plus a phone key or a co-signing service. What matters is that the keys live in different places and no single device or place holds two.

### Is an air-gapped hardware wallet safer for multisig?

Air-gapping removes a cable or wireless link, but the main protection in multisig is what the device verifies and shows. An air-gapped device that cannot recognise change is weaker than a connected one that can.

### Why does my hardware wallet show a "register wallet" screen?

It is asking you to approve the multisig wallet's keys once. Compare what it shows with your wallet software (and ideally your other devices) before approving.

### What does message signing have to do with multisig?

Nothing for payments. Some wallets use signed messages to let the hardware wallet approve non-payment actions, such as changing a spending limit. If yours does, the device must sign at the right path and show the whole text.
