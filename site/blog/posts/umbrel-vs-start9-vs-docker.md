---
title: "Umbrel, Start9 or Docker for a Bitcoin Home Server"
description: "Umbrel vs Start9 vs plain Docker for running a Bitcoin node at home: how they differ in setup, apps, openness, backups and upkeep, and how to choose."
date: 2026-11-25
slug: umbrel-vs-start9-vs-docker
keywords: [umbrel vs start9, bitcoin home server, run your own bitcoin node, start9, umbrel, docker bitcoin node]
draft: false
---
Running your own Bitcoin node used to mean a weekend with a terminal. Today you can buy or build a small computer, install a system made for it, and have a node, an Electrum server and a block explorer running from a web page. The two best-known systems are **Umbrel** and **Start9**. The third option is no special system at all: **plain Docker** on a computer you already have. This post compares the three for someone whose main goal is bitcoin self-custody, and helps you pick.

Product details change. The facts below about Umbrel and Start9 come from their own pages and source code as of November 2026; check their current pages before deciding.

## What each one is

**Umbrel** (umbrelOS) is an operating system for a home server, with a web dashboard and an app store. You can run it on your own hardware or buy the company's own box. Bitcoin was its starting point, and its app store now covers much more: media servers, file sync, home automation and so on. Apps install with a click and are listed at [apps.umbrel.com](https://apps.umbrel.com), and you can add community app stores alongside the official one.

**Start9** (StartOS) is also an operating system for a home server, with its own dashboard and a registry of service packages. It's built around privacy and self-hosting: each service runs in its own container, and the system ships with Tor support. Like Umbrel, it runs on your own hardware or on the company's boxes. Its packages come from Start9's registry or a community registry, and anyone can run a registry of their own.

**Plain Docker** means installing Docker on an ordinary computer, such as a Mac, a Windows PC, a Linux machine or a NAS, and running bitcoin software from container images with Docker Compose. There's no dashboard or app store unless you add one; you write or download a configuration file and run it.

## Setup and day-to-day use

- **Umbrel** aims to be the easiest. You flash an image or plug in its box, open a web page, and install a Bitcoin node, then Electrs, then whatever else from the store. Updates arrive through the dashboard.
- **Start9** is similar in spirit: a browser-based setup, then services installed from a marketplace. Each service tends to come with health checks and configuration screens, and its docs lean towards explaining what each setting does.
- **Docker** asks more of you. You choose images, edit a configuration file, decide where data lives, open the right ports on your own network and run updates yourself. In return, nothing is hidden: you can see and change everything.

If you've never used a terminal, Umbrel or Start9 is the right starting point. If you already run a NAS or a Linux machine, Docker may be the least new thing to learn.

## Openness

For software that holds or watches your bitcoin, it matters what you're allowed to read, change and redistribute.

