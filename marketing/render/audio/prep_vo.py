"""Cleans the raw voiceover lines in build/vo into build/vo-proc without clipping words.

- Lines listed in vo-trims.tsv lose their stray opening: the cut lands in the middle of the
  silence gap before the given time, never at its edge.
- Leading and trailing silence is trimmed with a pre-roll, so soft onsets ("f", "h", "k") survive,
  and a 10 ms fade-in / 40 ms fade-out avoids clicks.
- Pauses longer than 0.45 s are shortened to 0.3 s by removing their middle (with crossfades);
  speech is never cut.
- The line is sped up 6 % (atempo keeps pitch).

Usage: python3 prep_vo.py   (from anywhere; prints each line's length)
"""
import glob
import os
import subprocess

import numpy as np

SR = 48000
HOP = int(0.01 * SR)          # 10 ms analysis frames
SILENCE_DB = -50              # below this a frame counts as silence
PRE_ROLL = 0.12               # seconds kept before the first speech frame
POST_ROLL = 0.20              # seconds kept after the last speech frame
MAX_PAUSE, KEEP_PAUSE = 0.45, 0.30
XFADE = int(0.01 * SR)

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')


def load(path):
    pcm = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', '1', '-ar', str(SR), '-f', 's16le', '-'],
                         capture_output=True, check=True).stdout
    return np.frombuffer(pcm, np.int16).astype(np.float64) / 32768


def silent_frames(x):
    n = len(x) // HOP
    rms = np.sqrt(np.mean(x[: n * HOP].reshape(n, HOP) ** 2, axis=1))
    return 20 * np.log10(rms + 1e-9) < SILENCE_DB


def runs(mask, min_len):
    """(start, end) frame indices of True runs at least min_len frames long."""
    out, start = [], None
    for i, m in enumerate(np.append(mask, False)):
        if m and start is None:
            start = i
        elif not m and start is not None:
            if i - start >= min_len:
                out.append((start, i))
            start = None
    return out


def cut_stray_opening(x, t):
    """Cut in the middle of the last silence gap that starts before t seconds."""
    gaps = [g for g in runs(silent_frames(x), 15) if g[0] * HOP < t * SR]
    at = (gaps[-1][0] + gaps[-1][1]) // 2 * HOP if gaps else int(t * SR)
    return x[at:]


def trim_ends(x):
    speech = np.flatnonzero(~silent_frames(x))
    a = max(0, speech[0] * HOP - int(PRE_ROLL * SR))
    b = min(len(x), (speech[-1] + 1) * HOP + int(POST_ROLL * SR))
    y = x[a:b].copy()
    y[:XFADE] *= np.linspace(0, 1, XFADE)
    fo = int(0.04 * SR)
    y[-fo:] *= np.linspace(1, 0, fo)
    return y


def shorten_pauses(x):
    keep = int(KEEP_PAUSE * SR)
    pieces, pos = [], 0
    for s, e in runs(silent_frames(x), int(MAX_PAUSE * 100)):
        s, e = s * HOP, e * HOP
        cut_a, cut_b = s + keep // 2, e - keep // 2
        pieces.append(x[pos:cut_a + XFADE])
        pos = cut_b
    pieces.append(x[pos:])
    # Crossfade each join over XFADE samples.
    y = pieces[0]
    for p in pieces[1:]:
        ramp = np.linspace(0, 1, XFADE)
        y = np.concatenate([y[:-XFADE], y[-XFADE:] * (1 - ramp) + p[:XFADE] * ramp, p[XFADE:]])
    return y


def main():
    trims = {}
    for line in open(os.path.join(ROOT, 'render/audio/vo-trims.tsv')):
        if line.strip() and not line.startswith('#'):
            vid, t = line.split('\t')[:2]
            trims[vid] = float(t)
    os.makedirs(os.path.join(ROOT, 'build/vo-proc'), exist_ok=True)
    for path in sorted(glob.glob(os.path.join(ROOT, 'build/vo/*.wav'))):
        vid = os.path.basename(path)[:-4]
        x = load(path)
        if vid in trims:
            x = cut_stray_opening(x, trims[vid])
        x = shorten_pauses(trim_ends(x))
        out = os.path.join(ROOT, 'build/vo-proc', vid + '.wav')
        pcm = (np.clip(x, -1, 1) * 32767).astype('<i2').tobytes()
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 's16le', '-ar', str(SR), '-ac', '1', '-i', '-',
                        '-af', 'atempo=1.06', out], input=pcm, check=True)
        print(f'{vid} {len(x) / SR / 1.06:.2f}')


if __name__ == '__main__':
    main()
