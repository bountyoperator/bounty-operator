#!/usr/bin/env python3
"""Extract real stamp ink from two CC0 scans, for scripts/build-stamps.mjs.

    python -I scripts/extract-ink.py <folder with the two scans>

The scans are Jan Pešula's pages of Czech and East German rubber-stamp
imprints from 1984, on Wikimedia Commons under CC0 (sources, SHA-1 and
licence in scripts/ink/SOURCES.md). The script never ships the scans; it
writes two derived files into scripts/ink/, which are committed:

  patches.png   real ink, cut from inside thick strokes: a grid of 16 x 16
                patches, each normalised to its own impression's full
                strength (white is full ink, black is bare paper). Voids,
                mottle and fibre come from the paper and the rubber, not
                from a formula.
  pressure.png  how hard twelve real framed stamps were pressed: one row of
                192 x 64 per impression, the ink strength across its face
                (white is the heaviest part of that impression).

A maintainer tool. Needs numpy, scipy and Pillow. Re-run it only to change
which ink is used; build-stamps.mjs reads the two files.
"""

import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'scripts' / 'ink'
SCANS = {
    'Rubber_stamp_imprints_Czechia_GDR_1984.jpg': '29d54e0b6117ee1caafe54e4b6f5dc423abfc48d',
    'Rubber_stamps_state_retail_stores_Czechia_1984.jpg': '78630cf9c2c707aa6fcba0da4dd5d2676037246a',
}
PATCH = 16
PATCH_COLUMNS = 32
PATCH_COUNT = 32 * 12
PRESSURE_W, PRESSURE_H = 192, 64
PRESSURE_COUNT = 12


def coverage(path):
    """Ink drop below the paper, per pixel, 0 to 1, and the inked impressions."""
    rgb = np.asarray(Image.open(path).convert('RGB')).astype(np.float32) / 255
    height, width, _ = rgb.shape
    small = rgb[::8, ::8]
    paper = np.stack([ndi.gaussian_filter(ndi.maximum_filter(ndi.uniform_filter(small[..., c], 3), size=15), 6) for c in range(3)], -1)
    paper = np.stack([np.asarray(Image.fromarray(paper[..., c]).resize((width, height), Image.Resampling.BILINEAR)) for c in range(3)], -1)
    ink = np.clip(paper - rgb, 0, 1).max(-1)
    mask = ink > 0.12
    blobs = ndi.binary_opening(ndi.binary_closing(mask, structure=np.ones((25, 25))), structure=np.ones((9, 9)))
    labels, _ = ndi.label(blobs)
    impressions = []
    for index, box in enumerate(ndi.find_objects(labels)):
        top, left = box[0].start, box[1].start
        h, w = box[0].stop - top, box[1].stop - left
        # Leave out the scanner's edge and the page edges: real impressions sit inside the page.
        if h * w < 150 * 150 or w > width * 0.45 or h > height * 0.45:
            continue
        if top < 90 or left < 60 or top + h > height - 40 or left + w > width - 60:
            continue
        inked = (labels[box] == index + 1) & mask[box]
        values = ink[box][inked]
        if values.size < 2000:
            continue
        strength = float(np.percentile(values, 95))
        # A faint show-through from the facing page is not an impression.
        if strength < 0.28:
            continue
        impressions.append({'box': box, 'strength': strength, 'inked': inked})
    return ink, mask, impressions


def patches_from(ink, mask, impressions, rng):
    """Real ink from inside thick strokes: windows that are inked all the way
    through once the small voids are filled. The patch itself keeps its voids:
    they are the texture."""
    found = []
    filled = ndi.binary_closing(mask, structure=np.ones((5, 5)))
    solid = ndi.binary_erosion(filled, structure=np.ones((PATCH, PATCH)))
    for impression in impressions:
        box = impression['box']
        local = solid[box] & ndi.binary_dilation(impression['inked'], iterations=2)
        ys, xs = np.nonzero(local)
        order = rng.permutation(len(ys))
        taken = []
        for k in order:
            y, x = ys[k] + box[0].start, xs[k] + box[1].start
            if any(abs(y - ty) < PATCH and abs(x - tx) < PATCH for ty, tx in taken):
                continue
            taken.append((y, x))
            half = PATCH // 2
            window = ink[y - half:y + half, x - half:x + half]
            if window.shape != (PATCH, PATCH):
                continue
            patch = np.clip(window / impression['strength'], 0, 1)
            # Solid ink only: a patch that holds the inside of a letter or the
            # gap between two would print that shape into every stamp.
            bare = patch < 0.35
            if bare.mean() > 0.1:
                continue
            holes, count = ndi.label(bare)
            if count and np.bincount(holes.ravel())[1:].max() > 10:
                continue
            found.append(patch)
            if len(taken) >= 160:
                break
    return found


