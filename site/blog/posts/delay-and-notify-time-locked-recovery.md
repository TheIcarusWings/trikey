---
title: "Delay & Notify: Why Bitcoin Recovery Should Wait"
description: "Why a waiting period with alerts is the safest way to recover a bitcoin wallet with one key, and how cosigner delays compare with on-chain timelocks."
date: 2026-11-10
slug: delay-and-notify-time-locked-recovery
keywords: [delay and notify, time-locked recovery, bitcoin timelock recovery, recovery waiting period, bitcoin vault timelock]
draft: false
---
Any wallet that lets you recover with fewer keys than usual has a problem: whatever lets *you* in after a loss would also let a thief in. A waiting period solves this in a simple way. The recovery is allowed, but it takes days, and everyone who should know is told every day. The real owner, who lost a key, can afford to wait. A thief cannot wait unnoticed. This article explains why that works, the two ways a waiting period can be enforced (by a cosigner, or by Bitcoin's own timelocks), and how to choose its length.

## The recovery dilemma

In a [2-of-3 multisig](/blog/2-of-3-multisig-explained) wallet, two keys spend. If you lose one key, the other two are enough. But some setups want more than that: a way to recover when only *one* of your own keys survives, with help from a third party or a server that holds the third key.

That help is dangerous if it is instant. Whoever steals your one remaining key, or tricks the helper, would get the same instant recovery. Asking security questions or sending an email code does not settle who is the owner; both can be phished or guessed.

Time can. A legitimate recovery is rarely urgent by the hour. A theft almost always is: the attacker wants the coins before you notice. So a recovery that waits, and announces itself loudly while it waits, turns the attacker's need for speed against them.

## What "Delay & Notify" means

The name comes from [Bitkey](https://bitkey.world/blog/sharing-our-recovery-design), which uses it for recovering a lost key. The pattern has three parts:

1. **Delay.** A recovery started with one key does not complete until a fixed period has passed. Bitkey's support pages describe a seven-day delay.
2. **Notify.** During the delay, the owner is alerted, ideally on several channels and devices, including ones the attacker does not hold.
3. **Cancel.** Anyone legitimately alerted can stop the recovery before it completes.

At the end of the delay, the funds move to a new wallet with a replacement key. They do not simply unlock.

## Two ways to enforce a waiting period

### A cosigner that follows rules

One of the keys is held by a cosigner (a company's server, or a server you run) that signs a recovery only after the delay has passed and nobody cancelled. This is how Bitkey's Delay + Notify works, with Block's server holding one of the three keys.

Strengths: the delay can be cancelled, alerts are built in, rules can be changed later, and it works with any hardware wallet because the Bitcoin script is an ordinary multisig.

Limits: the delay is enforced by software, not by Bitcoin. If the cosigner is compromised **and** an attacker holds one of your keys, they have two keys and can skip the delay. The cosigner also has to be online and honest about time, so a good design checks the clock against the blockchain rather than trusting the server's clock alone.

### Timelocks in the Bitcoin script

Bitcoin can enforce time itself:

- **Absolute timelocks** make a transaction or a script path valid only after a given block height or date ([BIP 65](https://github.com/bitcoin/bips/blob/master/bip-0065.mediawiki), `OP_CHECKLOCKTIMEVERIFY`).
- **Relative timelocks** make a path valid only after a coin has been confirmed for a given number of blocks or amount of time ([BIP 68](https://github.com/bitcoin/bips/blob/master/bip-0068.mediawiki) and [BIP 112](https://github.com/bitcoin/bips/blob/master/bip-0112.mediawiki), `OP_CHECKSEQUENCEVERIFY`).

Wallets built on [miniscript](https://bitcoin.sipa.be/miniscript/), such as Liana, use these to add a **recovery path**: your normal keys spend at any time, and a recovery key (or an heir's key) can spend only after the coins have sat unmoved for, say, a year.

Strengths: no server is needed, and nobody can shorten the wait, not even with every server compromised.

Limits: a relative timelock counts from when each coin was confirmed, so you must move ("refresh") your coins before the timer runs out, or the recovery path becomes spendable. There is no cancel button: you "cancel" by spending the coins to a new address. Alerts are not built in; someone has to watch the chain. And fewer hardware wallets can sign these scripts than plain multisig.

### Covenants: not available yet

Covenant proposals would let coins themselves enforce "wait, and allow a cancel to a safe address" on-chain. The best known, `OP_VAULT` ([BIP 345](https://github.com/bitcoin/bips/blob/master/bip-0345.mediawiki)), is marked Closed in the BIP repository. Any such proposal would need a soft fork, and **none is active on Bitcoin**, so no wallet can use one today.

### Side by side

| | Cosigner-enforced delay | Script timelock (miniscript) |
|---|---|---|
| Who enforces the wait | The cosigner's software | Every Bitcoin node |
| Can a recovery be cancelled? | Yes, by anyone alerted | Only by moving the coins first |
| Alerts | Built in | Need a separate watcher |
| Coins need refreshing | No | Yes, before each timelock expires |
| Hardware wallet support | Any device that signs multisig | Fewer devices |
| Bypassed by | Cosigner compromise plus one stolen key | Theft of the keys in the normal spending path |

Neither is strictly better. A cosigner delay is flexible and loud; a script timelock is strict and quiet.

## Choosing the length

- **Longer** gives you time to notice while travelling, ill or offline, and gives your contacts time to reach you.
- **Shorter** gets you back to your money sooner after a genuine loss.

A week is a common floor. Thirty days suits people who are often out of reach. Whatever you choose, the wait only protects you if the alerts reach someone: send them to more than one device and at least one person you trust, through channels a phone thief does not control.

## Two failure modes worth knowing

**Phishing that imitates an alert.** A fake "recovery started, click here to cancel" message is an obvious attack. Real alerts should never need you to click a link or sign in. If a wallet's alerts never contain links, any message with one is fake.

**Contested recovery.** If a thief holds one of your keys and you hold another, each can cancel the other's recovery. The result is a stalemate: the funds are frozen, not stolen. That is the price of letting any key holder cancel. You get out by finding a second key (a backup) or by outlasting the thief.

## How Trikey approaches it

[Trikey](/) uses a cosigner-enforced Delay & Notify, with one difference from Bitkey: the cosigner, the Trikey Guardian, runs on your own home server, so no company holds a key or decides on a recovery. From the design document's [rules the guardian enforces](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#rules-the-guardian-enforces):

- **You pick the delay:** 7, 14 or 30 days.
- **Starting a recovery pauses phone-only payments**, so a phone thief who starts one gains nothing in the meantime.
- **Alerts go out every day** as end-to-end encrypted nostr messages to your devices and your alert contacts, and optionally by email, ntfy, a webhook or Telegram. On mainnet the guardian requires at least one alert contact.
- **Any of them can cancel.** A cancel from someone other than the person who started the recovery keeps phone payments paused until the hardware wallet resumes them.
- **Three clocks must agree** before the guardian co-signs: the system clock, the blockchain's median time past, and the number of blocks mined since the start. A tampered clock cannot shorten the wait.
- **Alerts never carry a link or a button** and never ask anyone to sign in.
- **A fee cap** stops a recovery from burning the funds in fees, and the funds move to a new 2-of-3 wallet.

The honest limit is the one above: if someone took over your home server *and* held one of your other keys, they would hold two keys of three. The [threat model](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#threat-model) goes through this and the other cases, including the contested stalemate.

Trikey also uses Bitcoin's own timelocks, in its **Recovery Key mode** for people without a home server: the phone's small spending balance is refilled by a chain of pre-signed refills, each of which can confirm only 1,008 blocks (about a week) after the one before it (a BIP 68 relative timelock), so even a phone thief holding every refill gets at most one per period. Recovery in that mode needs any two keys and has no waiting period. Recovery Key mode is for test networks only.

**Status:** Trikey is pre-alpha and has **not been audited**. Use it on test networks (signet, testnet4 or regtest); if you try mainnet, use only an amount you can afford to lose. The [testers guide](https://github.com/TheIcarusWings/trikey/blob/main/docs/testers.md) suggests starting a recovery as if you had lost your phone and letting it run in the background.

## FAQ

### Why can't recovery be instant if I can prove who I am?

Because anything that proves your identity online (an email, a code, an answer to a question) can be stolen or faked. Time and alerts to several people are much harder to fake.

### What happens if I miss the alerts?

The recovery completes at the end of the delay. That is why alerts should reach more than one device and at least one other person, and why a longer delay suits people who are often offline.

### Can a thief cancel my genuine recovery?

If they hold one of your keys, yes, and you can cancel theirs. Neither side can take the funds; they stay frozen until one side gives up or you restore a second key.

### Do timelocks work on any hardware wallet?

Plain multisig works almost everywhere. Script paths with timelocks need devices that can sign those scripts, which is a shorter list. Check before you commit to a design. See [choosing a hardware wallet for multisig](/blog/hardware-wallet-for-multisig).
