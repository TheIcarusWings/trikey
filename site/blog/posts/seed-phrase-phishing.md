---
title: "Seed Phrase Phishing: The Scripts Scammers Use"
description: "The seed phrase phishing scams that work: fake security letters, fake support, wallet validation sites and recovery services, how to spot them, and what to do."
date: 2026-11-26
slug: seed-phrase-phishing
keywords: [seed phrase phishing scam, seed phrase scam, crypto phishing, fake wallet support, recovery scam]
draft: false
---
Almost nobody loses bitcoin because someone cracked their seed phrase. People lose it because someone **asked** for the phrase, convincingly, at a moment when handing it over seemed reasonable. The asking follows a small number of scripts, used again and again with new logos and new excuses. Once you know the scripts, they're much easier to spot. This post walks through the common ones, the signs they share, and what to do if you've already typed your words somewhere.

## The one rule that defeats all of them

**No legitimate company, support team, app, website or person will ever need your seed phrase.** Not to fix a problem, not to verify your wallet, not to upgrade it, not to recover lost coins. The only place your seed phrase is ever typed is into your own wallet or device, when **you** decided to restore it, on a device you trust.

Every script below is an attempt to make you forget that rule for a few minutes. Wallet makers say the same in their own warnings: Ledger's standard line is that it will never call, message or ask for your 24-word recovery phrase, as [reported when fake Ledger letters circulated](https://www.theblock.co/post/352479/ledger-confirms-physical-scam-letters-requesting-seed-phrase) in 2025.

## Script 1: "A security update is required"

You receive an email, a text, an app notification or even a **paper letter** saying your wallet needs an urgent security update, a "verification" or a migration. It may use real logos, a real company address and a reference number. It tells you to scan a QR code or visit a page and enter your recovery phrase to complete the update.

This isn't hypothetical. In 2025, Ledger users reported receiving printed letters that asked them to scan a QR code and enter their 24 words for a "critical security update". Ledger confirmed it was a scam ([The Block](https://www.theblock.co/post/352479/ledger-confirms-physical-scam-letters-requesting-seed-phrase), checked November 2026).

**The tell:** a real firmware or app update never asks for your seed. It arrives through the device's own app, and the device itself shows what's being installed.

## Script 2: Fake support

You post a question on social media or a forum: "my transaction is stuck", "my balance shows zero". Within minutes, a helpful "support agent" replies or messages you. Sometimes they reach out first after seeing your complaint. They're polite and patient. Eventually they need you to "sync", "validate" or "restore" your wallet on a page they send, or to read them your words "so we can check".

A variation abuses real support systems. In 2025, attackers used Trezor's contact form to trigger genuine automated replies, then followed up with phishing emails that looked like part of a real support thread ([Cointelegraph](https://cointelegraph.com/news/trezor-phishing-emails-days-after-support-portal-breach), checked November 2026).

**The tell:** real support never contacts you first through direct messages, and never asks for your seed. If you need help, start from the company's official website, which you type in yourself, not from a link someone sent you.

## Script 3: "Validate your wallet" and fake airdrops

A website offers something: a free airdrop, a wallet "health check", unclaimed rewards, a tool to "fix" a stuck payment. To use it, you "connect your wallet" by typing your seed phrase into a box. The page may look exactly like a well-known wallet's site, often found through a search ad or a look-alike domain.

**The tell:** any web page that asks for your words is stealing them. Real web apps ask your wallet to sign something, and the wallet shows you what. They never ask for the phrase itself.

## Script 4: The fake app

You search an app store or the web for your wallet's app and install the first result. It looks right. When you open it, it asks you to "restore" your wallet with your seed phrase. The coins are gone within minutes.

**The tell:** you didn't need to restore anything, so why are you being asked? Install wallet apps only from links on the maker's own website, and check the developer's name in the store. Restoring a seed into a new app is something you choose to do, deliberately, not something an app prompts you into.

## Script 5: Recovery services

You've already been scammed, or you've lost access to a wallet. Now someone offers to help: a "blockchain investigator", a "recovery firm", even someone claiming to be from a law enforcement agency. For a fee, and often for your seed phrase or remote access to your computer, they promise to get the coins back.

