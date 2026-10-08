# Rendering performance

Benchmark: `node scripts/bench.mjs` (add `--json` for machine output, `BENCH_SCALE=0.1` for a quick run).
It builds a synthetic drawing in headless Chromium (playwright-core, same browser as `test/e2e/run.mjs`),
writes it to DXF and parses it back, builds the scene, and times `drawScene` on a 1400 x 850 canvas (dpr 1).
Each frame is timed up to a 1-pixel `getImageData`, so rasterisation is included.

Cases:

- **full** - 200k LINEs, 20k ARCs, 5k pattern HATCHes (ANSI31/ANSI37, 10-70 units, scale 1-4), 2k INSERTs of a
  50-entity block (rotated, scaled), 20k TEXTs (1.5-4.5 units high); 10 layers with different colours, one dashed;
  spread over 20000 x 12000 units. 247k entities, 345k scene items, 44 MB DXF.
- **text** - the 20k TEXTs alone.

Per view: 30 pan steps of 25 x 10 px, then 10 zoom steps alternating x1.25 / x0.8 about the centre; "fit" is
zoom extents, "10x" is ten times that about the drawing centre. "edit" is one entity changed plus `updateScene`.

## Baseline (main f124dd9, 2026-10-08, this container, software raster)

| case | parse | scene build | first frame | pan fit avg (max) | zoom fit | pan 10x avg (max) | zoom 10x | edit 1 entity |
|------|------:|------------:|------------:|------------------:|---------:|------------------:|---------:|--------------:|
| full | 4499 ms | 2761 ms | 1386 ms | 947 ms (1678) | 384 ms | 126 ms (235) | 134 ms | 164 ms |
| text | -     | 189 ms  | 182 ms  | 54 ms (135)   | 25 ms  | 10 ms (31)   | 9 ms  | 10 ms |

Observations from the code path (not yet profiled per stage):

- `drawScene` walks every scene item four times per frame (fills, line batches, arrows/points, text) and tests each
  bbox; the spatial grid in `pick.js` indexes document entities, not scene items, so drawing does not use it.
- Every visible pattern hatch does its own `save` / `clip` / stroke / `restore`; small text at fit is drawn as one
  `beginPath`/`stroke` per item (the existing < 2 px "bar" level of detail) with `globalAlpha` toggled each time.
- Paths are re-traced from the op arrays into screen space every frame (no cached `Path2D`).
- `updateScene` filters the whole item list, does a linear `doc.entities.find` per id and recomputes the scene
  bbox from all items, so a one-entity edit costs ~160 ms on the full case.
- Parse (4.5 s) and scene build (2.8 s) dominate opening; the first frame is another 1.4 s.

## After

Not yet measured - see the optimisation plan in the branch hand-off.
