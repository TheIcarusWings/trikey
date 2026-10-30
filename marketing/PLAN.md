# Trikey launch videos: content plan

Status: draft for review. Nothing produced or generated yet.

## Ground rules for every video

- **Honest status, every time.** End card: "Pre-alpha · not audited · testnet only · building in public". No "ready", "secure", "unhackable", no price talk.
- **Look:** zinc neutrals, Geist / Geist Mono, one orange dot (the logo's top circle). Dark theme by default (reads better in feeds), light theme for the "built in the open" piece.
- **Captions burned in**, sized for phones (≥ 48 px at 1080 wide). Every video works muted.
- **Hook in the first 2 s:** a plain, specific line on screen at frame 0. No logo intro.
- **Demo data only:** the mockups' balances (4,210,000 sats), `bc1q9d4x…7kmr`, contacts "Maria" and "Tom".
- **No competitors named:** describe the idea (easy to use, no company holds a key), never another product. Hardware wallets are named in text only, with no logos.
- **Brand lines:** "Three keys. No company." says what Trikey is; "One key gone. Your bitcoin isn't." is the promise. The promise closes the series, the lost/stolen phone explainers and the film, and it's used on trikey.app.
- **No people's faces or voices.** Generated b-roll shows objects and hands only; any voiceover uses a stock preset voice, never a clone.

## How the parts are made

| Source | What it makes | Cost |
|---|---|---|
| **Claude motion:** HTML/SVG animations I write, rendered frame by frame with Playwright, encoded with ffmpeg | Diagrams (three keys, the 2-of-3 triangle, nostr relay lines), kinetic captions, end cards, timers | Free |
| **Rendered UI:** `design/screens/*.dc.html` with light/dark tokens substituted, phone frames cropped and animated (slide, scroll, tap highlight) | All app and guardian footage | Free |
| **Higgsfield video** (Seedance 2.5) | A few seconds of real-world b-roll per video: a phone grabbed off a table, a home server on a shelf | 15 cr per 5 s draft (480p), ~80 cr per 5 s at 1080p |
| **Higgsfield voice** (Seed Audio, preset voice) | Optional voiceover track for a "sound on" variant | ~0.4 cr per line |
| **Music** | Higgsfield doesn't expose a standalone music model in this account (Suno isn't listed; Sonilo is game-only). I'll synthesize a quiet ambient pad with ffmpeg, or ship without music. | Free |

There's no motion/video Artifact type in this account, so "Claude motion" means the HTML → Playwright → ffmpeg path above. I tested it: screens render correctly with Geist loaded.

Formats: each video is laid out natively for **16:9 (1920×1080), 1:1 (1080×1080) and 9:16 (1080×1920)** rather than cropped, H.264 + AAC, ≤ 50 MB. Higgsfield clips are generated once at 9:16 and reused: cropped for 1:1, set in a split layout for 16:9.

---

## The concepts

Ranked by strength. **The first three are the ones I'd produce first.**

### 1. "Three keys. No company." ★ produce first
The core explainer. If someone sees only one video, it's this one.

- **Length:** 30 s · **Ratios:** 16:9, 1:1, 9:16 · **Theme:** dark
- **Hook (0–2 s):** "A bitcoin wallet that's easy to use. And no company holds a key."
- **Beats:**
  1. 0–2 s: hook text on black, orange dot pulses.
  2. 2–9 s: the triangle draws itself. Each corner labels in: **Hardware wallet** · **Your phone** · **Your home server**.
  3. 9–14 s: any two corners light up, a coin moves. "Any two keys move money."
  4. 14–20 s: phone + guardian light up → `Send-Review` screen, "Send with Face ID". Caption: "Everyday: phone + your guardian, under a daily limit."
  5. 20–25 s: phone + hardware → `Settings-Limit`, "Approve on Ledger". Caption: "Big payments and rule changes need your hardware wallet."
  6. 25–28 s: `wsh(sortedmulti(2,…))` in Geist Mono. "Plain multisig. Any wallet can recover it without us."
  7. 28–30 s: end card (logo, repo URL, "pre-alpha · not audited · building in public").
- **Shots:** Claude motion (triangle, text) · rendered UI (`Send-Review`, `Settings-Limit`, `Home`).
- **Higgsfield:** none needed. Optional 3 s home-server b-roll behind beat 2.

### 2. "Someone stole my phone." ★ produce first
Threat-model video. Concrete and a little dramatic, without fearmongering.

- **Length:** 25 s · **Ratios:** 9:16, 1:1, 16:9 · **Theme:** dark
- **Hook (0–2 s):** b-roll of a hand grabbing a phone off a café table. Caption: "Someone just stole your phone."
- **Beats:**
  1. 0–3 s: grab b-roll + hook caption.
  2. 3–8 s: "They get past Face ID. Now what?" Cut to `Home` screen: 4,210,000 sats.
  3. 8–13 s: thief tries a big send → guardian refuses. Caption: "Your guardian co-signs only up to your daily limit."
  4. 13–18 s: `Settings-Limit`, "Raising it needs your Ledger". Caption: "They can't raise the limit. That takes your hardware wallet."
  5. 18–22 s: "Worst case: one day's limit. The rest stays put." Then you start a recovery from your hardware wallet.
  6. 22–25 s: end card.
