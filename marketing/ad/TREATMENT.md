# Trikey films: treatment

Status: pitch. Nothing generated for these yet.

Two pieces of work:
1. **"If a key goes missing"**, a series of three short films, one per key, each covering *lost* and *stolen*.
2. **"Nobody in the middle"**, one long story film about the product: decentralized, easy to use, no
   single point of failure, no company holding any key.

Cinematic footage comes from Higgsfield (Kling 3.0 Pro). Real Trikey UI appears only as inserts
rendered from `design/screens`. Supers, inserts, the logo animation (from the brand cut) and the music
are made here.

## Shared rules

- **People:** fictional and mostly faceless (hands, backs, silhouettes, soft focus). One protagonist
  across every film, recognisable by wardrobe: dark green wool coat, grey knit sweater. No real people,
  no look-alikes, no voice clones.
- **Devices:** generic and unbranded. Hardware wallet = "small matte black device with a tiny screen and
  two buttons". Home server = "small grey box with one soft white LED". Phones are plain black slabs,
  screens dark or out of focus.
- **Look:** natural light, muted palette, shallow depth of field, slow camera. Orange appears once, in
  the logo's top dot.
- **Claims:** every scenario below matches DESIGN.md ("Recovery flows", "Threat model"). We say "no
  single point of failure", never "unhackable" or "safe". End cards say "Coming soon · pre-alpha, not
  audited". No price talk.
- **Formats:** shots generated at 16:9; the chosen take is regenerated at 9:16; 1:1 is cut from 16:9.
  Supers burned in. Each film gets a music-only and a voiceover cut (stock preset voice).

---

## Series · "If a key goes missing"

Same structure every episode: **the key → lost → stolen → the line**. 30–40 s each.

### Episode 1 · Your phone (key 2)

| # | Picture | Super | Len |
|---|---|---|---|
| 1 | Close-up: a hand slides a plain black phone into a coat pocket | **Key 2: your phone. Your everyday key.** | 3 s |
| 2 | Night train, the phone left behind on an empty seat; doors close | **Lost it?** | 4 s |
| 3 | Insert: `Recover-Choose` / passkey restore | **Got your backup? Restore it on a new phone. No waiting.** | 4 s |
| 4 | Kitchen table, morning: the small black device next to a laptop, a thumb presses its button → insert `Guardian-Recovery` | **No backup? Your hardware wallet and guardian start a recovery.** | 5 s |
| 5 | Time-lapse window light, day to night ×7; a friend's phone buzzes elsewhere | **It waits 7 days and alerts you and your contacts every day.** | 5 s |
| 6 | Café: a gloved hand snatches a phone off a table | **Stolen?** | 3 s |
| 7 | Insert `Send-Hardware` ("Approve on your Ledger") | **They can spend at most your daily limit. Raising it needs your hardware wallet.** | 5 s |
| 8 | Owner at home starts the recovery; insert `Recover-Waiting` | **Start a recovery and phone-only payments pause.** | 4 s |
| 9 | Logo + end card | **One key gone. Your bitcoin isn't.** | 4 s |

### Episode 2 · Your hardware wallet (key 1)

| # | Picture | Super | Len |
|---|---|---|---|
| 1 | A drawer slides open: the small black device on folded linen | **Key 1: your hardware wallet. For big payments and changing the rules.** | 4 s |
| 2 | Moving boxes, an empty drawer, a hand searching | **Lost it?** | 3 s |
| 3 | A hand unfolds a paper seed backup under a lamp (words blurred), a new device on the table | **Restore your seed words on a new device. Done.** | 5 s |
| 4 | Burglary aftermath: an open drawer, the device gone | **Stolen?** | 3 s |
| 5 | Close-up PIN pad on a generic device, wrong-PIN shake | **It's PIN-locked. And even unlocked, it's one key of three.** | 4 s |
| 6 | Insert `Recover-Alert` with a tap on Cancel | **If they try to start a recovery, you're alerted every day and cancel it.** | 5 s |
| 7 | Owner restores the seed words, phone beside → insert `Recover-Done` | **Restore your seed words and move everything to a fresh wallet with your phone.** | 5 s |
| 8 | Logo + end card | **One key gone. Your bitcoin isn't.** | 4 s |

### Episode 3 · Your home server (key 3, the guardian)

