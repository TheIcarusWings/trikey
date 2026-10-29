# Marketing videos

Short social videos for X and nostr. The plan and the concepts are in [PLAN.md](PLAN.md).

| Path | What it is |
|---|---|
| `render/videos/*.html` | One page per video: captions, layers and a `update(t)` timeline for every ratio |
| `render/lib/` | Shared stage (CSS + timeline helpers), the mockup screen renderer, the frame renderer, the manifest writer |
| `render/audio/` | Ambient music synth (numpy) and the mixer (music-only and voiceover cuts) |
| `render/make.sh` | Builds everything into `out/` |
| `render/fetch-assets.sh` | Downloads the Higgsfield b-roll and voiceover lines into `build/` |
| `copy/` | X post, nostr note, alt text and voiceover script per video |
| `storyboards/` | 9:16 frame strips per video |
| `MANIFEST.md` | The rendered files (not committed) |

## Build

```sh
cd marketing
render/fetch-assets.sh   # needs build/higgsfield-assets.tsv and access to the Higgsfield CDN
render/make.sh           # or: render/make.sh v1
```

Each video comes out in 9:16 (1080×1920), 1:1 (1080×1080) and 16:9 (1920×1080), H.264 + AAC, captions
burned in. `trikey-<video>-<ratio>.mp4` has music only; `…-vo.mp4` adds the voiceover.

How it's made:
- **Motion and type:** the HTML pages, rendered frame by frame with Playwright (`seek(t)` per frame) and encoded with ffmpeg.
- **App and guardian footage:** `design/screens/*.dc.html` rendered with their dark tokens.
- **B-roll:** Higgsfield (Seedance 2.5) clips, hands and objects only, no faces, no logos.
- **Voiceover:** Higgsfield Seed Audio, stock preset voice "Holden" (not a clone).
- **Music:** synthesized by `render/audio/music.py`; no samples.

Rules the videos follow: pre-alpha and not audited is stated on every end card; demo balances and
addresses only; Bitkey and hardware wallet makers are named in text only, with no logos.
