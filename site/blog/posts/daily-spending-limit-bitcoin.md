---
title: "Choosing a Daily Spending Limit for a Bitcoin Wallet"
description: "How to choose a daily spending limit for a bitcoin wallet: what a limit protects against, what it can't, and a simple way to pick a number you'll live with."
date: 2026-11-28
slug: daily-spending-limit-bitcoin
keywords: [daily spending limit bitcoin wallet, bitcoin spending limit, co-signer, stolen phone bitcoin, multisig daily limit]
draft: true
queue: 25
---
Bank cards have had daily limits for decades: a stolen card can empty the ATM only so far before the bank says no. Bitcoin itself has no such brake. A valid signature moves any amount, at once and for good. Some self-custody wallets add one back: a co-signer, usually a server or a device you run, that signs everyday payments only up to a limit you set. This post explains what such a limit does, what it can't do, and how to choose a number that protects you without getting in your way.

## How a spending limit works in bitcoin

Bitcoin has no account to put a limit on. A limit has to come from **who signs**. The usual design is a multisig wallet where:

- your phone holds one key;
- a **co-signer** holds another and signs a phone payment only if it keeps the day's total under the limit;
- a third key, typically a hardware wallet, can sign anything together with either of the others.

For a small payment, the phone and the co-signer sign, and you never touch the hardware wallet. For a large one, the co-signer refuses, and you approve it with the hardware wallet instead. A thief holding only your phone can take, at most, what the limit allows.

The limit lives in the co-signer's rules, not in the bitcoin network. That's why who runs the co-signer matters: a company's server, or one you run yourself.

## What a limit protects against

A daily limit turns several bad days into survivable ones.

- **A stolen, unlocked phone.** The most common way to lose a phone wallet. With a limit, the loss is capped at one day's allowance.
- **Malware or a swapped address.** If something tricks you into paying the wrong address from the phone, the damage is capped the same way. [Address poisoning and clipboard malware](/blog/address-poisoning-clipboard-malware-daily-limit) explains those tricks.
- **Pressure.** Someone forcing you to pay from your phone gets at most the limit from it, and the rest needs a device that isn't in your pocket. This doesn't make anyone safe from violence, but it caps what a phone can hand over on the spot.

## What a limit can't do

- **It doesn't stop the first loss.** Whatever the limit allows, a thief can take. A limit is a ceiling on loss, not a lock.
- **It doesn't help if the other keys are taken too.** Phone plus hardware wallet can always sign without the co-signer. Keep them apart.
- **It doesn't help once it's turned off.** Some wallets let you remove the limit. Then a phone alone can move everything again, as in a single-key wallet.
- **It depends on the co-signer behaving.** A co-signer that is down means phone payments wait. A co-signer that is compromised gives up one key, which is why it should never be enough on its own.

## How to pick a number

The right limit is a balance between two kinds of pain: the pain of losing that amount, and the pain of reaching for the hardware wallet. A few ways to find it:

### 1. Start from what you'd carry

Think of the physical wallet in your pocket. Most people carry an amount they'd be upset to lose but would recover from. A daily limit plays the same role. If losing it would change your plans, it's too high.

### 2. Look at what you actually spend

Look back over the last month or two of payments from the wallet. A limit a bit above your usual busiest day lets almost every payment go through without the hardware wallet. If you rarely pay from the wallet at all, a low limit costs you almost nothing.

### 3. Count the whole day, fee included

Limits usually count everything that leaves the wallet in a rolling day, the network fee included, and treat change returning to you as staying. A payment near the limit, on a day when fees are high, can tip over it.

### 4. Plan for the big day separately

Large payments (rent, a purchase, moving coins to savings) are exactly what the hardware wallet is for. Don't raise the limit for them. Approve them with the hardware wallet, or raise the limit for the day and lower it afterwards if your wallet allows that.

### 5. Prefer lowering to raising

A good design makes **lowering** the limit easy, from the phone alone, and **raising** it hard, needing the hardware wallet. That way a thief with only your phone can't raise it, and you can always tighten it quickly when something feels wrong.

## Common mistakes

- **Setting it once at the start and never again.** Your spending and your balance change. Revisit the limit when they do.
- **Turning the limit off "for convenience".** Then the phone is a single key again, and everything else in the setup protects less.
- **Keeping the hardware wallet next to the phone.** A burglar who finds both bypasses the limit entirely.
- **Forgetting the limit is per day, not per payment.** Several small payments add up.

## Where Trikey fits

[Trikey](/) is an open-source 2-of-3 wallet in which you hold all three keys: a hardware wallet, your phone, and the Trikey Guardian on your own home server. The guardian is the co-signer described above, and you run it yourself. Its rules follow Bitkey's published spend rules ([rules the guardian enforces](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#rules-the-guardian-enforces)).

- **What counts.** The guardian adds up what leaves the wallet (inputs minus change, the fee included) over a rolling 24 hours. A replayed transaction is never counted twice, and a "Speed up" of a payment it co-signed adds only the extra fee.
- **A suggested start.** Setup suggests 200,000 sats, with presets of 100,000, 200,000 and 500,000 ([open questions: defaults](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#open-questions)).
- **Tighten from the phone, loosen with the hardware wallet.** The phone alone can lower the limit at any time. Raising it, or turning it off, needs the hardware wallet, which shows the new value on its own screen before you approve.
- **Off means off, and is opt-in.** Turning the limit off is an explicit, hardware-approved choice. With it off, a stolen phone can send everything at once, and alerts arrive after the money has left ([threat model](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#threat-model)).
- **A lost phone isn't a lost vault.** Even with a phone stolen, the thief can reach only the limit, and a recovery they start waits out a delay with alerts ([Delay & Notify](/blog/delay-and-notify-time-locked-recovery)).

[Single-sig or multisig](/blog/single-sig-vs-multisig) covers when a setup like this is worth its extra keys.

**Status:** Trikey is pre-alpha and has **not been audited**. Try it on test networks (signet, testnet4 or regtest); if you use mainnet anyway, use only an amount you can afford to lose. The [testers guide](https://github.com/TheIcarusWings/trikey/blob/main/docs/testers.md) explains how.

## FAQ

### Can a bitcoin wallet really have a spending limit?

Not from the bitcoin network itself, which accepts any validly signed payment. A limit comes from a co-signer that refuses to sign above it, in a multisig where your other keys can still spend without it.

### What happens if I need to pay more than the limit?

You approve that payment with your hardware wallet instead of the co-signer. The limit only affects payments the phone and the co-signer sign together.

### Can a thief raise the limit?

In a well-designed wallet, not with the phone alone: raising it needs the hardware wallet. Check that your wallet works this way before relying on the limit.

### Does the limit reset at midnight?

Usually not. Many limits count a rolling 24 hours, so a large payment at 10 p.m. still counts until 10 p.m. the next day.

### Is a lower limit always safer?

It caps the loss lower, but if it's so low that you turn it off or keep the hardware wallet next to the phone to get around it, the setup ends up less safe. Choose a number you'll leave in place.
