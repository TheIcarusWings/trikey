"""Adds audio to a silent render.

Usage: python3 mix.py <silent.mp4> <music.wav> <out.mp4> [--vo <vo_dir>] [--quiet]

Without --vo: music only, normalized to -18 LUFS (sound is a bonus; captions carry the story), or -26 with --quiet.
With --vo:    voiceover lines placed at SPEC.vo[].at (from <silent>.spec.json, files <vo_dir>/<id>.wav),
              music ducked under the voice, normalized to -16 LUFS.
"""
import json
import subprocess
import sys


def main():
    silent, music, out = sys.argv[1:4]
    vo_dir = sys.argv[sys.argv.index('--vo') + 1] if '--vo' in sys.argv else None
    spec = json.load(open(silent.replace('.mp4', '.spec.json')))
    dur = spec['duration']

    inputs = ['-i', silent, '-i', music]
    if not vo_dir:
        # --quiet: a soft bed for the tutorials, which people read while it plays.
        level = -26 if '--quiet' in sys.argv else -18
        graph = f'[1:a]atrim=0:{dur},loudnorm=I={level}:TP=-1.5:LRA=11[a]'
    else:
        parts = []
        for i, line in enumerate(spec['vo']):
            inputs += ['-i', f"{vo_dir}/{line['id']}.wav"]
            ms = int(line['at'] * 1000)
            parts.append(f'[{i + 2}:a]aresample=48000,aformat=channel_layouts=stereo,adelay={ms}|{ms}[v{i}]')
        n = len(spec['vo'])
        graph = ';'.join(parts) + ';' + \
            ''.join(f'[v{i}]' for i in range(n)) + f'amix=inputs={n}:normalize=0,apad,atrim=0:{dur},asplit[vo][key];' + \
            f'[1:a]atrim=0:{dur},volume=-9dB[m];' + \
            '[m][key]sidechaincompress=threshold=0.02:ratio=6:attack=40:release=500[duck];' + \
            '[vo][duck]amix=inputs=2:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[a]'

    cmd = ['ffmpeg', '-v', 'error', '-y', *inputs, '-filter_complex', graph,
           '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
           '-shortest', '-movflags', '+faststart', out]
    subprocess.run(cmd, check=True)
    print(out)


if __name__ == '__main__':
    main()
