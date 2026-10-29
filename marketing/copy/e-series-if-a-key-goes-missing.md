# Series · "If a key goes missing"

Three short films, one per key. Each file comes in 9:16, 1:1 and 16:9, with a music-only and a `-vo`
cut. The 9:16 cuts are centre crops of the 1080p footage, so they are softer than the others.
Post them as a thread on X (one per day works too), and as three notes on nostr.

| Episode | File stem | Length |
|---|---|---|
| 1 · Your phone | `trikey-e1-phone` | 39.5 s |
| 2 · Your hardware wallet | `trikey-e2-hardware-wallet` | 35 s |
| 3 · Your home server | `trikey-e3-home-server` | 31 s |

---

## Episode 1 · Your phone

### X post

```
If a key goes missing, part 1: your phone.

Lost it? Restore your backup, or let your hardware wallet + guardian run a 7-day recovery with daily alerts.

Stolen? At most your daily limit. Raising it needs your hardware wallet.

github.com/TheIcarusWings/trikey
```

### Nostr note

```
If a key goes missing, part 1: your phone 📱

Trikey is a 2-of-3 wallet: phone, hardware wallet, and a guardian on your own Umbrel or Start9.

Lost your phone?
• Got your backup? Restore it on a new phone. No waiting.
• No backup? Your hardware wallet + guardian start a recovery. It waits 7 days (or 14, or 30) and alerts you and your contacts every day. Anyone can cancel a fake one.

Stolen?
• The guardian only co-signs up to your daily limit. Anything bigger needs your hardware wallet.
• Raising the limit needs the hardware wallet too.
• Start a recovery and phone-only payments pause.

One key gone. Your bitcoin isn't.

Pre-alpha, not audited, testnet only: https://github.com/TheIcarusWings/trikey

#bitcoin #nostr #selfcustody #umbrel #startos
```

### Alt text

```
Short film with white captions. A hand picks up a phone from a bedside table: "Key 2: your phone. Your everyday key." A phone left on a night train seat: "Lost it?" The app's "Restore from backup" screen: "Got your backup? Restore it on a new phone. No waiting." A thumb presses a small hardware wallet, then the Trikey Guardian web page showing a recovery in progress: "No backup? Your hardware wallet and guardian start a recovery." A grey home server on a bookshelf with a counter running "Day 1 of 7" to "Day 7 of 7", then a friend's phone buzzing on a café table: "It waits 7 days and alerts you and your contacts every day." A gloved hand grabs a phone off a café table: "Stolen?" The app's "Approve on your Ledger" screen for a payment over the limit: "They can spend at most your daily limit. Raising it needs your hardware wallet." The "Recovery in progress" screen: "Start a recovery and phone-only payments pause." End card: Trikey logo, "One key gone. Your bitcoin isn't.", "Coming soon, pre-alpha, not audited", github.com/TheIcarusWings/trikey.
```

---

## Episode 2 · Your hardware wallet

### X post

```
If a key goes missing, part 2: your hardware wallet.

Lost it? Restore your seed words on a new device.

Stolen? It's PIN-locked, and it's one key of three. Any recovery a thief tries alerts you every day, and you cancel it.

github.com/TheIcarusWings/trikey
```

### Nostr note

```
If a key goes missing, part 2: your hardware wallet 🔐

In Trikey, key 1 is any hardware wallet (Ledger, Trezor, Coldcard, BitBox, Jade…). It handles big payments and changing the rules.

Lost it?
• Restore your seed words on a new device. Done.

Stolen?
• It's PIN-locked. And even unlocked, it's one key of three.
• If the thief tries to start a recovery with it, you and your contacts get an alert every day for 7 days, and you cancel it.
• Restore your seed words and move everything to a fresh wallet with your phone.

Keep your seed words somewhere other than the device. One key gone. Your bitcoin isn't.

Pre-alpha, not audited, testnet only: https://github.com/TheIcarusWings/trikey

#bitcoin #nostr #selfcustody #hardwarewallet
```

### Alt text

```
Short film with white captions. A drawer opens on a small black hardware wallet resting on linen: "Key 1: your hardware wallet. For big payments and changing the rules." A hand searches an empty drawer: "Lost it?" A handwritten page under a desk lamp: "Restore your seed words on a new device. Done." A flashlight sweeps over a ransacked, empty drawer: "Stolen?" Gloved fingers press the device's buttons while its screen shows a padlock: "It's PIN-locked. And even unlocked, it's one key of three." The app's "Someone started a recovery" alert, and a finger taps "Cancel recovery": "If they try to start a recovery, you're alerted every day and cancel it." The app's "Recovery complete" screen: "Restore your seed words and move everything to a fresh wallet with your phone." End card: Trikey logo, "One key gone. Your bitcoin isn't.", "Coming soon, pre-alpha, not audited", github.com/TheIcarusWings/trikey.
```

---

## Episode 3 · Your home server

### X post

```
If a key goes missing, part 3: your home server.

Dies or goes offline? Your phone + hardware wallet still move any amount.

Stolen? The guardian locks itself after any restart. And it never held your money: one key of three.

github.com/TheIcarusWings/trikey
```

### Nostr note

```
If a key goes missing, part 3: your home server 🏠

Key 3 is the Trikey Guardian, an app on your own Umbrel or Start9. It co-signs everyday phone payments under your daily limit and runs Delay & Notify recovery.

It dies or goes offline?
• Your phone + hardware wallet still move any amount.
• Set up a new guardian and move to a fresh wallet.

Stolen?
• It locks itself after any restart: key 3 stays encrypted until you unlock it from your phone with your hardware wallet. Useless to a burglar.
• It never held your money. Just one key of three.

One key gone. Your bitcoin isn't.

Pre-alpha, not audited, testnet only: https://github.com/TheIcarusWings/trikey

#bitcoin #nostr #umbrel #startos #selfhosted
```

### Alt text

```
Short film with white captions. A small grey box with a soft white light on a home bookshelf: "Key 3: the guardian, on your own home server." A hand pulls its power cable and the light goes out: "It dies or goes offline?" The app's home screen with a "Guardian locked" card: "Your phone and hardware wallet still move any amount." The app's "Replace guardian" screen: "Set up a new guardian and move to a fresh wallet." At night a gloved hand lifts the box off the shelf: "Stolen?" In the back of a van the box is plugged into a power bank, then the Trikey Guardian page reads "Guardian locked": "It locks itself after any restart. Useless to them." The box is dropped on a pile of junk in a rainy alley: "And it never held your money. Just one key of three." End card: Trikey logo, "One key gone. Your bitcoin isn't.", "Coming soon, pre-alpha, not audited", github.com/TheIcarusWings/trikey.
```
