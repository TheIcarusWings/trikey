---
title: "If Your Home Server Is Hacked, What Happens to Your Bitcoin?"
description: "What an attacker gets from a hacked Umbrel, Start9 or Docker home server: node, Lightning, wallets and co-signing keys, what stays safe, and what to do first."
date: 2026-11-16
slug: home-server-hacked-bitcoin
keywords: [home server hacked bitcoin, umbrel security, start9 security, bitcoin node security, lightning node hot wallet]
draft: true
queue: 14
---
A home server running a Bitcoin node is one of the best things you can do for privacy and independence. It is also a computer that's always on, connected to the internet, and usually running a dozen apps written by different people. So it's fair to ask: if someone breaks into it, what happens to your bitcoin? The answer depends entirely on **what keys live on that box**. This post walks through what a typical home server holds, what an attacker gets in each case, what stays safe, and what to do if you think yours has been compromised.

## What's on a typical bitcoin home server

Systems such as Umbrel and Start9, or a plain Linux machine with Docker, make it easy to install many things on one box. For bitcoin, the usual pieces are:

- **A Bitcoin node** (Bitcoin Core or similar). It checks the blockchain and relays your transactions. On its own it holds no keys, unless you created a wallet inside it.
- **An Electrum server** (such as Electrs or Fulcrum) and maybe a **block explorer**. These index the chain so your wallets can look up addresses privately. They hold no keys, but they see every address your wallets ask about.
- **Watch-only wallets** in coordinator software, or your hardware wallet's companion app pointed at the node. They hold your public keys (xpubs), so they can see balances and history but can't spend.
- **A Lightning node** (LND, Core Lightning and others). This one is different: it holds **spending keys** for the money in its channels, and they must be online for it to work.
- **Sometimes a co-signing key** for a multisig wallet: a key that lives on the box so it can sign automatically under rules you set.

Each piece fails differently when the box is compromised.

## What an attacker gets, piece by piece

### The node and the Electrum server: your privacy

A node with no wallet has nothing to steal, but the data around it is valuable. An attacker in control of your Electrum server or explorer can see which addresses your wallets look up, so they learn your balance and payment history, and they can tie them to your home IP address. They could also feed your wallets wrong information, such as hiding a payment that arrived. They **can't** move coins this way: a server that lies about the chain still can't produce your signatures.

That makes a privacy breach worth taking seriously. Knowing who holds how much is exactly what a targeted scam or a physical threat needs.

### Watch-only wallets: still privacy

An xpub or a wallet descriptor can't sign. Someone who copies one learns every address and balance of that wallet, past and future, and nothing more. Treat it as a privacy loss, not a theft.

### A wallet inside Bitcoin Core: possibly the money

If you ever created a spending wallet inside your node, its keys are in a file on the box. Bitcoin Core's own [wallet guide](https://github.com/bitcoin/bitcoin/blob/master/doc/managing-wallets.md) notes that the wallet file is **not encrypted by default** (checked November 2026). An attacker with access to the disk can take an unencrypted wallet outright. With encryption, they need the passphrase too, which they may capture if they can watch you type it.

### A Lightning node: the money in it

