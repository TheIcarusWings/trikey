---
title: "A Bitcoin Co-Signer on Your Home Server: What It Protects"
description: "What running a bitcoin node and a co-signing key on Umbrel, Start9 or Docker protects against, what it does not, and how to run one safely at home."
date: 2026-11-10
slug: self-hosted-bitcoin-cosigner-umbrel-start9
keywords: [self-hosted bitcoin cosigner, Umbrel bitcoin wallet, Start9 bitcoin, run your own bitcoin node, Electrum server privacy]
draft: true
queue: 4
---
Home servers such as Umbrel and Start9 made it easy to run a Bitcoin node in a box on a shelf. Most people use one to check their own transactions and keep their addresses private. A newer idea goes one step further: let the box hold one key of a [2-of-3 multisig](/blog/2-of-3-multisig-explained) wallet and co-sign payments under rules you set, the way a company's server does in collaborative custody. This article explains what a home node protects, what a home co-signer adds, what neither protects against, and how to run one without creating new risks.

## What your own node already gives you

### You check the chain yourself

A wallet has to learn which coins you own and whether a payment confirmed. Without a node, it asks someone else's server, and trusts the answer. With your own node, your wallet asks software you run, which has checked every block itself.

### Your addresses stay private

Most mobile and desktop wallets look up addresses through an **Electrum server**. A public one learns every address you ask about, and usually your IP address too, so it can link your whole wallet together. Umbrel and Start9 offer Electrum server apps (such as Electrs or Fulcrum) that run next to Bitcoin Core, so your wallet can ask your own box instead.

### You broadcast your own transactions

Sending through your own node means no third party sees a payment before the network does.

What a node does **not** do on its own: hold keys or enforce any rule about spending. That is the co-signer's job.

## What a co-signer on the box adds

A co-signer is a key that signs only when a request meets its rules. Companies run them for collaborative custody (see [collaborative custody compared](/blog/collaborative-custody-compared)). Running one at home gives you the same kinds of rules without a company holding a key:

- **A spending limit.** Your phone plus the co-signer can pay up to a daily amount. Above it, the hardware wallet must sign. A stolen phone is worth at most the limit.
- **A waiting period for recovery.** If you lose a key, the co-signer helps you recover, but only after a delay with alerts (see [Delay & Notify](/blog/delay-and-notify-time-locked-recovery)).
- **Rules that only a stronger key can loosen.** Raising the limit or shortening the delay needs the hardware wallet, not just the phone.
- **Alerts** to you and people you trust when something unusual happens.

A few open-source projects explore self-hosted co-signers with policies, such as Ledger's [resigner](https://github.com/LedgerHQ/resigner) and Coinkite's [CKBunker](https://github.com/Coldcard/ckbunker); check each project's repository for its status and intended use.

## What it does not protect against

Being honest about the limits is the most useful part of this article.

### A compromised box is one key of three

If someone takes over your home server remotely, they hold the co-signer's key. In a 2-of-3 wallet that is one key: not enough to spend. It is the same exposure as a company's co-signing server being breached. But it means the co-signer must never be your only line of defence: someone holding the box *and* one of your other keys holds two keys.

### Burglary

A burglar who takes your phone and your home server has two of your three devices. If they keep the box running and its rules hold, that buys them the daily limit, and any recovery they start sets off the alerts. If they unplug it, a good design makes the server lock itself on restart (a key encrypted on disk is useless without its passphrase), so the box is worthless. Either way, keep your hardware wallet's seed words **outside your home**: the hardware wallet plus the phone would be a pair with no limit.

### Downtime

Power cuts, internet outages, a failed disk or an update gone wrong all stop the co-signer. A design worth trusting keeps your money reachable without it: in a 2-of-3, your phone and hardware wallet are still a spending pair.

### Other apps on the same box

App platforms run many containers side by side. Treat every other app as a neighbour that might be compromised: the co-signer should not trust requests just because they come from the local network, and its web page should sit behind the platform's login.

### Backups that copy the key

Automatic backups of a server can quietly create extra copies of the co-signer's key, and restoring an old copy can roll back its records (for example, how much of today's limit was used). For a key that is one of three, "no backup, replace it if lost" is often the safer rule: the other two keys move the coins to a new wallet with a new co-signer.

