---
title: "Fake Wallet Apps: How to Check an Android App Is Real"
description: "Fake bitcoin wallet apps steal seed phrases. How to check an Android wallet app is real: where to get it, and how to verify its signing certificate."
date: 2026-11-28
slug: fake-wallet-apps-apk-signature
keywords: [fake bitcoin wallet app, fake crypto wallet app, verify apk signature, android app signing certificate, apksigner]
draft: false
---
A fake wallet app doesn't need to hack anything. It just looks like the real one, waits for you to type in your seed phrase "to restore your wallet", and sends it to its owner. Fakes turn up in official app stores, in search ads and as links on social media. The good news is that Android gives you a solid way to tell a real app from a copy: every app is signed with its developer's key, and that signature can't be faked. This post explains where fakes come from, how app signing works, and how to check an app before you trust it with your bitcoin.

## Where fake wallet apps come from

- **Official app stores.** Store review catches a lot, not everything. In 2025, researchers at Cyble reported around 20 fake crypto wallet and exchange apps on Google Play that asked users for their 12-word phrase. Some were uploaded through developer accounts that had been taken over ([Hackread's report](https://hackread.com/malicious-apps-google-play-users-for-seed-phrases/), checked November 2026).
- **Search ads and look-alike sites.** Searching for a wallet's name can put an ad for a copy above the real site, with a download button for a modified app.
- **Links in messages.** "Download the new version" from a fake support account, or a link in a group chat.
- **Modified apps.** A real wallet, rebuilt with a few lines changed to send your seed somewhere. It looks and works exactly like the original.

That last kind is why looks, reviews and download counts prove nothing. A copy can look identical. What a copy can't do is carry the real developer's signature.

## How Android app signing works

Every Android app (an APK file) is signed by its developer with a private key that only they hold. The signature covers the app's contents. The matching **signing certificate**, which is public, travels inside the APK.

Two rules make this useful:

1. **A changed app needs a new signature.** If someone modifies an APK, the original signature no longer matches. They must re-sign it with their own key, which gives a different certificate.
2. **Android only installs updates signed with the same key.** Once you've installed the real app, Android refuses to update it with an APK signed by anyone else. Google's [app signing documentation](https://developer.android.com/studio/publish/app-signing) describes this rule (checked November 2026).

So an app's identity is really two things: its **package name** (such as `com.example.wallet`) and its **signing certificate**, usually shown as a SHA-256 fingerprint, a 64-character code. The package name can be copied; the certificate can't.

The second rule protects you only after the first install. The first install is where you need to check.

## Before you install

- **Start from the developer's own website,** typed in or bookmarked, not from a search ad or a link someone sent you. Follow its link to the app store listing or its download page.
- **Check the developer name** on the store listing against the one the website names.
- **Be wary of a listing that's very new** for a wallet that has existed for years, or that has very few reviews.
- **Find the published certificate fingerprint.** Serious open-source wallets publish their signing certificate's SHA-256, often on their website or in their repository. That's what you'll compare against.

## Checking the certificate on your phone

You don't need a computer for this.

- **AppVerifier** is an open-source Android app that shows the signing certificate of any installed app and compares it with a value you paste in ([AppVerifier on GitHub](https://github.com/soupslurpr/AppVerifier)). Install your wallet, but don't open it or enter anything yet. Open AppVerifier, find the wallet, and compare its fingerprint with the one the developer published.
- **Obtainium**, an open-source app that installs and updates apps straight from their releases, can be told the expected certificate fingerprint for an app. It then refuses to install an APK signed by anything else.
- **Some stores show it too.** Store pages for open-source apps sometimes list the signing certificate. Use it as a second source, alongside the developer's site.

If the fingerprint doesn't match, uninstall the app straight away and don't enter anything into it.

## Checking the certificate on a computer

If you downloaded an APK file, Android's own SDK tools can show who signed it. Google documents `apksigner` as the tool for this ([apksigner documentation](https://developer.android.com/tools/apksigner), checked November 2026):

```
apksigner verify --print-certs wallet.apk
```

Look for the line `Signer #1 certificate SHA-256 digest:` and compare it with the developer's published fingerprint, all 64 characters.

## Red flags inside an app

Even an app that passed the checks above should never:

- **ask for your seed phrase as soon as it opens,** when you didn't choose to restore a wallet;
- **ask you to "verify" or "sync" your wallet by typing your words;**
- **show your seed on screen when you didn't ask,** or offer to "back it up to our servers";
- **push you to install another app** or an "update" from a link.

Any of these is a reason to stop. [Seed phrase phishing](/blog/seed-phrase-phishing) covers the scripts fake apps and fake support use.

## If you've already typed your seed into a fake app

Assume it's stolen. On a device you trust, set up a new wallet with a new seed and move everything that's left, straight away. Then uninstall the fake app and report it to the store. Never reuse the old words. A hardware wallet helps here: its keys never touch your phone, so a fake phone app can't take them unless you type the words in. [Lost your hardware wallet, phone or seed phrase?](/blog/lost-hardware-wallet-phone-or-seed-phrase) covers what to do next for each case.

## How Trikey handles it

[Trikey](/) is an open-source 2-of-3 wallet in which you hold all three keys: a hardware wallet, your phone, and either the Trikey Guardian on your own home server or a printed Recovery Key. Its Android app isn't on Google Play yet. It's published as APK files with each release, and through Obtainium and Zapstore.

- **One published certificate.** Every Trikey APK is signed with the same release key, and its certificate's SHA-256 is published on [the Obtainium page](/obtainium) and in the repository. You can paste it into Obtainium or AppVerifier. A release is only published once both APKs are confirmed to be signed by that certificate ([threat model](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#threat-model)).
- **Signed releases and rebuildable APKs.** Each release carries a list of its files' checksums, signed with Trikey's publisher key outside GitHub. The Android APKs can be rebuilt from source and compared ([verify a release](https://github.com/TheIcarusWings/trikey/blob/main/packaging/VERIFY.md)).
- **The app's own update check** shows the release certificate built into the app, and warns when an APK would install as a different app, which Android can't catch on its own ([threat model](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#threat-model)).
- **One phished phone isn't everything.** A fake app that steals the phone key gets one key of three. [Single-sig or multisig](/blog/single-sig-vs-multisig) explains why that matters.

**Status:** Trikey is pre-alpha and has **not been audited**. Try it on test networks (signet, testnet4 or regtest); if you use mainnet anyway, use only an amount you can afford to lose. The [testers guide](https://github.com/TheIcarusWings/trikey/blob/main/docs/testers.md) explains how.

## FAQ

### Is an app safe just because it's on Google Play?

No. Store review lowers the risk, but fake wallet apps have repeatedly made it onto official stores. Check the developer and, for open-source wallets, the signing certificate.

### What is an APK signing certificate?

The public half of the developer's signing key, stored inside the app. Its SHA-256 fingerprint identifies who signed the app. A modified or fake app has a different one.

### Can someone fake the signing certificate?

Not without the developer's private key. They can copy the app's name, icon and package name, but if they re-sign it, the fingerprint changes.

### I already have the app installed. Is it real?

Check it with AppVerifier against the developer's published fingerprint. If the first install was genuine, Android only accepts updates signed with the same key.

### Does this apply to iPhone?

iPhone apps are signed too, but iOS doesn't let you inspect the certificate the same way. Install only from links on the developer's own site, check the developer name on the App Store listing, and be wary of any app asking for your seed.
