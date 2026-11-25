---
title: "SIM Swaps: Why a Text Message Can't Protect Bitcoin"
description: "How a SIM swap works, why SMS codes can't protect bitcoin, what the FBI recommends, and how to set up accounts and wallets so a lost number costs nothing."
date: 2026-11-21
slug: sim-swap-bitcoin
keywords: [sim swap bitcoin, sim swap attack, sms two factor authentication, crypto exchange security, self-custody]
draft: true
queue: 19
---
One morning your phone shows "No service". You restart it and nothing changes. Meanwhile, someone else's phone has your phone number. They're resetting your email password with the code texted to "you", and then your exchange account, and then withdrawing. This is a **SIM swap**, and it has emptied a lot of crypto accounts without anyone touching a seed phrase or a wallet. This post explains how it works, why a text message is the weak point, and how to set things up so losing your number is an annoyance, not a disaster.

## What a SIM swap is

Your phone number belongs to your mobile carrier's records, not to the SIM card in your pocket. A **SIM swap** happens when an attacker convinces your carrier to move your number to a SIM card they control. They might call support pretending to be you, use personal details found online, bribe an employee, or use a carrier's online account that they've broken into. A **port-out** attack is the cousin of this: moving your number to a different carrier altogether.

Once it works, every call and text meant for you goes to them. Your phone just loses service.

## Why it works so well against crypto

The number itself isn't the prize. It's what the number unlocks:

- **SMS login codes.** Many accounts still send one-time codes by text message as a second factor.
- **Password resets.** "Forgot your password? We'll text you a code" lets the attacker take over email first, then everything that resets through that email.
- **Account recovery.** Support teams often treat "can receive a text to the number on file" as proof of identity.

