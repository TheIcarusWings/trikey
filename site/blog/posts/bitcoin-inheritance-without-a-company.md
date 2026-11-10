---
title: "Bitcoin Inheritance Without a Company: A Practical Plan"
description: "How to pass on self-custodied bitcoin without a custodian: what heirs need, how multisig helps, the descriptor most plans forget, and mistakes to avoid."
date: 2026-11-10
slug: bitcoin-inheritance-without-a-company
keywords: [bitcoin inheritance, bitcoin inheritance without third party, multisig inheritance, bitcoin estate planning, multisig descriptor backup]
draft: false
---
If you hold your own bitcoin, nobody will hand it to your family when you die. There is no account to close and no bank to call. That is the point of self-custody, and it means the plan has to come from you. The good news is that a solid plan needs no company at all: it needs keys stored so that your heirs can gather enough of them and no thief can, the wallet's description written down, and plain instructions. This guide explains each part, how multisig makes it easier, and the mistakes that most often break a plan.

This is general information, not legal advice. Inheritance law differs by country; a lawyer can help with the legal side without ever touching your keys.

## What your heirs will need

A workable plan answers five questions for the people you leave behind:

1. **That the bitcoin exists.** Heirs cannot look for something they do not know about.
2. **Where enough keys are.** For a single-key wallet, the seed phrase (and passphrase, if any). For a multisig, enough keys to meet the threshold.
3. **What wallet it is.** For multisig, the descriptor: the public keys and how they combine. Without it, the keys may not find the coins.
4. **How to use it.** Step-by-step instructions written for someone who has never done this, naming software that can import the wallet.
5. **Whom to trust.** A person who can help, and a clear warning that anyone asking for seed words is a scammer.

## Why single-key inheritance is hard

With one seed phrase, the same piece of paper that lets your heirs in also lets anyone else in. You have two bad options: keep it hidden so well that it may never be found, or tell people where it is and trust everyone who might learn it, for years.

Two specific traps:

- **Never put seed words in a will.** In many jurisdictions a will becomes a public document once it goes through probate.
- **A passphrase helps security and hurts inheritance.** If the passphrase lives only in your head, the seed alone opens an empty wallet.

## How multisig changes the problem

A [2-of-3 multisig](/blog/2-of-3-multisig-explained) wallet splits the problem. No single location needs to be trusted, because one key alone moves nothing. A typical layout:

- **Key 1** at home, with you.
- **Key 2** with a trusted person, or in a safe deposit box.
- **Key 3** in a different place again: another relative, a second safe location, or a device you carry.

While you are alive, any one of those places can be burgled or lost without loss of funds. After your death, your heirs gather two of the three. The rule to keep: **no single place, and no single person, should ever hold two keys.**

### The descriptor: the part most plans forget

Each key backup should come with a copy of the wallet's **output descriptor**. It looks like `wsh(sortedmulti(2,[fingerprint/path]xpub…,…))` and lists all three public keys and the script type. It is standardised ([BIP 380](https://github.com/bitcoin/bips/blob/master/bip-0380.mediawiki), [BIP 383](https://github.com/bitcoin/bips/blob/master/bip-0383.mediawiki)) and wallets such as Bitcoin Core, Sparrow and Nunchuk can import it.

Why it matters: two seeds out of three are not enough to rebuild a 2-of-3 wallet, because the wallet also needs the third key's public key to compute the addresses. With the descriptor, two seeds are enough.

The descriptor cannot spend, so storing a copy with each key does not weaken security. It does reveal your balance and history to whoever reads it, which is a privacy cost worth accepting here.

## The letter of instruction

Write a letter that lives with your will or with a trusted person. It should say:

- what you hold, roughly, and that it is bitcoin in self-custody;
- where each key and each descriptor copy is, without the secrets themselves;
- which devices or software to use, and that any multisig wallet that imports a descriptor will do;
- who can help technically, and that they should never need to take the keys away;
- that no legitimate helper, company or "recovery service" will ever ask for seed words;
- that there is no rush: coins on the blockchain do not expire.

Keep secrets out of the letter: no seed words, no PINs, no passphrases. If PINs are needed (a hardware wallet wipes itself after too many wrong attempts), seed words restored on a new device avoid them; say where those seed words are instead.

