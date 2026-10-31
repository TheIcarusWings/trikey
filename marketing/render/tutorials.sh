#!/usr/bin/env bash
# Builds the setup tutorials into out/. Run from anywhere:
#   render/tutorials.sh          all tutorials
#   render/tutorials.sh t1       some
# Records the guardian's web pages from apps/guardian-web's mock scenarios (it starts and stops a vite dev server
# for that; needs `npm ci -w @trikey/guardian-web` once), then renders each tutorial at 16:9 with a quiet music bed.
# Needs: node + playwright, ffmpeg, python3 + numpy.
set -euo pipefail
cd "$(dirname "$0")/.."

declare -A PAGE=([t1]=t1-guardian-on-umbrel)
declare -A SEED=([t1]=11)
PORT=5174

# Guardian web footage.
(cd ../apps/guardian-web && exec ../../node_modules/.bin/vite --port $PORT --strictPort >/dev/null 2>&1) &
VITE=$!
trap 'kill $VITE 2>/dev/null || true' EXIT
until curl -s -o /dev/null "http://localhost:$PORT/"; do sleep 0.5; done
node render/capture/guardian.js "http://localhost:$PORT" build/tut/guardian setup locked
kill $VITE 2>/dev/null || true
(
  echo 'window.TL = {'
  for s in setup locked; do echo "  $s: $(tr -d '\n' < build/tut/guardian/$s/timeline.json),"; done
  echo '};'
) > build/tut/guardian/timelines.js

for v in ${@:-t1}; do
  id=${PAGE[$v]}
  dur=$(node -e "const s=require('fs').readFileSync('render/videos/$id.html','utf8');console.log(s.match(/duration: ([\d.]+)/)[1])")
  python3 render/audio/music.py calm "$dur" "${SEED[$v]}" "build/audio/music-$v.wav" >/dev/null
  node render/lib/render.js "render/videos/$id.html" 169 "build/silent/$id-169.mp4" >/dev/null
  python3 render/audio/mix.py "build/silent/$id-169.mp4" "build/audio/music-$v.wav" "out/trikey-$id.mp4" --quiet
  echo "out/trikey-$id.mp4"
done
