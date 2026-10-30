# V3 · "Lost my phone: 7-day Delay & Notify." (37.6 s)

Files: `trikey-v3-lost-phone-{916,11,169}.mp4` (music) and `-vo.mp4` (voiceover + music).
Best on X: 16:9 or 1:1. Best on nostr: 9:16.

## X post

```
Lost your phone and its backup?

Your hardware wallet + your guardian start a recovery. It waits 7 days and alerts you and your contacts daily. Anyone can cancel a fake one.

A time-delayed recovery, run on your own Umbrel or Start9.

Pre-alpha: trikey.app
```

## Nostr note

```
Threat model, part 2: you lose your phone and its backup.

Trikey is 2-of-3: hardware wallet, phone, and a guardian app on your own Umbrel or Start9. Lose the phone and the other two keys can still move your money, just not instantly:

1. Your hardware wallet + guardian start a recovery to a new wallet.
2. Phone-only payments pause.
3. The guardian waits 7 days (or 14, or 30, your choice) and sends a nostr DM alert every day to your devices and the contacts you picked.
4. If someone else started it, any device or contact taps Cancel.
5. If nobody cancels, the guardian co-signs the move on the last day.

The server that runs the delay is yours, and so are the alerts. No support ticket.

Pre-alpha, not audited, testnet only:
https://trikey.app
Code: https://github.com/TheIcarusWings/trikey

#bitcoin #nostr #umbrel #startos #plebchain
```

## Alt text

```
Short explainer. Opens on a phone left behind on an empty train seat at dusk. Text: "Lost your phone? And the backup with it?" The Trikey Guardian web page on umbrel.local shows "Recovery in progress, 5 days 14 hours left," signed with a Ledger: "Your hardware wallet + your guardian start a recovery." A timeline runs from Start to Day 7 while yellow alert dots appear every day for "Your old phone", "Maria" and "Tom": "Then it waits 7 days. Every day, you and your contacts get an alert." A phone screen reads "Someone started a recovery" and a finger taps "Cancel recovery": "Didn't start it? Cancel. Any of your devices or contacts can stop a fake recovery." A phone screen reads "Your money is safe, 4,208,800 sats moved to your new wallet": "Nobody cancels? Your guardian co-signs on day 7." Then large text: "Your server. Your contacts. No support ticket." End card: Trikey logo, "One key gone. Your bitcoin isn't.", "Pre-alpha, not audited, testnet only", trikey.app and github.com/TheIcarusWings/trikey.
```

## Voiceover script (the -vo cut)

| At | Line |
|---|---|
| 0:00 | Lost your phone? And the backup with it? |
| 0:04 | Your hardware wallet and your guardian start a recovery. |
| 0:09 | It waits seven days, and alerts you and your contacts every day. |
| 0:17 | If someone else started it, any of your devices or contacts can cancel it. |
| 0:24 | If nobody cancels, your guardian co-signs the move to your new wallet. |
| 0:29 | Your server. Your contacts. No support ticket. |
| 0:33 | Trikey. Pre-alpha, and building in public. |