## Timelocked heir keys: the alternative

Some wallets built on [miniscript](https://bitcoin.sipa.be/miniscript/) add an **heir path**: your normal keys spend any time, and an heir's key can spend only after the coins have not moved for a set period (using Bitcoin's relative timelocks, [BIP 112](https://github.com/bitcoin/bips/blob/master/bip-0112.mediawiki)). The heir never needs your keys.

The trade-off: the timer counts from when each coin was confirmed, so you must move ("refresh") your coins before it runs out, every time, for as long as you live. Fewer hardware wallets can sign these scripts than plain multisig. We compare the approaches in [Delay & Notify: why recovery should wait](/blog/delay-and-notify-time-locked-recovery).

## What companies offer, and what they change

Several collaborative custody companies (Casa, Unchained and Nunchuk among them) offer inheritance services that guide heirs through a process, usually with the company holding a key or playing a role in the recovery. That can be a good fit for families who want someone to call. It also makes the plan depend on the company still existing, and on its process, when the time comes. Check each provider's current documentation for exactly how theirs works. If you use one, keep your own copy of the descriptor so two of your own keys can always recover without it. We compare these models fairly in [collaborative custody compared](/blog/collaborative-custody-compared).

## Common mistakes

- **Two keys in one place.** A safe deposit box with two hardware wallets is a single point of failure, and a single target.
- **No descriptor copy.** The most common way a multisig plan fails.
- **Instructions only you understand.** Test them by asking someone non-technical to read them.
- **Never rehearsed.** Do a dry run with a small amount: restore two keys on spare devices, import the descriptor into another wallet, and spend.
- **Never updated.** Review once a year, and after you move house, change devices or change wallets.

## How Trikey approaches it

[Trikey](/) has **no dedicated inheritance feature today**. It is a 2-of-3 wallet where you hold all three keys (a hardware wallet, your phone, and the Trikey Guardian on your own home server), and several of its choices make the plan above easier:

- **A standard descriptor.** Every wallet is a plain `wsh(sortedmulti(2,…))` on BIP 48 paths, and the phone's backup holds it. Any multisig-capable wallet can recover the coins with two of your keys, without Trikey, so your heirs do not depend on the project still existing.
- **A pair that needs no server.** The phone key and the hardware wallet together can move any amount without the guardian. The phone key comes back from an encrypted backup file plus a recovery code written on paper, which the app tells you to keep apart: your letter should say where each is.
- **A printed recovery code** with no secret on it (the guardian's address and relays), meant to be kept with the hardware wallet.
- **Alert contacts.** If anyone starts a recovery, the people you chose are told every day and any of them can cancel it, which also protects a family during a confusing time.
- **A printed wallet map for the optional Savings wallet**, built so that "the owner or an heir can find and recover Savings with its keys alone, without Trikey" ([Savings](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#savings-optional)).

The design document lists an opt-in timelocked heir path for miniscript-capable devices as a possible extra; it is **not built**, and the default stays plain multisig so that every hardware wallet can sign. The reasons are in the [design decisions](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#decisions-so-far).

**Status:** Trikey is pre-alpha and has **not been audited**. Use it on test networks (signet, testnet4 or regtest); do not build an inheritance plan on it for real funds yet. The [testers guide](https://github.com/TheIcarusWings/trikey/blob/main/docs/testers.md) explains how to try it.

## FAQ

### Can I leave my seed phrase in my will?

You should not. In many places a will becomes public during probate, and many people handle it before your heirs do. Say in the will where to find instructions, not the secrets.

### What does an heir need to recover a 2-of-3 multisig?

Two of the three keys (seeds or working devices with their PINs) and the descriptor. With those, any multisig wallet that imports descriptors can move the coins.

### Should my lawyer hold a key?

A lawyer can hold one key of a multisig without being able to spend, which is safer than holding a seed. Make sure they understand what it is and never hold a second key.

### Is a company-assisted inheritance plan safer?

It is easier for some families and adds a party who can help. It also adds a party your plan depends on. Whichever you choose, keep your own descriptor so your keys alone can always recover.

### How often should I review the plan?

Once a year, and whenever you change devices, wallets or where keys are stored.
