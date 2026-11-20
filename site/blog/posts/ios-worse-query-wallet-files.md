---
title: "worse_query: What an iOS Bug Can Take From Your Wallet"
description: "An iOS bug lets malicious apps read other apps' files. What that exposes in a bitcoin wallet, what it doesn't, and what to do today."
date: 2026-11-10
slug: ios-worse-query-wallet-files
keywords: [worse_query, ios vulnerability, iphone crypto wallet, seed phrase security, mobile wallet security, multisig]
draft: false
---
On 10 November 2026, Binance warned iPhone users about **worse_query**, a bug in iOS that lets a malicious app read files that belong to other apps. Binance named seed phrases, private keys and login credentials as being at risk "across the entire ecosystem" ([Bitcoin Magazine](https://bitcoinmagazine.com/news/binance-warns-ios-flaw-wallet-seed-phrases)). That is alarming for anyone with a wallet on their phone. But what a bug like this can take depends on one thing: **where your wallet keeps its keys.** This post explains that, so you can judge your own wallet, and lists what to do today.

## What worse_query is, as reported so far

These are the facts as reported on 10 November 2026. Check the latest news before you act on them.

- **It is a sandbox escape.** Every iPhone app is meant to live in its own sandbox: it can read its own files and nobody else's. worse_query breaks that wall, so an app you install can read files that another app wrote.
- **A researcher, forcequitOS, published it** as a public proof of concept on 8 November. The security firm SlowMist lists **iOS 26.0 to 26.7.2 and iOS 27.2** as affected; Binance's warning names 26.7.1, 27.0.1 and 27.2 ([SlowMist on X](https://x.com/SlowMist_Team/status/2120045378792010166), [CryptoTicker](https://cryptoticker.io/en/ios-vulnerability-worse-query-crypto-wallets-iphone/)). If your version sits between those, assume it is affected too.
- **Apple released iOS 27.2.1 and 26.7.3 on 9 November.** SlowMist says 27.2.1 stops the bug, but Apple's security notes don't mention it, so treat the fix as likely, not confirmed ([Security Affairs](https://securityaffairs.com/202788/hacking/ios-sandbox-escape-is-public-and-apple-hasnt-confirmed-a-fix.html)).
- **No attack or theft had been reported** when this was written.
- **SlowMist's point is the one that matters here:** the bug alone doesn't steal anything. The risk is an untrusted app on your phone, combined with a wallet that keeps seeds, keystores or caches in plain files.
- **The attacker needs an app on your phone.** It is not a remote attack: someone has to get you to install a malicious app, most likely from outside the App Store (a "sideloaded" or manually signed app).

## Files and the Keychain are two different places

A phone wallet can keep its secrets in two kinds of storage, and worse_query reaches only one of them.

1. **The app's own files.** A database, settings, caches. These live in the app's folder, and the sandbox is the only thing that protects them from other apps. A sandbox escape like worse_query reads them.
2. **The Keychain** (on Android, the Keystore). It is a system service, not a file in the app's folder. Its items are encrypted with keys guarded by the phone's secure chip (the Secure Enclave on iPhone). An item can also be set to need Face ID or a fingerprint every time it is read, and to never leave the device. A bug that only reads files doesn't hand over what is in the Keychain.

So the question for any wallet is: **does it write the seed, or a private key, into its own files?** A wallet that keeps them in the Keychain loses privacy to a bug like this: your addresses, your balance, your history. A wallet that keeps a seed in a file, even "obfuscated", can lose the money.

How to find out for your wallet:

- Look for a security page or a threat model in the wallet's documentation that says where keys are stored. For an open-source wallet you can also read the code.
- Words to look for: Keychain, Secure Enclave, Android Keystore, "this device only", "biometric".
- Be wary of wallets that never say. "Bank-grade encryption" doesn't tell you where the key is.

## What a file-reading bug can expose

Even when the keys are safe, an app's files hold things you'd rather keep to yourself:

- **Your public keys and addresses.** Many wallets store an extended public key (xpub) or a descriptor. With it, someone can list every address of the wallet, so your **balance and your whole history**. They can't spend with it, but it tells them what you hold, which matters for phishing and physical safety.
- **Labels and notes:** what you called each payment and who you paid.
- **Session tokens** for exchanges and other services, if an app keeps them in files. This is where "logins at risk" comes from.

## What to do today

1. **Update iOS.** Settings, General, Software Update. Take the newest version offered: 27.2.1 or later on iOS 27, 26.7.3 or later if your phone stays on iOS 26. On 27.1, 27.0.x or an older 26.x, update.
2. **Remove apps you don't trust**, especially ones that didn't come from the App Store: sideloaded or manually signed apps from strangers, "modded" apps, cracked games. The bug needs one of those on your phone to do anything.
3. **Don't panic-move your coins into something new.** Scammers follow security news: expect fake "migration tools", fake support accounts and "verify your wallet" messages. Nobody legitimate will ask for your seed words.
4. **If you have reason to think your phone was compromised** (a strange app you installed, signs of tampering), treat its keys as exposed:
   - Create a new wallet on a clean, updated device.
   - Move the funds there.
   - Reset your exchange sessions and passwords.

   A restore of the same seed on a new phone isn't enough: whoever has a copy can still use it. Our post on [losing a phone, a hardware wallet or a seed phrase](/blog/lost-hardware-wallet-phone-or-seed-phrase) goes through the cases.

## Why a phone key shouldn't be the only key

worse_query is one bug. There will be others, in iOS, in Android, in apps. That is the strongest argument against keeping all your bitcoin behind **one key on a phone**. A phone runs hundreds of other apps and connects to everything; it is the most exposed device you own.

With [2-of-3 multisig](/blog/2-of-3-multisig-explained), the phone's key is one of three, and moving money needs two. A phone bug, even one that did reach the key, would give an attacker one key. Pair that with a [daily limit and an alert](/blog/address-poisoning-clipboard-malware-daily-limit) on the second key, and the worst case of a phone compromise becomes "at most one day's limit", not "everything".

## Trikey and worse_query

[Trikey](/) is an open-source 2-of-3 wallet: your hardware wallet (key 1), your phone (key 2) and the Trikey Guardian on your own home server (key 3). How it stands against a file-reading bug:

- **Key 2 lives in the Keychain**, set to "this device only", never in backups, and readable only with Face ID. Every other key the app holds is in the Keychain or Keystore too. The app's files hold the wallet's public descriptor, the guardian's pairing details, labels and history: a privacy loss if read, with no power to sign. The full list, item by item, is in [what the phone app keeps, and where](https://github.com/TheIcarusWings/trikey/blob/main/docs/security/phone-storage.md).
- **Even key 2 alone moves at most the daily limit.** The guardian co-signs phone-only payments within a limit you set. Raising the limit, changing a rule or starting a recovery needs your hardware wallet, or waits through a Delay & Notify period that alerts you every day ([rules the guardian enforces](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#rules-the-guardian-enforces)).
- **If you suspect your phone,** you can lock the guardian from the phone or its web page, restore key 2 on a clean phone from your backup, and use "Replace guardian" to move your coins to a fresh wallet.
- **About "manually signed apps":** while the iPhone app isn't on the App Store, testers build Trikey themselves from its public source code, which iOS counts as a manually signed app. Building an open-source app yourself is not what the warning is about. The warning is about apps from people you don't know. Keep your own build, update iOS, and remove anything you don't trust.

**Status:** Trikey is pre-alpha and has **not been audited**. Use it on test networks (signet, testnet4 or regtest); if you try mainnet anyway, use only an amount you can afford to lose.

## FAQ

### Is my seed phrase exposed by worse_query?

Only if your wallet writes it into its own files. Wallets that keep the seed in the iPhone Keychain, especially with Face ID required, are not exposed by a bug that only reads files. Check your wallet's documentation, update iOS, and remove apps you don't trust.

### Do I need to move my bitcoin?

Not because of the news alone. Move it if you installed something you don't trust, or see signs your phone was tampered with. Then move it to a wallet created on a clean device, not to the same seed restored elsewhere.

### Does a hardware wallet protect me?

Its keys never touch the phone, so a phone bug can't read them. What it can reveal is your xpub, if a companion app stores it: that is privacy, not access to the coins.
