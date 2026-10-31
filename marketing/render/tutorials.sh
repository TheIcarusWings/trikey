#!/usr/bin/env bash
# Builds the setup tutorials into out/. Run from anywhere:
#   render/tutorials.sh          all tutorials
#   render/tutorials.sh t1       some
# Records the guardian's web pages from apps/guardian-web's mock scenarios (it starts and stops a vite dev server
# for that; needs `npm ci -w @trikey/guardian-web` once), then renders each tutorial at 16:9 with its voiceover.
# Also needs, in build/ (not in git): the Umbrel footage in build/tut/umbrel/<shot>/ (recorded on the owner's
# machine), and the Higgsfield narration and presenter clips from render/fetch-assets.sh.
# Needs: node + playwright, ffmpeg, python3 + numpy + pillow.
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

# Umbrel footage: mask what the videos must not show, and collect the shots' timelines.
python3 render/capture/umbrel_mask.py build/tut/umbrel
(
  echo 'window.UTL = {'
  for s in home store install open; do echo "  $s: $(tr -d '\n' < build/tut/umbrel/$s/timeline.json),"; done
  echo '};'
) > build/tut/umbrel/timelines.js

# Presenter clips: frames for the page, and their soundtrack as voiceover lines 80x.
mkdir -p build/tut/vo-proc
for f in build/tut/presenter/tp8*.mp4; do
  name=$(basename "$f" .mp4)
  rm -rf "build/clips/$name-169" && mkdir -p "build/clips/$name-169"
  ffmpeg -v error -i "$f" -vf "fps=30,scale=1920:1080:flags=lanczos" -q:v 2 "build/clips/$name-169/%04d.jpg"
  ffmpeg -v error -y -i "$f" -vn -ac 1 -ar 48000 "build/tut/vo-proc/${name#tp}.wav"
done
python3 render/audio/prep_vo.py build/tut/vo build/tut/vo-proc render/audio/tut-vo-trims.tsv >/dev/null

for v in ${@:-t1}; do
  id=${PAGE[$v]}
  # The page computes its own length (it depends on the footage and the presenter clips): render first, then read it.
  node render/lib/render.js "render/videos/$id.html" 169 "build/silent/$id-169.mp4" >/dev/null
  dur=$(python3 -c "import json;print(json.load(open('build/silent/$id-169.spec.json'))['duration'])")
  python3 render/audio/music.py calm "$dur" "${SEED[$v]}" "build/audio/music-$v.wav" >/dev/null
  python3 render/audio/mix.py "build/silent/$id-169.mp4" "build/audio/music-$v.wav" "out/trikey-$id.mp4" --vo build/tut/vo-proc
  echo "out/trikey-$id.mp4"
done
