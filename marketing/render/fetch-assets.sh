#!/usr/bin/env bash
# Downloads the Higgsfield outputs (b-roll drafts and voiceover lines) into build/.
# The URL list lives in build/higgsfield-assets.tsv (kind, name, url), which stays
# out of git because the URLs carry the Higgsfield account id.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build/higgsfield build/vo build/film
while IFS=$'\t' read -r kind name url; do
  case "$kind" in
    broll) out="build/higgsfield/$name.mp4" ;;
    vo)    out="build/vo/$name.wav" ;;
    film)  out="build/film/$name.mp4" ;;
    *)     continue ;;
  esac
  [ -f "$out" ] || curl -fsS -o "$out" "$url"
done < build/higgsfield-assets.tsv
for f in build/vo/*.wav; do printf '%s %ss\n' "$f" "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")"; done
