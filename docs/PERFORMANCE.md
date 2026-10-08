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

## Fit frame by phase (branch perf4, 2026-10-08, full case, 5-frame average)

`scripts/bench.mjs` now passes a `profile` callback to `drawScene`, which calls it after each phase; the bench flushes
the canvas (1-pixel read-back) at each call, so each phase includes its own rasterisation. The canvas clear is
counted in `query`.

| phase | what | ms |
|-------|------|---:|
| query | clear + `visibleItems` (fit: all 345k items pass the bbox test) | 83 |
| bucket | one pass sorting items into tints / dots / line batches / bars | 141 |
| tints | pattern hatches under 2 px spacing, one fill per colour | 34 |
| fills | per-item fills and patterns | 0 |
| dots | sub-pixel items as per-pixel dots, one fill per colour | 89 |
| lines | trace + stroke of the 10 per-style line batches | 333 |
| bars | text under 2 px as bars, one stroke per colour | 20 |
| text / marks | | 0 |
| total | | 700 |

The line batches (LINEs and ARCs 1-4 px on screen) are half of the fit frame, then the bucketing pass and the
grid query, which are plain JavaScript over every item.

## Bitmap reuse in the viewport (branch perf4, 2026-10-08, one full run)

`renderer/viewport.js` keeps the last model-space scene frame in an offscreen canvas and draws the overlays (grips,
preview, rubber band, snap marker, crosshair) over a copy of it. The rule (`framePlan` in `src/core/frameCache.js`,
unit-tested) is:

- content key changed (scene object or `scene.version` - every edit, layer change and file switch -, canvas
  theme, lineweight display, selection, canvas size or dpr) or `invalidate()` (web font loaded): full render;
- same view: the bitmap as is (mouse moves, tool previews no longer redraw the scene);
- during a pan gesture (middle button or space-drag): the bitmap moved by whole device pixels, and only the exposed
  strips rendered, each `drawScene` call clipped to its strip;
- during a wheel zoom: the bitmap scaled at once;
- 120 ms after the gesture ends (button released, last wheel event), a full render replaces the approximation.

Paper-space layouts are drawn as before, without the cache. The bench drives the `Viewport` itself: "perceived" is
the time to the shown frame during the gesture (30 pan steps of 25 x 10 px; 11 wheel steps x1.25 / x0.8), "settle"
the full render after it. At fit the exposed pan strips lie mostly in the drawing margin; strips over dense content
cost about as much as the 10x pan frame (~30 ms).

| case | perceived pan fit avg (max) | perceived zoom fit avg (max) | settle after pan | settle after zoom | unchanged view | drawScene pan fit avg (max), same run |
|------|----------------------------:|-----------------------------:|-----------------:|------------------:|---------------:|--------------------------------------:|
| full | 3.4 ms (8.6) | 5.8 ms (9.9) | 313 ms | 177 ms | 1.4 ms | 458 ms (1072) |
| text | 3.3 ms (9.0) | 7.4 ms (12.7) | 25 ms | 13 ms | 1.2 ms | 38 ms (75) |

Same run, full case, fit frame by phase: query 63, bucket 148, tints 40, dots 92, lines 321, bars 22 = 685 ms
(165k items drawn as dots, 162k in the 10 line batches, 13k text bars, 5k hatch tints). The settle frame is still
dominated by the line batches; next candidates are a ~1.5 px dot threshold for LINE/ARC items and skipping the
`touches` pass in `visibleItems` when the view contains the whole scene.

## Settle frame (branch settle, 2026-10-08)

Done: `visibleItems` returns `scene.items` itself when the view contains the whole scene (no per-item bbox pass,
no copy). Fit-frame `query` phase (clear + visibleItems) 35-60 ms -> 2 ms.

Full bench after it (one run; the container's timings vary by about +-40 % between runs):
fit frame by phase query 2, bucket 166, tints 42, dots 212, lines 389, bars 26 = 837 ms; settle after pan 346 ms,
after zoom 209 ms; perceived pan 5.0 ms. A second run of the same tree gave settle pan 233 ms, zoom 187 ms. The
~200 ms target is not met yet.

Measured groundwork for the line batches (full case at fit, same 10 colour groups, in-page experiment):
re-tracing the ~141k-162k path items into the context each frame costs ~105-115 ms of JavaScript, and stroking the
same geometry from a prebuilt `Path2D` costs ~25-38 ms (world coordinates relative to a local origin, drawn with
`setTransform(z, 0, 0, -z, ...)` and `lineWidth = 1 / z`; no difference against screen-space `Path2D`). Building
the `Path2D`s costs ~145-195 ms, so it pays off only when cached across frames (per zoom band, culled per tile);
miter joins / butt caps change nothing. Raising the path dot threshold to a 1.5 px bbox diagonal moves only ~20k
items from the line batches to dots (161.5k -> 141.3k lines).
