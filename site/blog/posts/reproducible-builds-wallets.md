---
title: "Reproducible Builds: Checking the App Matches the Code"
description: "What a reproducible build is, why it matters for a bitcoin wallet, what it proves and doesn't, and how to check a release yourself or trust someone who did."
date: 2026-11-22
slug: reproducible-builds-wallets
keywords: [reproducible builds bitcoin wallet, reproducible builds, verify wallet app, open source wallet, supply chain security]
draft: true
queue: 20
---
"Open source" is one of the first things people look for in a bitcoin wallet. Anyone can read the code, so anyone can check it doesn't steal your coins. But you don't install the code. You install an app, a file someone built from the code on a computer you've never seen. How do you know the app was built from the code you can read, and not from a slightly different version that sends your seed somewhere? That's the question reproducible builds answer. This post explains what they are, what they prove and what they don't, and how you can use them, even without building anything yourself.

## The gap between code and app

Building an app turns source code (text people can read) into a binary (the file your phone or computer runs). Binaries are very hard to read. So the chain of trust has a weak link in the middle:

1. **The code** is public and can be reviewed.
2. **The build** happens on the developer's machine or a build server.
3. **The app** is what you download.

If step 2 is compromised, because the developer's machine has malware, the build server is hacked or a dependency is swapped, the app can differ from the code while the code still looks perfectly clean. Code review alone can't catch that.

## What "reproducible" means

The [Reproducible Builds project](https://reproducible-builds.org/docs/definition/) defines it this way: a build is reproducible if, given the same source code, build environment and build instructions, anyone can recreate bit-by-bit identical copies of the specified artifacts (checked November 2026).

In practice, you take the published source at the released version, follow the project's instructions, and get a file whose fingerprint (a SHA-256 hash) matches the one the developer published. If it matches, the app you downloaded was built from that code, byte for byte. If it doesn't, something is different, and the project should be able to explain why.

This is harder than it sounds. Builds tend to pick up timestamps, file orders, paths, machine names and tool versions, so two honest builds of the same code often differ. Projects that care about reproducibility pin every tool version, fix timestamps to the commit's date, and remove anything machine-specific.

## What it proves, and what it doesn't

**It proves** that the binary corresponds to a specific version of the source code. A compromised build server, or a developer who quietly ships something different, would be caught by anyone who rebuilds.

**It doesn't prove:**

- **That the code is safe.** A reproducible build of malicious code is reproducibly malicious. Someone still has to review the code.
- **That the build tools are honest.** If the compiler itself is compromised, every build reproduces the same compromise. Some projects go further: Bitcoin Core builds its releases with Guix, so that the toolchain itself can be audited and reproduced instead of trusted as a binary download ([Bitcoin Core's Guix README](https://github.com/bitcoin/bitcoin/blob/master/contrib/guix/README.md), checked November 2026).
- **That you got the published file.** You still need to check that what you installed is the release that was reproduced. For Android apps, that's the signing certificate. [Fake wallet apps](/blog/fake-wallet-apps-apk-signature) covers how to check it.

And one practical caveat: **signed mobile apps can't match byte for byte.** The developer's release signature is part of the file, and you don't have their key. So for Android, "reproducible" means every byte matches except the signature, and the published app's signature is valid and the developer's.

## How to use reproducible builds without building

Most people won't rebuild a wallet themselves, and that's fine. Reproducibility works because **anyone can** check, so a cheat risks being caught by whoever does.

- **Look for a published verification method.** A project that takes this seriously documents exactly how to rebuild and compare, including tool versions.
- **Look for independent checks.** [WalletScrutiny](https://walletscrutiny.com/) is an independent project that tries to rebuild wallet apps from source and publishes whether each one is reproducible.
- **Check the release is signed.** A signature from the developer's key, published outside the code host, shows a release came from them and not from a hijacked account or build pipeline.
- **Prefer wallets where the keys are on a hardware device,** especially for larger amounts. Then a bad phone app can propose a bad transaction, but the device shows you what you're signing.

## If you want to check one yourself

The general shape is the same for most projects:

1. **Get the exact source** of the release, usually by its git tag, and note the commit.
2. **Read the build recipe**, often a Dockerfile or a CI workflow, so you know what you're running.
3. **Build it** with the pinned tool versions the project documents. Containers make this much easier.
4. **Compare fingerprints:** hash your build and the published file, or compare file by file for signed apps.
5. **If they differ, ask.** A good project treats a mismatch as a bug and explains it.

Expect it to take from a few minutes to an hour or so, and a fair amount of disk space.

## How Trikey does it

[Trikey](/) is an open-source 2-of-3 wallet in which you hold all three keys: a hardware wallet, your phone, and either the Trikey Guardian on your own home server or a printed Recovery Key. Two of those keys are made by software Trikey ships, so its releases are built to be checked:

- **The guardian image is reproducible.** Building a release tag gives the same Docker image, byte for byte, as the one published. A release's image is only shipped once two more clean builds of the tag in CI gave exactly the same digest ([threat model](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#threat-model)). The steps to check it yourself take about fifteen minutes ([verify a release](https://github.com/TheIcarusWings/trikey/blob/main/packaging/VERIFY.md)).
- **The Android APKs can be rebuilt and compared,** from the first release after 0.1.27-alpha: every byte matches except the signature, and the published APK's signature is valid and the release key's ([verify a release](https://github.com/TheIcarusWings/trikey/blob/main/packaging/VERIFY.md#rebuild-the-android-apk)).
- **Releases are signed outside GitHub.** Each release has a list of its files' SHA-256, signed with Trikey's publisher key from the owner's own signer, and the release isn't published without it ([threat model](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#threat-model)).
- **And the hardware wallet is still the check of last resort.** Larger payments and any loosening of the rules need key 1, which shows what it signs on its own screen. [2-of-3 multisig explained](/blog/2-of-3-multisig-explained) covers why.

**Status:** Trikey is pre-alpha and has **not been audited**. Reproducible builds show the app matches the code, not that the code is right. Try it on test networks (signet, testnet4 or regtest); if you use mainnet anyway, use only an amount you can afford to lose. The [testers guide](https://github.com/TheIcarusWings/trikey/blob/main/docs/testers.md) explains how.

## FAQ

### Is an open-source wallet safe if its builds aren't reproducible?

Not necessarily unsafe, but you're trusting the developer's build machine as well as the code. Reproducible builds remove that extra trust.

### Does a reproducible build mean the wallet has been audited?

No. It means the app matches the code. An audit is a separate review of whether the code is correct and safe.

### Why can't my rebuild of an Android app match exactly?

Because the published app contains the developer's signature, made with a key only they hold. Comparisons skip the signature and check that it's valid.

### Do I need to rebuild every update?

No. The value comes from the fact that anyone can, and from independent projects that do it routinely. If you hold a lot, checking now and then, or following an independent verifier, is worthwhile.

### What about iPhone apps?

Apple re-signs and encrypts App Store apps, so comparing a rebuild to the store version is much harder. Building from source yourself, or using a hardware wallet for the keys that matter, are the practical options.
