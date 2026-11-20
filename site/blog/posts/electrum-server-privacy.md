---
title: "What Your Wallet Tells a Server, and Why Run Your Own"
description: "Electrum server privacy: what a wallet reveals to the server it asks about addresses, what that server can and can't do, and the options for running your own."
date: 2026-11-17
slug: electrum-server-privacy
keywords: [electrum server privacy, run your own electrum server, bitcoin wallet privacy, electrs, bitcoin node privacy]
draft: true
queue: 15
---
A bitcoin wallet app on your phone or computer doesn't download the whole blockchain. To show your balance, it asks a server: "has anything been paid to these addresses?" That's quick and convenient, and it means some server, usually run by someone you've never met, gets a complete list of your addresses. This post explains what a wallet reveals to the server it uses, what the server can and can't do with that, and how running your own fixes it.

## How a light wallet finds your coins

Most mobile and desktop wallets are **light wallets**. They hold your keys (or a hardware wallet does), derive your addresses, and then look those addresses up on a server that has indexed the whole blockchain.

The most widely used kind of server speaks the **Electrum protocol**, named after the wallet that introduced it. The wallet sends the server a fingerprint of each address it cares about. The [protocol's documentation](https://github.com/spesmilo/electrum-protocol/blob/master/docs/protocol-basics.rst#script-hashes) defines it as a hash of the address's script (checked November 2026), and the server answers with the matching transactions. It also tells the wallet when anything new arrives. Other servers, such as Esplora-based block explorer APIs, work the same way over plain web requests.

A hash sounds private, but it isn't here. The server indexes every script on the blockchain by that same hash, which is exactly how it can answer. To the server, a script hash is as good as the address itself.

## What the server learns

From those lookups, a server can learn:

- **Every address in your wallet,** including ones you haven't used yet, because wallets ask about a few addresses ahead.
- **That all those addresses belong together.** They arrive from one connection, in one session, so the server can link them into a single wallet, even if you've been careful never to reuse an address on-chain.
- **Your balance and full payment history.** Once it has the addresses, the blockchain tells it the rest.
- **Your IP address,** unless you connect through Tor or a VPN, and with it a rough location and your internet provider.
- **When you're active,** and which transaction you broadcast, since the wallet usually sends new payments through the same server.

Put together, that's a record saying a person at this IP address holds this much bitcoin and paid these addresses. Whether the operator is honest or not, that record can leak, be sold, or be handed over.

## What the server can't do

It's just as important to be clear about the limits. A server that only answers address lookups:

- **can't spend your coins.** It never sees a private key.
- **can't change a transaction you've signed.** Any change would invalidate the signature.

It can, however, **lie by omission**. It can leave out a payment you received, report a payment as unconfirmed, or refuse to broadcast your transaction. Wallets that check the server's answers against block headers catch some of this, but a server can still hide things it doesn't tell you about. So a public server is a privacy problem first, and a reliability problem second.

## Your options, from least to most private

### 1. A public server, through Tor

Using Tor hides your IP address from the server. It doesn't hide your addresses: the server still sees the whole wallet, just not where you are. It's an improvement, not a solution.

### 2. Several public servers

Some wallets connect to several servers and spread their questions out, so no single server sees everything. This helps against one curious operator, but not against one who runs several servers.

### 3. Compact block filters

A different design, described in [BIP 157](https://github.com/bitcoin/bips/blob/master/bip-0157.mediawiki) and [BIP 158](https://github.com/bitcoin/bips/blob/master/bip-0158.mediawiki), flips the question around. The wallet downloads a small filter for each block, checks locally whether the block might involve its addresses, and only then fetches whole blocks. The server never receives a list of your addresses. BIP 157 itself explains this as a privacy improvement over older approaches, in which clients revealed what they were looking for. The costs are more data and slower syncing, and fewer wallets support it.

### 4. Your own server

The complete answer is to ask your own server. Run a Bitcoin node, add an Electrum server on top of it, and point your wallets there. Then the only machine that learns your addresses is yours. Electrs, one popular Electrum server, gives exactly this as its reason to exist: the [project's README](https://github.com/romanz/electrs/blob/master/README.md) says a self-hosted server means the wallet doesn't have to talk to external servers, "thus preserving the privacy of the user's addresses and balances". Fulcrum is another common choice.

You don't need much to do it. Home server systems such as Umbrel and Start9 install a node and an Electrum server with a few clicks, and plain Linux or Docker works too. Expect the first sync of the blockchain to take a long time on modest hardware, and check your system's current disk requirements: the full chain is large. A pruned node saves space, but many Electrum servers need a full, unpruned one, so check yours.

## Connecting your wallets

Once your server is running:

- **Point every wallet at it,** including on your phone. Most wallets have a server setting that takes an address and port. Leaving one wallet on a public server undoes much of the benefit.
- **Reach it from outside your home over Tor or a VPN,** rather than opening a port to the internet.
- **Check the connection.** Many wallets show which server they're using, often with a green or red indicator. If the wallet falls back to a public server when yours is down, turn that fallback off.
- **Remember the server learns everything for you now.** Protect the box: if it's ever compromised, your addresses and balances are what's exposed. A hardware wallet still keeps the coins safe.

## How Trikey handles it

[Trikey](/) is an open-source 2-of-3 wallet in which you hold all three keys: a hardware wallet, your phone, and either the Trikey Guardian on your own home server or a printed Recovery Key.

- **With a home server,** the guardian reads the chain from the box's own node by default: the Electrs server that comes with Umbrel and Start9, or your own Bitcoin Core on its own. A public Electrum server is possible for people without a node, but only behind a warning, because it "sees the wallets' addresses and could hide coins (it cannot spend or change rules)". Every change of server is announced on every channel, and switching to a public server is blocked during a recovery ([design decisions](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#decisions-so-far), [Trikey Guardian](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#trikey-guardian-docker-container)).
- **In Recovery Key mode** (no home server), the phone reads the chain from a block explorer API. Today the defaults are public servers, and the design says plainly what that costs. A public server "learns every address of the vault and the spending balance and the phone's IP address", but "cannot move or freeze coins". The setting should point at your own server, and Umbrel and Start9 both run one ([Recovery Key mode](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#recovery-key-mode-no-home-server)).

[A bitcoin co-signer on your home server](/blog/self-hosted-bitcoin-cosigner-umbrel-start9) covers the rest of what a home server adds, and [2-of-3 multisig explained](/blog/2-of-3-multisig-explained) covers why a multisig wallet has even more addresses to protect.

**Status:** Trikey is pre-alpha and has **not been audited**. Try it on test networks (signet, testnet4 or regtest); if you use mainnet anyway, use only an amount you can afford to lose. The [testers guide](https://github.com/TheIcarusWings/trikey/blob/main/docs/testers.md) explains how.

## FAQ

### Can a public Electrum server steal my bitcoin?

No. It never sees your private keys and can't alter what you've signed. It can see your whole wallet, link it to your IP address, and hide or delay information.

### Does using Tor make a public server private?

It hides where you are, not what you own. The server still sees every address and can link them together.

### Do I need my own node if I use a hardware wallet?

The hardware wallet protects your keys, not your privacy. Its companion app still looks up your addresses somewhere. Point it at your own node to keep them private.

### Is a pruned node enough?

For a wallet inside the node itself, often yes. Many Electrum servers need the full, unpruned blockchain to build their index, so check your server's requirements.

### What about a block explorer website?

Pasting your address into a public explorer tells that site you're interested in it, along with your IP address. Use your own explorer (many home servers offer one), or Tor, when looking up your own addresses.
