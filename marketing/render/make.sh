#!/usr/bin/env bash
# Builds the videos into out/. Run from anywhere:
#   render/make.sh            all videos
#   render/make.sh v1         one video (v1, v2 or v3)
# Needs: node + playwright, ffmpeg, python3 + numpy. Higgsfield assets come from
# render/fetch-assets.sh; videos without them get only the music-only cut.
set -euo pipefail
cd "$(dirname "$0")/.."

declare -A PAGE=([v1]=v1-three-keys [v2]=v2-stolen-phone [v3]=v3-lost-phone)
declare -A MOOD=([v1]=bright [v2]=tense [v3]=calm)
# Which draft take feeds each b-roll slot (SPEC.broll.name ← build/higgsfield/<take>.mp4).
declare -A TAKE=([v2-snatch]=v2-snatch-a [v3-train]=v3-train)

node render/lib/screens.js build/screens dark \
  Home Send-Review Send-Hardware Settings-Limit Recover-Alert Recover-Done Guardian-Recovery >/dev/null

for slot in "${!TAKE[@]}"; do
  src="build/higgsfield/${TAKE[$slot]}.mp4"
  [ -f "$src" ] || continue
  rm -rf "build/broll/$slot" && mkdir -p "build/broll/$slot"
  ffmpeg -v error -i "$src" -vf "fps=30,scale=1080:1920:flags=lanczos,eq=saturation=0.85" -q:v 2 "build/broll/$slot/%04d.jpg"
done

for v in ${1:-v1 v2 v3}; do
  id=${PAGE[$v]}
  slot=$(grep -o "broll: { name: '[^']*'" "render/videos/$id.html" | cut -d"'" -f2 || true)
  if [ -n "$slot" ] && [ ! -d "build/broll/$slot" ]; then echo "skip $v: b-roll $slot not fetched"; continue; fi
  dur=$(node -e "const s=require('fs').readFileSync('render/videos/$id.html','utf8');console.log(s.match(/duration: ([\d.]+)/)[1])")
  python3 render/audio/music.py "${MOOD[$v]}" "$dur" "${v#v}" "build/audio/music-$v.wav" >/dev/null
  for r in 916 11 169; do node render/lib/render.js "render/videos/$id.html" $r "build/silent/$id-$r.mp4" >/dev/null & done
  wait
  for r in 916 11 169; do
    python3 render/audio/mix.py "build/silent/$id-$r.mp4" "build/audio/music-$v.wav" "out/trikey-$id-$r.mp4"
    if python3 -c "import json,os,sys;s=json.load(open('build/silent/$id-$r.spec.json'));sys.exit(0 if all(os.path.exists(f'build/vo/{l[\"id\"]}.wav') for l in s['vo']) else 1)"; then
      python3 render/audio/mix.py "build/silent/$id-$r.mp4" "build/audio/music-$v.wav" "out/trikey-$id-$r-vo.mp4" --vo build/vo
    fi
  done
done
node render/lib/manifest.js
