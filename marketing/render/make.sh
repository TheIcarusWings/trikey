#!/usr/bin/env bash
# Builds the videos into out/. Run from anywhere:
#   render/make.sh            all videos
#   render/make.sh v1 v2      some videos (v1, v1b, v2, v3, f1)
# Needs: node + playwright, ffmpeg, python3 + numpy. Higgsfield assets come from
# render/fetch-assets.sh; videos without them get only the music-only cut.
set -euo pipefail
cd "$(dirname "$0")/.."

declare -A PAGE=([f1]=f1-nobody-in-the-middle [v1b]=v1b-brand [v1]=v1-three-keys [v2]=v2-stolen-phone [v3]=v3-lost-phone)
declare -A MOOD=([f1]=calm [v1b]=bright [v1]=bright [v2]=tense [v3]=calm)
declare -A SEED=([v1]=1 [v2]=2 [v3]=3 [v1b]=4 [f1]=5)
# Which draft take feeds each b-roll slot (SPEC.broll.name ← build/higgsfield/<take>.mp4).
declare -A TAKE=([v2-snatch]=v2-snatch-b [v3-train]=v3-train)

node render/lib/screens.js build/screens dark \
  Home Send-Review Send-Hardware Settings-Limit Recover-Alert Recover-Done Guardian-Recovery >/dev/null

for slot in "${!TAKE[@]}"; do
  src="build/higgsfield/${TAKE[$slot]}.mp4"
  [ -f "$src" ] || continue
  rm -rf "build/broll/$slot" && mkdir -p "build/broll/$slot"
  ffmpeg -v error -i "$src" -vf "fps=30,scale=1080:1920:flags=lanczos,eq=saturation=0.85" -q:v 2 "build/broll/$slot/%04d.jpg"
done

# Film shots: chosen take for each clip slot (build/film/<take>.mp4). 9:16 is a centre crop until
# vertical takes exist (build/film/<take>-916.mp4 is used when present).
declare -A FILM=([s01]=s01b [s02]=s02a [s03]=s03b [s04]=s04a [s06]=s06a [s07]=s07a [s08]=s08a [s10]=s10a
  [s11]=s11a [s12a]=s12a-a [s12b]=s12b-a [s12c]=s12c-a [s13]=s13a [s14]=s14a [s15]=s15a [s16]=s16a)
# Horizontal focus (0 = left, 1 = right) for the 9:16 centre crop, where the subject isn't centred.
declare -A FOCUS=([s07]=0.72 [s06]=0.55 [s13]=0.55)
for slot in "${!FILM[@]}"; do
  src="build/film/${FILM[$slot]}.mp4"
  [ -f "$src" ] || continue
  for r in 169 916; do
    out="build/clips/$slot-$r"
    [ -d "$out" ] && continue
    mkdir -p "$out"
    if [ $r = 169 ]; then vf="fps=30,scale=1920:1080:flags=lanczos"
    elif [ -f "build/film/${FILM[$slot]}-916.mp4" ]; then src="build/film/${FILM[$slot]}-916.mp4"; vf="fps=30,scale=1080:1920:flags=lanczos"
    else vf="fps=30,crop=608:1080:(iw-608)*${FOCUS[$slot]:-0.5}:0,scale=1080:1920:flags=lanczos"; fi
    ffmpeg -v error -i "$src" -vf "$vf" -q:v 2 "$out/%04d.jpg"
  done
done

[ -d build/vo ] && render/audio/prep-vo.sh >/dev/null

for v in ${@:-v1 v1b v2 v3 f1}; do
  id=${PAGE[$v]}
  slot=$(grep -o "broll: { name: '[^']*'" "render/videos/$id.html" | cut -d"'" -f2 || true)
  if [ -n "$slot" ] && [ ! -d "build/broll/$slot" ]; then echo "skip $v: b-roll $slot not fetched"; continue; fi
  dur=$(node -e "const s=require('fs').readFileSync('render/videos/$id.html','utf8');console.log(s.match(/duration: ([\d.]+)/)[1])")
  python3 render/audio/music.py "${MOOD[$v]}" "$dur" "${SEED[$v]}" "build/audio/music-$v.wav" >/dev/null
  for r in 916 11 169; do node render/lib/render.js "render/videos/$id.html" $r "build/silent/$id-$r.mp4" >/dev/null & done
  wait
  for r in 916 11 169; do
    python3 render/audio/mix.py "build/silent/$id-$r.mp4" "build/audio/music-$v.wav" "out/trikey-$id-$r.mp4"
    if python3 -c "import json,os,sys;s=json.load(open('build/silent/$id-$r.spec.json'));sys.exit(0 if s['vo'] and all(os.path.exists(f'build/vo-proc/{l[\"id\"]}.wav') for l in s['vo']) else 1)"; then
      python3 render/audio/mix.py "build/silent/$id-$r.mp4" "build/audio/music-$v.wav" "out/trikey-$id-$r-vo.mp4" --vo build/vo-proc
    fi
  done
done
node render/lib/manifest.js