| # | Picture | Super | Len |
|---|---|---|---|
| 1 | Bookshelf at dusk, plants, the grey box with a breathing white LED | **Key 3: the guardian, on your own home server.** | 4 s |
| 2 | Power cut: the room goes dark, the LED dies | **It dies or goes offline?** | 3 s |
| 3 | Insert `Home-Locked` | **Your phone and hardware wallet still move any amount.** | 4 s |
| 4 | Insert `Settings-ReplaceGuardian` | **Set up a new guardian and move to a fresh wallet.** | 4 s |
| 5 | Night: a gloved hand lifts the box off the shelf, cables trailing | **Stolen?** | 4 s |
| 6 | Back of a van: the box plugged into a power bank, LED blinks → insert `Guardian-Locked` | **It locks itself after any restart. Useless to them.** | 5 s |
| 7 | The box dropped on a pile of junk | **And it never held your money. Just one key of three.** | 3 s |
| 8 | Logo + end card | **One key gone. Your bitcoin isn't.** | 4 s |

---

## Film · "Nobody in the middle" (about 75 s)

The product story in four acts: the old choice, the idea, how it feels, what it stands for.

| # | Picture | Super / VO | Len |
|---|---|---|---|
| **I** | **The old choice** | | |
| 1 | Night, a glass office tower, every window lit | **For years, holding bitcoin meant a choice.** | 4 s |
| 2 | Slow push-in on a reception desk behind glass, nobody there | **Hand your keys to a company…** | 4 s |
| 3 | A single paper seed backup under a lamp in an empty room | **…or carry the whole weight alone.** | 4 s |
| 4 | The paper's edge catches a draft and lifts | **One key. One mistake. Gone.** | 3 s |
| **II** | **The idea** | | |
| 5 | Black, then three soft lights fade up (logo dots, brand cut) | **What if you held three keys?** | 3 s |
| 6 | Morning: a hand takes the phone from a bedside table | **One in your pocket.** | 3 s |
| 7 | A drawer opens: the hardware wallet on linen | **One in a drawer.** | 3 s |
| 8 | Bookshelf: the grey box, LED breathing | **One on a shelf at home.** | 3 s |
| 9 | Logo forms: dots connect, top dot turns orange | **Any two move your money.** | 4 s |
| **III** | **How it feels** | | |
| 10 | Café: phone turned over, a thumb taps → insert `Send-Review` | **Everyday payments: just your phone and Face ID.** | 5 s |
| 11 | Desk: the hardware wallet's button pressed, laptop glow → insert `Send-Hardware` | **Big ones: confirm on your hardware wallet.** | 4 s |
| 12 | Quick cuts: phone left on a train, a server unplugged, a drawer found empty | **Lose one? You still have the other two.** | 5 s |
| 13 | Insert `Recover-Alert`; a friend's phone buzzes | **Anything suspicious, you and the people you trust hear about it. Daily.** | 4 s |
| **IV** | **What it stands for** | | |
| 14 | Blue hour, the protagonist walks across a bridge, city lights on | **No company holds a key.** | 4 s |
| 15 | Through a window: the home shelf, the box glowing | **No server but yours.** | 3 s |
| 16 | Wide, the figure small against the city | **No one to ask permission.** | 3 s |
| 17 | Light ground, the logo animation, then end card | **Trikey. Your keys. Your server. Your bitcoin.** · Open source (MIT) · Coming soon · pre-alpha, not audited | 6 s |

Music: low and patient in act I, lifting at the logo in act II, steady and warm through IV.

---

## Cost (Kling 3.0 Pro, 1080p, no sound: 1.75 credits per second, any ratio)

Only shots with generated picture count; UI inserts, logo and end cards are free.

| | Generated footage | 16:9, 2 takes | 9:16, chosen take | Total |
|---|---|---|---|---|
| Episode 1 · Phone | ~19 s | ~67 | ~33 | **~100** |
| Episode 2 · Hardware wallet | ~19 s | ~67 | ~33 | **~100** |
| Episode 3 · Home server | ~15 s | ~53 | ~26 | **~79** |
| Film · Nobody in the middle | ~52 s | ~182 | ~91 | **~273** |
| Voiceover, ~45 lines (Seed Audio, 0.2 each) | | | | **~9** |
| **Everything** | | | | **~560** |

Balance: 2,931.9 credits. 4K masters would multiply footage cost by about 3.4.
Suggested order: the film first (it sets the look and the protagonist), then the three episodes reusing
its establishing shots (drawer, shelf, phone) where they fit, which brings the episodes down by roughly
a quarter.

## Where things live

Higgsfield project **"Trikey launch videos"**. Folders today: `Explainers · b-roll`,
`Explainers · voiceover`, plus three placeholder ad folders that will be renamed to
`Film · Nobody in the middle`, `Ep 1 · Phone`, `Ep 2 · Hardware wallet`, `Ep 3 · Home server`.