- **Shots:** Higgsfield b-roll (hands + phone, no face, no logos) · rendered UI · Claude motion (refusal stamp, limit meter).
- **Higgsfield:** 1 clip, 5 s, 9:16.

### 3. "Lost my phone: 7-day Delay & Notify." ★ produce first
Shows the time-delayed recovery, and the "anyone can cancel a fake one" twist.

- **Length:** 35 s · **Ratios:** 9:16, 1:1, 16:9 · **Theme:** dark
- **Hook (0–2 s):** "Lost your phone and your backup? Here's what happens."
- **Beats:**
  1. 0–3 s: b-roll of an empty table / phone left behind on a seat, or a pure-type hook.
  2. 3–9 s: "Your hardware wallet + your guardian start a recovery." `Guardian-Recovery` web UI.
  3. 9–16 s: a 7-day timeline animates; daily alert pings land on "old phone", "Maria", "Tom". `Recover-Waiting`, "5 days 14 h".
  4. 16–24 s: twist. "If someone else started it…" `Recover-Alert`, finger tap on **Cancel recovery**. Caption: "Any device or contact can cancel a fake one."
  5. 24–31 s: "If nobody cancels, the guardian co-signs the move on day 7." `Recover-Done`.
  6. 31–35 s: "Your server. Your contacts. No support ticket." End card.
- **Shots:** rendered UI (four screens) · Claude motion (timeline, ping dots) · optional Higgsfield hook clip.
- **Higgsfield:** 1 clip, 5 s, 9:16 (optional; a type-only hook also works).

### 4. "Your Umbrel is the guardian."
For node runners. Shows "outbound only, no open ports".

- **Length:** 25 s · **Ratios:** 16:9, 1:1 · **Theme:** dark
- **Hook:** "Your node already runs 24/7. Give it a job."
- **Beats:** home-server b-roll → `Guardian-Dashboard` → animated nostr relay lines (phone ⇄ relays ⇄ server, outbound arrows only, padlocks on the messages) → caption "No ports opened at home. No company servers." → `Guardian-Locked`: "Unplug it and it locks itself. Useless to a burglar." → "Umbrel and Start9. Coming soon." → end card.
- **Shots:** Higgsfield b-roll (5 s) · Claude motion (relay diagram) · rendered guardian UI.

### 5. "No home server? Recovery Key mode."
- **Length:** 30 s · **Ratios:** 9:16, 1:1 · **Theme:** dark
- **Hook:** "No Umbrel? You still get two-of-three."
- **Beats:** key 3 becomes a printed kit / NFC card / second hardware wallet (Claude motion icons) → `RK-Refills`: "200,000 sats a week, approved ahead of time" → a weekly calendar unlocks one refill at a time → "A thief with your phone gets one week at most." → `RK-Recover`: "Recovery is immediate with any two keys." → end card.
- **Shots:** Claude motion + rendered UI. No Higgsfield.

### 6. "Built in the open."
- **Length:** 20 s · **Ratios:** 16:9, 1:1 · **Theme:** light
- **Hook:** "A bitcoin wallet you can read end to end."
- **Beats:** scroll through `DESIGN.md` threat model and the descriptor code in Geist Mono → "MIT licensed" → "Pre-alpha. Not audited. Testnet only. Read it, break it, open issues." → repo URL.
- **Shots:** Claude motion (code/doc scroll), no Higgsfield. Cheapest; good as a pinned post.

### 7. (later) "Be the guardian for your family."
Hold until family hosting is closer; it raises a trust trade-off (a dishonest host) that the video must state, and that needs more than 30 s.

---

## Higgsfield budget

Balance: **3,000 credits** (Ultra plan). Prices below are from Higgsfield's preflight quotes.

For the first batch (videos 1–3):

| Item | Count | Unit | Credits |
|---|---|---|---|
| Seedance 2.5 drafts, 5 s, 9:16, 480p, no audio (2 takes each for videos 2 and 3) | 4 | 15 | 60 |
| Finalize the 2 chosen drafts to 1080p | 2 | ≤ 80* | ≤ 160 |
| Optional voiceover lines for "sound on" variants (Seed Audio preset voice) | ~25 | 0.4 | ~10 |
| **Total, upper bound** | | | **≈ 230** |

\* Finalizing a draft can't be priced until the draft exists; 80 is the price of a fresh 1080p 5 s clip, so I'm using it as the ceiling. I'll re-quote before finalizing.

Video 1 needs no Higgsfield credits. Videos 4–6 later would add roughly 15–95 credits each.

## Deliverables layout

```
marketing/
  PLAN.md               this file
  render/               HTML scenes + render scripts (committed)
  storyboards/          stills per beat (small PNGs, committed)
  copy/                 X post, nostr note and alt text per video (committed)
  out/                  MP4s (git-ignored)
  MANIFEST.md           rendered files, sizes, durations, checksums
```
