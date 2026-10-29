"""Quiet ambient bed for the Trikey videos, synthesized from scratch (no samples).

Usage: python3 music.py <mood> <seconds> <seed> <out.wav>
Moods: bright (V1), tense (V2), calm (V3).
"""
import sys
import wave

import numpy as np

SR = 48000
BEAT = 60 / 72  # 72 bpm, one chord per 4 beats

MOODS = {
    # MIDI notes per chord; the first note is the bass root.
    'bright': [[38, 57, 61, 64, 66, 69], [35, 54, 57, 61, 62, 66], [31, 55, 59, 62, 66, 69], [33, 52, 57, 61, 64, 66]],
    'tense':  [[33, 57, 60, 64, 67, 71], [29, 53, 57, 60, 64, 67], [26, 53, 57, 60, 62, 65], [28, 52, 56, 59, 64, 69]],
    'calm':   [[36, 55, 59, 62, 64, 67], [33, 55, 57, 60, 64, 67], [29, 53, 57, 60, 64, 69], [31, 55, 59, 62, 65, 69]],
}


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def tone(f, n, detune=0.0, harmonics=4):
    t = np.arange(n) / SR
    out = np.zeros(n)
    for k in range(1, harmonics + 1, 2):  # odd harmonics, soft triangle-ish
        out += np.sin(2 * np.pi * f * k * (1 + detune) * t) / (k * k)
    return out


def envelope(n, attack, release):
    e = np.ones(n)
    a, r = int(attack * SR), int(release * SR)
    e[:a] = np.linspace(0, 1, a) ** 2
    e[n - r:] *= np.linspace(1, 0, r) ** 2
    return e


def lowpass(x, cutoff):
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    X *= 1 / (1 + (f / cutoff) ** 4)
    return np.fft.irfft(X, len(x))


def reverb(x, seconds, rng):
    n = int(seconds * SR)
    ir = rng.standard_normal(n) * np.exp(-np.arange(n) / (SR * seconds / 5))
    ir[0] = 0
    size = len(x) + n
    y = np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(ir / np.sqrt(np.sum(ir ** 2)), size), size)
    return y[: len(x)]


def render(mood, seconds, seed):
    rng = np.random.default_rng(seed)
    chords = MOODS[mood]
    total = int((seconds + 3) * SR)
    L, R = np.zeros(total), np.zeros(total)
    bar = 4 * BEAT
    nbars = int(np.ceil(seconds / bar)) + 1

    for b in range(nbars):
        chord = chords[b % len(chords)]
        start = int(b * bar * SR)
        n = min(int((bar + 2.0) * SR), total - start)
        if n <= 0:
            break
        env = envelope(n, 1.6, 2.2)
        # Pad: upper chord tones, detuned left/right.
        for m in chord[1:]:
            L[start:start + n] += tone(hz(m), n, -0.0018) * env * 0.05
            R[start:start + n] += tone(hz(m), n, +0.0018) * env * 0.05
        # Sub bass on the root.
        sub = np.sin(2 * np.pi * hz(chord[0] + 12) * np.arange(n) / SR) * env * 0.11
        L[start:start + n] += sub
        R[start:start + n] += sub
        # Sparse plucks, one per beat at most.
        for beat in range(4):
            if rng.random() < 0.45:
                continue
            m = chord[1 + rng.integers(0, len(chord) - 1)] + 12
            s = start + int(beat * BEAT * SR)
            pn = min(int(1.6 * SR), total - s)
            if pn <= 0:
                continue
            p = tone(hz(m), pn, harmonics=3) * np.exp(-np.arange(pn) / (SR * 0.35)) * 0.045
            pan = rng.uniform(0.3, 0.7)
            L[s:s + pn] += p * (1 - pan)
            R[s:s + pn] += p * pan

    L, R = lowpass(L, 2600), lowpass(R, 2600)
    L += reverb(L, 3.0, rng) * 0.6
    R += reverb(R, 3.0, rng) * 0.6
    n = int(seconds * SR)
    out = np.stack([L[:n], R[:n]], axis=1)
    fade_in, fade_out = int(0.4 * SR), int(2.5 * SR)
    out[:fade_in] *= np.linspace(0, 1, fade_in)[:, None]
    out[n - fade_out:] *= np.linspace(1, 0, fade_out)[:, None] ** 1.5
    return out / np.max(np.abs(out)) * 0.7


def main():
    mood, seconds, seed, path = sys.argv[1], float(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
    pcm = (render(mood, seconds, seed) * 32767).astype('<i2')
    with wave.open(path, 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    print(path)


if __name__ == '__main__':
    main()
