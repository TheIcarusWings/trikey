"""Masks what the tutorials must not show in the Umbrel footage, in place.

The footage is recorded on the owner's own Umbrel (a local session does that; its capture script stays on the owner's
machine because its masks name the owner) and arrives as build/tut/umbrel/<shot>/NNNN.png at 1920×1200 (a 1280×800
page at 1.5×). This hides the app's version number on the store page, so the videos never name a version: the box is
filled with the colour just to its right, which also matches the dimmed frames under a dialog.

Usage: python3 render/capture/umbrel_mask.py build/tut/umbrel
"""
import glob
import os
import sys

from PIL import Image, ImageDraw

# Device-pixel boxes per shot: (left, top, right, bottom).
BOXES = {'install': [(180, 495, 330, 545)]}

for shot, boxes in BOXES.items():
    for f in sorted(glob.glob(os.path.join(sys.argv[1], shot, '*.png'))):
        im = Image.open(f).convert('RGB')
        d = ImageDraw.Draw(im)
        for l, t, r, b in boxes:
            d.rectangle((l, t, r, b), fill=im.getpixel((r + 8, (t + b) // 2)))
        im.save(f)