- **umbrelOS** is published on GitHub under the [PolyForm Noncommercial 1.0.0 license](https://github.com/getumbrel/umbrel#license). You can read, modify and redistribute it for personal and nonprofit use, but commercial use needs an agreement with Umbrel. It's source-available, not open source in the OSI sense.
- **StartOS** is published under the [MIT license](https://github.com/Start9Labs/start-os/blob/master/LICENSE), a standard open-source licence with very few restrictions.
- **Docker Engine**, the part that runs containers on Linux, is open source; Docker Desktop, the usual way to run it on a Mac or Windows PC, is not. With plain Docker you run images directly from each project. For bitcoin software those are usually open source too, and you can build them yourself.

The bitcoin software you install (Bitcoin Core, Electrs, Fulcrum and others) is open source on all three. The licence difference is about the system around it.

## Backups and moving to new hardware

A home server holds things you'll want back if the disk dies: Lightning channel backups, configuration, app data.

- **Start9** has system backups to an external drive or network share. Its [0.4 documentation](https://docs.start9.com/start-os/0.4.0.x/backup-create.html) describes them as encrypted with your master password.
- **Umbrel** has its own backup and migration features. Check its current documentation for what each app includes, because apps can choose to leave data out.
- **Docker** has no built-in backup. You back up the data folders yourself, and the right method depends on what's in them.

For any of them, remember one thing: **a backup of something that holds keys is another copy of those keys.** Store it accordingly, or leave it out on purpose.

## Bitcoin specifics worth checking

Whichever you pick, check these before you rely on it:

- **Which node and Electrum server it runs,** and whether you can choose (Electrs or Fulcrum, for example).
- **Whether the node is pruned.** Many Electrum servers need a full, unpruned node.
- **How you reach it from outside home:** Tor, a VPN, or a tunnel the system provides. Avoid opening its dashboard to the internet.
- **How updates arrive,** and whether you can see what changed before you apply them.
- **What runs alongside it.** Every app you add to the box is code with access to your network, and to whatever keys live there. [A bitcoin co-signer on your home server](/blog/self-hosted-bitcoin-cosigner-umbrel-start9) covers what that means once a key lives on the box.

## Which one to choose

- **Choose Umbrel** if you want the easiest start, a big app store beyond bitcoin, and don't mind a non-commercial licence.
- **Choose Start9** if you want a fully open-source system, built-in Tor, and encrypted system backups, and you're happy with a smaller, more curated catalogue.
- **Choose plain Docker** if you already run a NAS or a Linux machine, are comfortable editing a configuration file, and want to see and control everything.

All three can run a node and an Electrum server well. For privacy, the important step is running one at all and pointing your wallets at it. For security, the important step is keeping spending keys off the box, or keeping them limited by rules when they're there. [2-of-3 multisig explained](/blog/2-of-3-multisig-explained) shows how a key on a server can be one of three rather than the only one.

## Trikey on all three

[Trikey](/) is an open-source 2-of-3 wallet in which you hold all three keys: a hardware wallet, your phone, and the **Trikey Guardian**, an app on your own home server. The guardian is one container image, packaged three ways ([Trikey Guardian](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#trikey-guardian-docker-container)):

- **Umbrel:** an app that depends on the box's Bitcoin node and Electrs, installed for now through Trikey's own community app store.
- **Start9:** a service package you build yourself for now.
- **Plain Docker:** a Docker Compose file for a Mac, a PC, Linux or a NAS, pointed at your own Electrum server or Bitcoin Core, with an optional node of its own.

On Umbrel and Start9 the guardian reads the chain from the box's own node by default. One decision cuts across all three: **the platforms' backups leave the guardian out.** Its data holds key 3 (under your passphrase), and a restored copy would roll back the daily-limit accounting. So after a restore you set up a fresh guardian and move the wallet to it with your phone and hardware wallet, exactly as after a lost box ([Trikey Guardian](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#trikey-guardian-docker-container)).

**Status:** Trikey is pre-alpha and has **not been audited**. Try it on test networks (signet, testnet4 or regtest); if you use mainnet anyway, use only an amount you can afford to lose. The [testers guide](https://github.com/TheIcarusWings/trikey/blob/main/docs/testers.md) explains how.

## FAQ

### Can I switch from Umbrel to Start9 (or the other way) later?

Yes, but plan it. Your bitcoin isn't on the box if your keys are on a hardware wallet, so switching mostly means syncing a new node and reconfiguring apps. Move Lightning funds and anything with keys first.

### Do I need dedicated hardware?

Not with Docker, which runs on a computer you already have, as long as it stays on and has the disk space. Umbrel and Start9 are designed for a dedicated machine.

### Is one of them more secure?

They make different trade-offs: Start9 puts more emphasis on isolation and privacy features, Umbrel on ease and breadth. The biggest factors are the same on all three: keep it updated, install few apps, don't expose it to the internet, and keep spending keys off it.

### Can I run Lightning on it?

All three can run Lightning software. Treat a home Lightning node as a hot wallet: keep a spending amount in it, not savings.
