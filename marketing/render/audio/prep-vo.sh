#!/usr/bin/env bash
# Cleans the raw voiceover lines in build/vo into build/vo-proc:
# cuts the stray openings listed in vo-trims.tsv, caps pauses at ~0.25 s, speeds up 6 %.
# Prints each processed line's length, which the video timelines are fitted to.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p build/vo-proc
for f in build/vo/*.wav; do
  id=$(basename "$f" .wav)
  ss=$(awk -v id="$id" '$1 == id { print $2 }' render/audio/vo-trims.tsv)
  ffmpeg -v error -y -ss "${ss:-0}" -i "$f" -af "aresample=48000,silenceremove=start_periods=1:start_threshold=-40dB:stop_periods=-1:stop_duration=0.3:stop_threshold=-40dB:stop_silence=0.25,atempo=1.06" "build/vo-proc/$id.wav"
  printf '%s %.2f\n' "$id" "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "build/vo-proc/$id.wav")"
done
