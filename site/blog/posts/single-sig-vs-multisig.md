---
title: "Single-Sig or Multisig: When Is One Key Enough?"
description: "Singlesig vs multisig for bitcoin: what one key protects and what it doesn't, the questions that decide when a second and third key are worth it, and the costs."
date: 2026-11-11
slug: single-sig-vs-multisig
keywords: [singlesig vs multisig, single-sig vs multisig, is multisig worth it, bitcoin self-custody, 2-of-3 multisig]
draft: true
queue: 8
---
Most people who hold their own bitcoin start with one key: a hardware wallet or a phone app with a 12- or 24-word seed phrase. Sooner or later they read that "serious" holders use multisig, and wonder whether they should switch. This post answers that question without assuming the answer. One key is enough for many people and many amounts. The goal is to show where the line is, so you can tell which side of it you are on.

## What one key means

A **single-sig** wallet ("single signature") can spend with one signature from one key. In practice that key comes from a seed phrase, usually in the [BIP 39](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki) format, and most modern wallets derive native segwit addresses from it along the [BIP 84](https://github.com/bitcoin/bips/blob/master/bip-0084.mediawiki) path. Whoever holds the seed holds the money.

A **multisig** wallet needs several signatures from a set of keys, for example any 2 of 3. Each key lives on its own device or in its own place, and Bitcoin itself checks that enough of them signed. If you want the mechanics first, [2-of-3 multisig explained](/blog/2-of-3-multisig-explained) walks through them.

The difference that matters for the rest of this post: in single-sig, **one secret decides everything**. In multisig, no single secret does.

## What a single key protects well

A single-sig wallet on a good hardware wallet, with a seed backup written down and kept safe, already handles the most common threats:

- **Malware on your computer.** The key stays on the device, and the device shows the address and amount before you approve.
- **An exchange failing.** Coins in your own wallet don't depend on anyone's solvency.
- **A lost device.** Buy a new one, enter the seed, and the coins are back.
- **Simplicity.** One backup, one device, and any standard wallet can restore it. Simplicity is a real security property: the setup you understand is the one you'll restore correctly in five years.

It also costs the least to use. A native segwit single-sig input is about 68 virtual bytes, against about 105 for a 2-of-3 P2WSH input, according to Bitcoin Optech's [transaction size calculator](https://bitcoinops.org/en/tools/calc-size/) (checked November 2026). Every payment you make from a coin pays for that difference in fees.

## Where one key falls short

The weakness of single-sig is not that the key is weak. It is that everything rests on it, in two opposite directions.

**It can be lost.** If the device breaks and the seed backup is gone (a fire, a flood, a sheet thrown away by someone who didn't know what it was), the coins are gone. No one can reset it.

**It can be found.** Anyone who sees the seed phrase, photographs it, or tricks you into typing it somewhere can take everything, at once and for good. There is no waiting period and no second approval. The same is true of someone who holds your unlocked device and your PIN.

Notice the tension. The usual fix for "it can be lost" is more copies of the seed. The usual fix for "it can be found" is fewer copies, better hidden. A single key forces you to trade one risk against the other, and every copy you add for safety is one more place a thief can look.

A [BIP 39 passphrase](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki#from-mnemonic-to-seed) (sometimes called a "25th word") splits the secret into two items, so a found seed alone is not enough. It helps, but whoever learns both still holds a complete key, and losing the passphrase loses the coins just as surely as losing the seed.

## What multisig changes

A 2-of-3 wallet resolves that tension rather than trading inside it. You can lose any one key and still spend with the other two. Someone can find any one key and still not be able to spend. Both statements hold at the same time, which no single key can offer.

It also changes the shape of an attack. A thief now needs two things from two places. A mistake, like leaving one backup in a hotel safe, is survivable instead of final.

But multisig is not "single-sig, only safer". It moves risk around:

- **More to back up.** Besides each key's seed, you need the wallet's **descriptor**: the record of all the public keys and the script. Without it, the seeds you hold may not find the coins.
- **More steps to restore.** Restoring takes two keys and the descriptor, in wallet software that supports multisig. People who never rehearse it can get stuck.
- **More ways to undo the benefit.** Two keys kept in one drawer are one point of failure again, with more complexity on top.
- **Higher fees**, as above, and a spend that reveals a multisig script on-chain.

So the honest question is not "is multisig better?" It is "would losing or leaking my one key hurt more than the cost of running three?"

## Five questions that decide it

Answer these for the amount you are thinking about, not for your whole net worth.

### 1. Would losing this amount change your life?

If losing it would hurt but not change how you live, a well-backed-up single key is a reasonable place for it. If it would change your plans, your housing or your retirement, the case for removing the single point of failure is strong.

### 2. Who else knows, or could find out?

Single-sig is safest when nobody knows you hold bitcoin and nobody shares your home with your backup. Housemates, a public profile, renovations, or a past exchange account in your name all raise the chance that one secret is seen. Multisig makes one seen secret harmless.

### 3. Can you keep three things in three places?

Multisig only pays off if the keys really are apart: one at home, one in another building, one on a device that travels with you, or similar. If you cannot think of three sensible places, you will likely end up with two keys together, and you are better off with one key done well.

### 4. Will you rehearse a recovery?

Any setup you have never restored is a guess. Single-sig rehearsal is quick: wipe a spare device, enter the seed, and check the first address. Multisig rehearsal takes an afternoon. If you won't do it, keep the setup simple enough that you'd manage without practice.

### 5. Does someone else need to get in one day?

Heirs and family are where single-sig is weakest. Handing someone a seed phrase today gives them full control today. Multisig lets a family member, a lawyer's safe or a second location hold a key that can't spend alone, and, together with the descriptor, lets the right two keys open the wallet later. [Bitcoin inheritance without a company](/blog/bitcoin-inheritance-without-a-company) covers that plan.

If most of your answers point to "small, private, simple", one key is enough. If most point to "large, known, shared", multisig is worth its costs.

## Many people end up with both

The choice doesn't have to be all or nothing. A common pattern is a **spending wallet** with one key, holding what you'd carry in a physical wallet, and a **vault** behind several keys, holding the rest. The spending wallet stays fast and cheap. A thief who gets into your phone gets that much and no more, and the vault stays untouched. Refill the spending wallet from the vault now and then, when you can check the amount on a hardware wallet's screen.

Whatever you choose, the basics apply to both:

- write the seed (and the descriptor, for multisig) on paper or metal, never in a photo, email or cloud note;
- never type a seed into a website, and never share it with anyone who asks, whatever they claim to be;
- check receive addresses on the device's screen before you share them;
- rehearse a restore with a small amount before you trust the setup with a large one.

## Where Trikey fits

[Trikey](/) is an open-source 2-of-3 wallet in which you hold all three keys: a hardware wallet, your phone, and either the Trikey Guardian on your own home server or a printed Recovery Key. The vault is a plain `wsh(sortedmulti(2,…))` descriptor on BIP 48 paths, the multisig script every major hardware wallet can co-sign, so any multisig-capable wallet can recover it with two keys ([design decisions](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#decisions-so-far)).

It is designed around the trade-off in this post: the convenience of one key for small, daily payments, and multisig for the rest.

- **With a home server**, the phone pays alone up to a daily limit you set, because the guardian co-signs those payments. Larger payments, and any loosening of the rules, need the hardware wallet ([rules the guardian enforces](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#rules-the-guardian-enforces)). Recovering from a lost phone waits out a delay with daily alerts, which [Delay & Notify](/blog/delay-and-notify-time-locked-recovery) explains.
- **Without a home server**, Recovery Key mode gives the phone a separate single-key spending balance, refilled from the 2-of-3 vault by a chain of payments the phone and hardware wallet pre-sign, at most one refill per period, enforced by Bitcoin's timelock rules ([Recovery Key mode](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#recovery-key-mode-no-home-server)). The spending balance is exactly the "one key is enough" pocket described above, and it restores in any BIP 84 wallet.

**Status:** Trikey is pre-alpha and has **not been audited**. Try it on test networks (signet, testnet4 or regtest); if you use mainnet anyway, use only an amount you can afford to lose. The [testers guide](https://github.com/TheIcarusWings/trikey/blob/main/docs/testers.md) explains how.

## FAQ

### Is a hardware wallet with one seed safe enough?

For many people and many amounts, yes, if the seed backup is written down, kept private and tested. Its limit is that one lost or seen backup decides the outcome. If that risk worries you more than added complexity does, consider multisig for the larger part.

### Is a passphrase as good as multisig?

They protect different things. A passphrase stops someone who finds only the seed, but it is one more secret to lose, and anyone with both items can spend. Multisig survives a lost key and a stolen key at once, at the cost of more backups and steps.

### Can I move from single-sig to multisig later?

Yes. You set up the multisig wallet, check its addresses on each device, and send your coins to it. That is an ordinary on-chain payment with an ordinary fee. Keep the old seed until the move has confirmed, then treat it as retired.

### Does multisig protect me if someone forces me to unlock my keys?

Not by itself: if someone can make you use two keys, they can spend. Spending limits and waiting periods do more here, because they cap what can leave at once and give time to react.

### What should I check when choosing devices for multisig?

That each device supports the script, lets you register the wallet, and shows the change and the address you're paying on its own screen. [Choosing a hardware wallet for multisig](/blog/hardware-wallet-for-multisig) covers the details.
