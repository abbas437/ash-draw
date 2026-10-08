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

## After (branch perf3, 2026-10-08, same container and benchmark, one full run)

Changes: grid-culled single pass over visible items (perf2); level of detail at fit (items under 1 px drawn as
1-px dots, one fill per colour; pattern hatches with line spacing under 2 px drawn as a light tint, one fill per
colour without clipping; text under 2 px as bars, one stroke per colour); cached per-style batch keys and colours;
incremental `updateScene` (validated id -> index map, in-place replacement, scene bbox grown on insert and
recomputed lazily only when an edge item is removed).

| case | parse | scene build | first frame | pan fit avg (max) | zoom fit | pan 10x avg (max) | zoom 10x | edit 1 entity |
|------|------:|------------:|------------:|------------------:|---------:|------------------:|---------:|--------------:|
| full baseline | 4499 ms | 2761 ms | 1386 ms | 947 ms (1678) | 384 ms | 126 ms (235) | 134 ms | 164 ms |
| full after    | 1924 ms | 2003 ms | 861 ms  | 618 ms (1251) | 324 ms | 28 ms (56)   | 35 ms  | 0.7 ms |
| text baseline | -       | 189 ms  | 182 ms  | 54 ms (135)   | 25 ms  | 10 ms (31)   | 9 ms   | 10 ms |
| text after    | -       | 193 ms  | 91 ms   | 38 ms (67)    | 14 ms  | 4.6 ms (6.7) | 5.1 ms | 0.4 ms |

Parse and scene build were not changed on this branch; their difference is run-to-run variation of the container.
The fit view is still above the 300 ms target: it has not been profiled per stage after these changes; the remaining
per-frame work at fit is the line strokes of items 1-4 px long (most of the 200k LINEs and 20k ARCs) and the
rasterisation of the batched paths.