The FBI warned about this in a 2022 public service announcement: its complaint center logged 1,611 SIM-swapping complaints in 2021 with losses of more than $68 million, many aimed at cryptocurrency ([FBI IC3, PSA220208](https://www.ic3.gov/PSA/2022/PSA220208), checked November 2026). Crypto is attractive because, once moved, it can't be clawed back.

## What a SIM swap can and can't reach

**It can reach** anything that trusts your phone number:

- exchange and custodial accounts with SMS codes or SMS-based recovery;
- your email, if it resets by text, and from there anything that resets by email;
- "custodial wallets" that are really accounts on a company's server.

**It can't reach**:

- **a self-custody wallet's keys.** A seed phrase on paper or a hardware wallet doesn't care about your phone number. The attacker would need the device or the words, not your number.
- **accounts protected by an authenticator app or a security key** rather than SMS, as long as their recovery doesn't fall back to SMS either.

This is the main lesson. **Coins in self-custody aren't exposed to a SIM swap at all.** Coins on an exchange depend on how that exchange lets people in.

## Protecting your number

None of these make a swap impossible. Together they make it much harder.

1. **Add a port-out PIN or SIM lock** with your carrier. Most carriers offer an extra PIN or a "number lock" that must be given before the number moves. Ask for it by name.
2. **Don't give account details to callers.** The FBI's advice is simple: if someone calls about your mobile account, hang up and call the carrier's own number.
3. **Use a phone number you don't share** for account recovery, if your carrier and accounts allow it, and keep your main number off public profiles.
4. **Don't advertise holdings.** The FBI also advises against posting about cryptocurrency ownership on social media and forums. It tells attackers who's worth the effort.
5. **Watch for "No service".** An unexplained loss of signal, especially with a "your SIM was changed" text just before, is the classic sign. Call your carrier from another phone immediately.

Rules are tightening too. In the US, the FCC adopted rules in November 2023 requiring wireless carriers to use secure ways of authenticating customers before a SIM change or port-out, and to notify customers when one is requested ([Federal Register, "Protecting Consumers from SIM-Swap and Port-Out Fraud"](https://www.federalregister.gov/documents/2023/12/08/2023-26338/protecting-consumers-from-sim-swap-and-port-out-fraud), checked November 2026). Check what your own carrier offers rather than assuming it's on.

## Protecting your accounts

- **Replace SMS codes with an authenticator app or a hardware security key** on every account that matters, email first. Security keys are the strongest option: they can't be phished or swapped.
- **Remove the phone number as a recovery option** where the service lets you. A strong second factor doesn't help if "lost access? we'll text you" is still on.
- **Turn on withdrawal allow-lists** on exchanges, so coins can only go to addresses you've approved in advance, ideally with a waiting period for new ones.
- **Keep only what you're trading on an exchange.** Everything else belongs in a wallet whose keys you hold.

## If it happens to you

1. **Call your carrier from another phone** and get the number back. Ask them to note the fraud and add a port-out PIN.
2. **Secure your email first,** since it unlocks everything else: change the password, sign out other sessions, check the recovery options and forwarding rules.
3. **Check every financial and crypto account** for logins, changed settings and withdrawals, and change their passwords.
4. **Report it** to the police and, in the US, to the FBI's IC3. The FBI notes that once crypto transfers start, the assets are very hard to recover, so speed matters.
5. **Expect follow-up scams.** People who've just been robbed are prime targets for fake "recovery services". [Seed phrase phishing](/blog/seed-phrase-phishing) covers that script.

## How Trikey avoids the phone number entirely

[Trikey](/) is an open-source 2-of-3 wallet in which you hold all three keys: a hardware wallet, your phone, and either the Trikey Guardian on your own home server or a printed Recovery Key. Nothing in it depends on a phone number:

- **No accounts and no SMS.** There's no Trikey company and no login to recover. The phone talks to your own guardian over encrypted nostr messages: outbound-only connections with no accounts ([design decisions](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#decisions-so-far)).
- **The phone key lives in the phone, not the number.** Key 2 is encrypted with a key from the phone's secure chip and unlocked with biometrics. A SIM swap moves your number, not that key ([mobile app](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#mobile-app-react-native)).
- **Recovery doesn't trust a text.** Replacing a lost phone means the hardware wallet and the guardian together, after a waiting period with alerts, or restoring from your encrypted backup with its recovery code ([recovery flows](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#recovery-flows)). [Delay & Notify](/blog/delay-and-notify-time-locked-recovery) explains the waiting period.
- **Alerts go to channels you choose:** nostr messages, email through your own account, ntfy, a webhook or Telegram. None of them is SMS. A Telegram account is tied to a phone number, though, so if you use it for alerts, turn on Telegram's own two-step password as well ([alerts beyond nostr](https://github.com/TheIcarusWings/trikey/blob/main/DESIGN.md#alerts-beyond-nostr-email-ntfy-webhook-telegram)).

**Status:** Trikey is pre-alpha and has **not been audited**. Try it on test networks (signet, testnet4 or regtest); if you use mainnet anyway, use only an amount you can afford to lose. The [testers guide](https://github.com/TheIcarusWings/trikey/blob/main/docs/testers.md) explains how.

## FAQ

### Can a SIM swap steal bitcoin from a hardware wallet?

No. The keys are on the device and in your seed backup, neither of which depends on your phone number. A SIM swap is a risk to accounts that trust your number, such as exchanges and email.

### Is SMS two-factor authentication better than nothing?

Yes, against password guessing. But against a targeted attacker it's the weak point, because the code goes to whoever holds your number. Use an authenticator app or a security key instead.

### How do I know if I've been SIM swapped?

Your phone suddenly shows no service, often after a text about a SIM change, and you start getting password-reset emails you didn't ask for. Call your carrier from another phone straight away.

### Does an eSIM prevent SIM swaps?

Not by itself. The attack targets your carrier's records, not the physical card, so an eSIM can be moved too. A port-out PIN or SIM lock is what helps.

### Should I keep my crypto on an exchange with SMS security?

Keep only what you're actively trading there, protected by an authenticator app or a security key. Move the rest to a wallet whose keys you hold.
