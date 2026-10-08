# Real stamp ink: sources

`patches.png` and `pressure.png` are derived from two scans of real rubber-stamp
imprints, made by `scripts/extract-ink.py`. `scripts/build-stamps.mjs` presses
every stamp on the site with this ink. The scans themselves are not in the
repository.

| Scan | Author | Licence | SHA-1 |
|---|---|---|---|
| [Rubber stamp imprints Czechia GDR 1984](https://commons.wikimedia.org/wiki/File:Rubber_stamp_imprints_Czechia_GDR_1984.jpg) (3508 × 2550, 300 dpi, 1984-06-25) | Jan Pešula, own work | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | `29d54e0b6117ee1caafe54e4b6f5dc423abfc48d` |
| [Rubber stamps state retail stores Czechia 1984](https://commons.wikimedia.org/wiki/File:Rubber_stamps_state_retail_stores_Czechia_1984.jpg) (3508 × 2550, 300 dpi, 1984-06-02) | Jan Pešula, own work | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | `78630cf9c2c707aa6fcba0da4dd5d2676037246a` |

Both are pages of a private collection of Czech and East German shop and office
stamps from the 1980s, read on Wikimedia Commons on 8 October 2026. CC0 asks for
no attribution; it is given here so the ink can be traced.

- `patches.png`: 384 patches of 16 × 16 px of solid ink from inside thick
  strokes, each normalised to its own impression's full strength. White is full
  ink, black is bare paper.
- `pressure.png`: twelve framed impressions, one 192 × 64 row each: how much ink
  reached the paper across the face of that stamp. `pressure.json` gives each
  impression's scan and box.

To rebuild: download both files from the links above into one folder, then
`python -I scripts/extract-ink.py <folder>` and `node scripts/build-stamps.mjs`.