A Lightning node is a hot wallet by design: it signs channel updates continuously, so its keys are usable whenever it's running. Someone with control of the box, or with the node's API credentials, can generally send the node's funds away. LND's [safety guide](https://github.com/lightningnetwork/lnd/blob/master/docs/safety.md) describes its API tokens (macaroons) and notes that individual ones can't be revoked, only all at once. The practical rule: keep on a home Lightning node only what you'd keep in a phone wallet.

### A co-signing key: depends on the rules

A key on the box that co-signs with another key is the interesting case. In a 2-of-3 multisig, it is **one key of three**. Someone who steals it still needs a second key to move anything. What they can do depends on what else they have, and on what rules the co-signer enforced before signing. [A bitcoin co-signer on your home server](/blog/self-hosted-bitcoin-cosigner-umbrel-start9) covers the design in more detail.

## What stays safe

- **Coins controlled by your hardware wallet alone, or by a multisig where the box holds at most one key.** The keys that matter aren't on the server.
- **Your seed phrases**, as long as they were never typed into, photographed onto or stored on the server.
- **Payments you approved on a hardware wallet's screen**, as long as you checked the address there. A compromised server can lie to your computer; it can't change what the device shows.

## Remote hack, stolen box, rogue app: three different problems

- **Remote compromise** (an attacker gets in over the network, or through a vulnerable app): the attacker sees what's running, and possibly what's unlocked in memory. Hot keys (Lightning, an unlocked wallet, an unlocked co-signer) are the risk.
- **The box is stolen or seized:** the thief gets the disk. Anything encrypted with a strong passphrase that isn't stored on the box stays protected. Anything unencrypted doesn't.
- **A malicious or compromised app from an app store:** on most home server systems apps are separated from each other, but an app is still code you chose to run on your network. Install from sources you trust, and remove what you don't use.

## If you think your server was compromised

Act on what has keys first:

1. **Move Lightning funds and any node-wallet funds** to a wallet whose keys aren't on that box, from a device you trust. That might be closing channels, or paying out to your hardware wallet.
2. **If the box held a co-signing key**, use your other keys to move the multisig's coins to a new wallet with a fresh co-signer. Don't simply re-install the old key.
3. **Unplug it from the network**, then wipe and reinstall rather than trying to clean it. Restore only data you need, from backups you trust.
4. **Change every password and credential** that was stored on or typed into the box: dashboard passwords, app passwords, API tokens.
5. **Treat your addresses and balances as known** to the attacker. Be extra wary of messages that seem to know about your holdings: that knowledge is the basis of targeted scams.

What you should **not** do: type your seed phrase anywhere to "check" whether coins are safe, or follow instructions from anyone who contacts you offering to help recover them.

## Making the box a smaller target

- **Keep keys off it** unless they're there for a reason, and limited by rules when they are.
- **Install fewer apps.** Each one is code with access to your network.
- **Keep it updated**, and turn on any automatic updates the system offers.
- **Don't expose its dashboard to the internet.** Use your home network, Tor or a VPN the system provides.
- **Use a long, unique dashboard password,** and turn on two-factor login where the system offers it.
- **Back up what can't be rebuilt** (Lightning channel backups, a co-signer's recovery data), and store the backups as carefully as anything else with keys in it.

## How Trikey's guardian is designed for this

[Trikey](/) is an open-source 2-of-3 wallet in which you hold all three keys: a hardware wallet, your phone, and the **Trikey Guardian**, an app on your own Umbrel, Start9 or Docker machine. The design assumes the box can be compromised ([threat model](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#threat-model)):

- **The guardian is one key of three.** A remote compromise of the box gives up that key and nothing else. On its own it moves nothing ([design decisions](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#decisions-so-far)).
- **It only co-signs within rules your hardware wallet approved:** phone payments up to a daily limit you set, and recoveries only after a waiting period with daily alerts ([rules the guardian enforces](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#rules-the-guardian-enforces)). Loosening any rule needs the hardware wallet.
- **A stolen, unplugged box is locked.** The guardian's key is protected by a passphrase you choose and has to be unlocked again after a restart, so a burglar who takes the box without the passphrase holds one unusable key. If they keep it running and also have your phone, they can reach the daily limit, and any recovery they start sets off the alerts ([threat model](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#threat-model)).
- **If you suspect the box, replace the guardian.** Your phone and hardware wallet together move the coins to a new wallet with a new guardian key, without needing the old box ([recovery flows](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#recovery-flows)).

What a compromised guardian *can* do is lie or stay quiet: it can give the phone wrong information about the wallet, or fail to send an alert. That's why alerts also go to contacts you choose, and why the phone and hardware wallet can always move the coins without it.

**Status:** Trikey is pre-alpha and has **not been audited**. Try it on test networks (signet, testnet4 or regtest); if you use mainnet anyway, use only an amount you can afford to lose. The [testers guide](https://github.com/TheIcarusWings/trikey/blob/main/docs/testers.md) explains how.

## FAQ

### Can someone steal my bitcoin just by hacking my node?

Not if the node only verifies and relays, and your keys live on a hardware wallet. They learn your addresses and balances. A wallet inside the node, a Lightning node, or an unlocked co-signing key is different: those hold keys on the box.

### Is Lightning on a home server safe?

It's as safe as any hot wallet: convenient, but the keys are online. Keep a spending amount there, not savings.

### Should I keep my hardware wallet's xpub on my home server?

It's fine for privacy-conscious use, since the xpub can't spend. Just know that anyone who gets into the box can see that wallet's whole history.

### My server was stolen. Is my money gone?

Not if the keys that matter are elsewhere. Move anything that depended on a key from the box (Lightning, a node wallet, a co-signer) using your other keys, and treat your balances as known.

### Do I need a home server to use a multisig wallet?

No. Many multisig setups keep all keys on hardware wallets and use a desktop app as the coordinator. A home server adds privacy and, with a co-signer, convenience.
