# V2 · "Someone stole my phone." (31 s)

Files: `trikey-v2-stolen-phone-{916,11,169}.mp4` (music) and `-vo.mp4` (voiceover + music).
Best on X: 1:1 or 9:16 (the hook is a full-bleed clip). Best on nostr: 9:16.

## X post

```
Someone steals your phone and gets past Face ID. What can they take?

With Trikey: at most your daily limit. Your guardian won't co-sign more, and raising the limit needs your hardware wallet.

Pre-alpha, not audited. Building in public:
trikey.app
```

## Nostr note

```
Threat model, part 1: someone steals your phone.

Say they even get past Face ID. Your Trikey wallet is 2-of-3: phone, hardware wallet, and a guardian app on your own Umbrel or Start9.

• The guardian only co-signs phone payments up to your daily limit (rolling 24 h).
• Anything bigger needs your hardware wallet. The thief doesn't have it.
• Raising the limit also needs the hardware wallet. Lowering it works from the phone alone.
• You start a recovery with your hardware wallet + guardian, and phone-only payments pause straight away.

No company in the loop: the guardian runs on your box and talks to the phone over end-to-end encrypted nostr relays.

Pre-alpha, not audited, testnet only. Design doc and threat model:
https://trikey.app
Code: https://github.com/TheIcarusWings/trikey

#bitcoin #nostr #selfcustody #umbrel #startos
```

## Alt text

```
Short explainer. Opens on a café table: a hand snatches a phone off the table. Text: "Someone just stole your phone." Cut to the Trikey home screen showing a 4,210,000 sat balance: "Say they get past Face ID." A send screen reads "Approve on your Ledger: 1,500,000 sats is over today's limit," with the caption "Over the daily limit, your guardian won't co-sign. Only your hardware wallet can. They don't have it." The daily limit settings screen: "Raising the limit needs your hardware wallet too. Lowering it works from the phone alone." A bar shows a small red slice: "A thief's max today: 200,000. Out of reach: 4,010,000," then "Recovery started, phone-only payments paused." Caption: "At most, they get your daily limit. Then start a recovery with your hardware wallet." End card: Trikey logo, "One key gone. Your bitcoin isn't.", "Pre-alpha, not audited, testnet only", trikey.app and github.com/TheIcarusWings/trikey.
```

## Voiceover script (the -vo cut)

| At | Line |
|---|---|
| 0:00 | Someone just stole your phone. |
| 0:04 | Say they even get past Face ID. |
| 0:08 | Your guardian only co-signs up to your daily limit. Anything bigger gets refused. |
| 0:14 | And raising that limit needs your hardware wallet. Which they don't have. |
| 0:20 | So at most, they get your daily limit. Start a recovery with your hardware wallet, and phone payments pause. |
| 0:27 | Trikey. Pre-alpha, and building in public. |

Note on accuracy: the daily limit is a rolling 24 hours, so "at most your daily limit" assumes you react within a day. That's why the video pairs it with starting a recovery, which pauses phone-only payments.