def pressure_of(ink, impression):
    """Ink strength across one impression's face: where there is ink, how much."""
    box = impression['box']
    face = ink[box] * impression['inked']
    weight = impression['inked'].astype(np.float32)
    sigma = max(6.0, (box[0].stop - box[0].start) / 9)
    spread = ndi.gaussian_filter(weight, sigma)
    field = ndi.gaussian_filter(face, sigma) / np.maximum(spread, 1e-6)
    # Where no ink lies near, carry the nearest measured strength out to the edge.
    known = spread > 0.04
    nearest = ndi.distance_transform_edt(~known, return_distances=False, return_indices=True)
    field = field[tuple(nearest)]
    field = ndi.gaussian_filter(field, sigma / 2)
    field = np.clip(field / np.percentile(field[weight > 0], 98), 0, 1)
    return np.asarray(Image.fromarray(field.astype(np.float32)).resize((PRESSURE_W, PRESSURE_H), Image.Resampling.BILINEAR))


def main():
    folder = Path(sys.argv[1])
    rng = np.random.default_rng(1984)
    patches, pressures, record = [], [], []
    for name, sha1 in SCANS.items():
        path = folder / name
        digest = hashlib.sha1(path.read_bytes()).hexdigest()
        if digest != sha1:
            sys.exit(f'{name}: SHA-1 {digest} is not the Commons file {sha1}')
        ink, mask, impressions = coverage(path)
        patches += patches_from(ink, mask, impressions, rng)
        # Framed stamps make the pressure maps: wide boxes, mostly a rule and a few lines.
        framed = [i for i in impressions if 1.5 <= (i['box'][1].stop - i['box'][1].start) / (i['box'][0].stop - i['box'][0].start) <= 3.8]
        for impression in framed:
            pressures.append(pressure_of(ink, impression))
            record.append({'scan': name, 'x': impression['box'][1].start, 'y': impression['box'][0].start,
                           'w': impression['box'][1].stop - impression['box'][1].start,
                           'h': impression['box'][0].stop - impression['box'][0].start})
        print(f'{name}: {len(impressions)} impressions, {len(framed)} framed')

    if len(patches) < PATCH_COUNT:
        sys.exit(f'only {len(patches)} solid patches; need {PATCH_COUNT}')
    chosen = [patches[i] for i in rng.choice(len(patches), PATCH_COUNT, replace=False)]
    rows = PATCH_COUNT // PATCH_COLUMNS
    atlas = np.zeros((rows * PATCH, PATCH_COLUMNS * PATCH), np.float32)
    for n, patch in enumerate(chosen):
        r, c = divmod(n, PATCH_COLUMNS)
        atlas[r * PATCH:(r + 1) * PATCH, c * PATCH:(c + 1) * PATCH] = patch
    OUT.mkdir(parents=True, exist_ok=True)
    Image.fromarray((atlas * 255).round().astype(np.uint8), 'L').save(OUT / 'patches.png', optimize=True)

    picks = rng.choice(len(pressures), min(PRESSURE_COUNT, len(pressures)), replace=False)
    sheet = np.concatenate([pressures[i] for i in picks], 0)
    Image.fromarray((sheet * 255).round().astype(np.uint8), 'L').save(OUT / 'pressure.png', optimize=True)
    (OUT / 'pressure.json').write_text(json.dumps([record[i] for i in picks], indent=1) + '\n')
    print(f'wrote scripts/ink/patches.png ({PATCH_COUNT} patches of {PATCH} px from {len(patches)} found)')
    print(f'wrote scripts/ink/pressure.png ({len(picks)} framed impressions)')


if __name__ == '__main__':
    main()