This is one of the cruellest scripts, because it targets people who've just lost money. The FBI's 2025 Internet Crime Report counted more than 10,000 complaints about crypto recovery scams in the US alone, with losses around $1.4 billion. Scammers posed as law firms, government officials and even the FBI's own complaint center ([The Block's summary of the report](https://www.theblock.co/post/397134/fbi-says-crypto-related-fraud-losses-hit-record-11-4-billion-in-2025-with-seniors-bearing-the-brunt), checked November 2026).

**The tell:** nobody can reverse a bitcoin payment, and nobody needs your seed to "trace" coins. Real law enforcement does not charge you a fee to investigate.

## The signs they share

Whatever the story, phishing scripts tend to have the same features:

- **Urgency.** "Within 24 hours", "or your funds will be lost", "final notice".
- **Contact that came to you.** A message, a call, a letter, a reply to your post, rather than something you went looking for.
- **A link or QR code** that leads somewhere to type something.
- **A request for the words**, however it's worded: "recovery phrase", "backup", "secret phrase", "verify", "sync", "import".
- **Secrecy or flattery.** "Don't tell anyone", "you've been selected", "you're one of our priority customers".

If you see one of these signs, slow down. If you see the last-but-one, stop: that's the whole scam.

## If you've already entered your seed somewhere

Act as if the attacker has the wallet right now, because they may be draining it while you read this.

1. **Set up a new wallet with a new seed,** on a device you trust, and write the new words down offline.
2. **Move everything that's left** from the old wallet to the new one, immediately. Speed matters more than fees.
3. **Never reuse the old seed**, or any passphrase you used with it.
4. **Report it**: to the platform where the scam reached you, to the wallet maker, and to your country's fraud reporting service. It rarely brings coins back, but it helps others.
5. **Expect a follow-up "recovery" offer.** Scammers share lists of victims. Anyone who contacts you offering to get the coins back is script 5.

## Habits that make phishing much less likely to work

- **Go to wallet websites by typing the address or using a bookmark,** never through ads or links in messages.
- **Treat every unexpected contact about your wallet as fake** until you've checked it through the official site.
- **Keep the seed offline,** on paper or metal, so there's no copy on a phone or computer that you could paste into a page.
- **Tell your family the rule**, especially older relatives. Scammers target them deliberately.
- **Consider a setup where one seed isn't enough.** [Single-sig or multisig](/blog/single-sig-vs-multisig) explains how a multisig wallet makes one leaked seed survivable, and [address poisoning and clipboard malware](/blog/address-poisoning-clipboard-malware-daily-limit) covers the related tricks that target the address you pay rather than your seed.

## How Trikey is designed around phishing

[Trikey](/) is an open-source 2-of-3 wallet in which you hold all three keys: a hardware wallet, your phone, and either the Trikey Guardian on your own home server or a printed Recovery Key.

- **One phished seed doesn't empty the wallet.** Any payment needs two of the three keys, so a scammer who tricks you out of one seed still can't spend, and you can move everything to a new wallet with your own keys ([design decisions](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#decisions-so-far)).
- **Alerts never carry a link.** Trikey's alerts, by nostr message, email, ntfy, Telegram or webhook, never include a link or a button and never ask anyone to sign in. The guardian breaks up anything link-like before it sends a message, so a message with a link is not from it ([threat model](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#threat-model)).
- **No company to impersonate.** No Trikey company runs a server or holds a key for anyone, so there's no "Trikey support" that could ever need your words.

**Status:** Trikey is pre-alpha and has **not been audited**. Try it on test networks (signet, testnet4 or regtest); if you use mainnet anyway, use only an amount you can afford to lose. The [testers guide](https://github.com/TheIcarusWings/trikey/blob/main/docs/testers.md) explains how.

## FAQ

### Is it ever safe to type my seed phrase on a computer?

Only to restore into wallet software you deliberately installed from the maker's own site, on a computer you trust. Even then, a hardware wallet that takes the words on its own screen is safer. Never into a web page.

### Can someone steal my bitcoin with just my wallet address?

No. An address is public and only receives. Scammers who know it may use it to target you, though, so keep it as private as you reasonably can.

### The message came from the real company's email address. Is it real?

Not necessarily. Sender addresses can be faked, and real company systems can be abused to send messages. Judge the request, not the sender: if it asks for your seed, it's a scam.

### What if someone calls and says my wallet is compromised?

Hang up. If you're worried, check the device and the company's official website yourself. A real company will never ask you to read your words aloud.

### Can a recovery service get my stolen bitcoin back?

Almost never, and those that ask for an upfront fee or your seed are scams. Report the theft to your country's police or fraud reporting service instead.