## Running one safely

- **Open no ports.** Port forwarding exposes the box to the whole internet. Prefer designs that only connect outwards (through relays or Tor) and reach the box's web page through the platform's own login, a VPN such as Tailscale, or an HTTPS proxy.
- **Use a strong, unique passphrase** for the co-signer's key, and know where it is written.
- **Keep the node's own wallet empty.** Apps on the box often get broad access to Bitcoin Core's RPC. If the node holds a wallet with funds, an app that is taken over could use it. Where you can, give each app a restricted RPC user with Bitcoin Core's [`rpcauth`](https://github.com/bitcoin/bitcoin/tree/master/share/rpcauth) and `rpcwhitelist` settings.
- **Send alerts somewhere a phone thief cannot reach:** a second device, a family member, an email account.
- **Plan for the box dying.** Write down how you would move the coins with your other two keys, and try it once on a test network.
- **Keep it physically modest.** A small box on a shelf, on a UPS if power is unreliable, not advertised to visitors.

## How Trikey approaches it

[Trikey](/)'s key 3 is the **Trikey Guardian**, an app for your own home server: an Umbrel (through a community app store), a Start9 (a package you build yourself for now), or any Mac, PC, Linux machine or NAS with Docker. From the design document's [components](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#components) and [threat model](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#threat-model):

- **It reads the chain from your own node** by default (the box's Electrs on Umbrel and Start9), or from Bitcoin Core alone. A public Electrum server is possible for people without a node, behind a warning: it would see the wallet's addresses and could hide coins, but never spend or change a rule.
- **It opens no port at home.** The phone and the guardian talk through nostr relays, both connecting outwards, with messages end-to-end encrypted ([NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md)) inside gift wraps ([NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md)). Relays see ciphertext and metadata; they can drop a message, not read or forge one.
- **Key 3 lives in memory only while unlocked.** On disk it is encrypted under your passphrase (Argon2id). After any restart the guardian is locked until you unlock it with the passphrase, or, if you turn it on, with a confirmation on your hardware wallet.
- **The platforms' backups leave the guardian out**, on purpose, for the reasons above. If the box dies, your phone and hardware wallet move the coins to a new wallet with a fresh guardian ("Replace guardian").
- **A one-time setup code** protects the first run, so another app on the box cannot set up the guardian before you do.
- **Its rules:** phone payments within a rolling 24-hour limit, a 7, 14 or 30-day Delay & Notify recovery, and any loosening only with a hardware wallet approval.
- **Alerts go beyond nostr** if you want: email through your own account, ntfy, a webhook or Telegram, and they still go out while the guardian is locked.

The design is explicit about the limit: a remote compromise of the home server gives up one key of three, and phone-only payments wait while the guardian is offline.

**Status:** Trikey is pre-alpha and has **not been audited**. Use it on test networks (signet, testnet4 or regtest); if you try mainnet, use only an amount you can afford to lose. The [testers guide](https://github.com/TheIcarusWings/trikey/blob/main/docs/testers.md) shows how to install the guardian on Umbrel or Docker with a signet node, and the site has [setup videos](/#watch).

## FAQ

### Do I need my own node to use a hardware wallet?

No. But without one, your wallet trusts someone else's server for your balance and history, and that server learns your addresses.

### Is it safe to keep a bitcoin key on an Umbrel or Start9?

As one key of a 2-of-3, with a passphrase-encrypted key, no open ports and the other keys elsewhere, it is a reasonable design. As your only key, or as two keys of three, it is not.

### What happens if my home server is hacked?

The attacker holds one key of three and cannot spend alone. Move the coins to a new wallet with your other two keys and set up a fresh co-signer.

### What if my internet or power goes down?

The co-signer stops answering. In a 2-of-3 your other two keys can still spend; the everyday shortcut waits until the box is back.

### Does a home co-signer need port forwarding?

It should not. Designs that connect outwards only, through relays or Tor, avoid exposing your home network.
