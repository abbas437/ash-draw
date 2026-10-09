# ASH Draw Studio

A free, MIT-licensed drawing viewer and editor for Windows that opens, edits and saves
DXF drawings, with DWG file support through the separately bundled LibreDWG converters.
Built with Electron by ASH Technical & Project Management Services (ASH PMCS).

## Features

- **Open** DXF (ASCII, R12 to R2018) and DWG drawings; drag-and-drop, File > Open, or "Open with" from Explorer.
- **View**: wheel zoom, middle-mouse or Space + drag to pan, zoom to fit, light theme by default with an optional dark theme (View > Dark theme, remembered), the drawing background follows the theme and can be switched on its own, optional lineweights.
  Layers, colours (ACI and true colour), linetypes, blocks and block arrays, hatches (solid and common patterns), text and
  multiline text, splines, ellipses, dimensions (as drawn) and leaders are displayed.
- **Draw**: line, polyline, rectangle, circle, arc (3 points), ellipse, point, text, hatch (click inside a closed shape).
- **Modify**: move, copy, rotate, scale, mirror, offset, trim, extend, explode, erase; copy/paste; unlimited undo and redo.
- **Precision**: object snaps (endpoint, intersection, midpoint, centre, quadrant, node, insertion, perpendicular),
  ortho and polar tracking, and an AutoCAD-style command line (`L`, `PL`, `C`, `M`, `CO`, `RO`, `TR` ... and typed
  coordinates such as `10,20`, `@5,0`, `@10<45`).
- **Layers and properties** panels, including layer on/off and lock, colour, linetype and lineweight; measure tool.
- **Save and convert**: DXF (R2000, lossless for everything the program supports), DWG (experimental, verified after saving),
  and export to PDF (vector), SVG and PNG.

## Download and install

Windows 10 or 11, 64-bit (x64). Each release provides two builds:

| File | Use |
|---|---|
| `ASH-Draw-Studio-Setup-<version>.exe` | Installer (per-user, no admin rights needed). Adds Start menu/desktop shortcuts and registers ASH Draw Studio as an available "Open with" program for `.dxf` and `.dwg`. It never makes itself the default program silently; choose that yourself in Settings > Apps > Default apps. |
| `ASH-Draw-Studio-Portable-<version>.exe` | Portable build: runs without installing and keeps its settings next to the .exe. No file-type registration. |

`SHA256SUMS.txt` on each release lists the SHA-256 of both executables.

The executables are not code-signed yet, so Windows SmartScreen shows a warning
("Windows protected your PC") on first run. Check the SHA-256 against `SHA256SUMS.txt`,
then choose **More info > Run anyway**.

## Build from source

Requirements: Node.js 22 or later and npm. Building the Windows installer requires Windows
(or a CI runner such as `windows-latest`).

```sh
npm ci
npm start               # run the app in development
npm test                # unit tests (test/**)
npm run test:electron   # main-process tests (electron/**/*.test.mjs)
npm run dist            # fetch + verify LibreDWG, vendor, notices, build Setup + Portable .exe into dist/
```

`npm run dist` runs `scripts/fetch-libredwg.mjs`, which downloads the official LibreDWG 0.14.8597
Windows x64 archive, refuses it unless its SHA-256 matches the pinned value, and extracts only
`dwg2dxf.exe`, `dxf2dwg.exe`, `libredwg-0.dll` and `libiconv-2.dll` into `build/libredwg/` together with the GPL
text (`COPYING`) and `README-SOURCE.txt`. `node scripts/fetch-libredwg.mjs --source <dir>`
additionally downloads and verifies the LibreDWG source tarball. `npm run licenses` regenerates
`THIRD-PARTY-NOTICES.md` and fails if an npm production dependency has a non-permissive licence.
`npm run icon` regenerates `build/icon.png` (original artwork).

### Releases

Releases are built by GitHub Actions (`.github/workflows/build.yml`): every push to `main`
builds and tests on `windows-latest` and uploads the two .exe files, `SHA256SUMS.txt` and the
LibreDWG source tarball as workflow artifacts; pushing a tag `v*` additionally creates a GitHub
Release with those files attached. A separate `ubuntu-latest` job runs the unit tests.

## The `window.api` contract

The renderer runs sandboxed with context isolation and no Node.js access. Everything it may
do outside the page goes through `window.api`, exposed by `electron/preload.js`. All methods
except `isElectron` and `onOpenFile` return Promises. File reads and writes are limited to
paths the user chose in a dialog or passed on the command line during this session.

| Member | Purpose |
|---|---|
| `isElectron` | `true` when running inside the desktop app. |
| `version()` | Application version. |
| `openFiles(opts)` | Show the Open dialog (optional filters); returns the chosen files. |
| `readFile(path)` | Read a granted file's bytes. |
| `saveFile(opts)` | Show the Save dialog (default path, filters); returns the chosen path. |
| `writeFile(path, bytes)` | Write bytes to a granted path. |
| `getLaunchFiles()` | Files passed on the command line / "Open with" at start-up. |
| `onOpenFile(cb)` | Subscribe to files opened later (second instance); returns an unsubscribe function. |
| `print(pdfBytes)` | Print a PDF (a plot) through the system print dialog; the app window itself is never printed. |
| `setTitle(title)` | Set the window title. |
| `showItem(path)` | Show a granted file in Explorer. |
| `settingsGet(key)` / `settingsSet(key, value)` | Read / write a persisted setting. |
| `sessionUpdate({files, active})` | Report the open drawings' paths; main keeps only granted paths and adds new ones to the recent list. |
| `sessionInfo()` / `sessionRestore()` / `sessionDismiss()` | Start-up mode (`startup.mode`: `ask`, `restore`, `new`) and the offer to reopen the last session; reopen it (`{files, active, missing}`) or decline. |
| `recentList()` / `recentOpen(path)` / `recentClear()` | The last 15 files (`exists` per entry); reopen one (null when it no longer exists); clear the list. |
| `dwgAvailable()` | Whether the LibreDWG converters are present and usable. |
| `dwgToDxf(bytes)` | Convert DWG bytes to DXF via `dwg2dxf.exe`. |
| `dwgOpen(pathOrBytes)` | Open a DWG: main converts it (from a granted path, or from bytes) and returns `{url, size, warnings, engine}`; the DXF reader worker fetches the one-time `app://drawstudio/_open/<token>` URL, so the DXF is not cloned through IPC on the window thread. |
| `dxfToDwg(dxfBytes, version)` | Convert DXF bytes to DWG via `dxf2dwg.exe`; `version` is `'r2000'` or `'r14'`. |

## Licence

ASH Draw Studio is free software under the MIT licence (see `LICENSE`).
Copyright (c) 2026 ASH Technical & Project Management Services (ASH PMCS).

Third-party components are listed with their licence texts in `THIRD-PARTY-NOTICES.md`
(shipped in the installation's `resources` folder). npm runtime dependencies are MIT
(pdf-lib, @pdf-lib/fontkit; pako is MIT AND Zlib). Electron is MIT; its Chromium
notices ship as `LICENSES.chromium.html` in the installation folder.

**LibreDWG.** DWG support uses GNU LibreDWG 0.14.8597 (libredwg), which is licensed under the
GPL-3.0-or-later. ASH Draw Studio does not link to or load LibreDWG: the unmodified upstream
programs `dwg2dxf.exe` and `dxf2dwg.exe` (with `libredwg-0.dll` and GNU libiconv's LGPL `libiconv-2.dll`) are shipped in
`resources/libredwg/` and started as separate processes (`execFile`, no shell) that convert
through temporary files. They keep their own licence; the GPL text is in
`resources/libredwg/COPYING`. The complete corresponding source is the LibreDWG 0.14.8597
release, available from https://github.com/LibreDWG/libredwg/releases/tag/0.14.8597 and
https://github.com/LibreDWG/libredwg/releases/download/0.14.8597/libredwg-0.14.8597.tar.xz, and the same tarball
(`libredwg-0.14.8597.tar.xz`) is attached to every ASH Draw Studio GitHub Release.
`resources/libredwg/README-SOURCE.txt` contains a written offer for the source.
GPL source offer contact: https://github.com/abbas437/ash-draw/issues

DWG is used here only as the descriptive name of a file format. ASH Draw Studio is not
affiliated with or endorsed by Autodesk. See `docs/COPYRIGHT-REVIEW.md`.

## Limitations

Please read these before relying on the program for important work.

- **Model space only.** Paper-space layouts and viewports are ignored (the count is reported when a file is opened).
- **Unsupported objects are skipped and reported on opening**: 3D solids, regions, 3D faces, xlines/rays, multilines,
  multileaders, tolerances, images and OLE objects. Attributes become plain text.
- **Dimensions** are displayed from their stored drawing and can be moved, copied and exploded, but not edited as dimensions.
- **DWG reading** quality depends on LibreDWG; newer proprietary objects and proxy entities are not shown.
- **DWG saving is experimental.** DWG is written through LibreDWG's DXF import, which can lose text rotation, width factor and
  alignment and some hatch edges. The program reads the saved DWG back, compares it with your drawing and warns about
  differences. DXF is the reliable format. Only the R2000 and R14 DWG formats can be written.
- **Autodesk SHX fonts are not available**; text is drawn with system fonts, so spacing and appearance differ from the original.
- **PDF export** draws text in Western Latin characters only (no Arabic or other scripts yet); everything else is vector.
- **Binary DXF** is not supported; save as ASCII DXF.
- **Unsigned executables**: Windows SmartScreen warns on first run (see above).

Developer documentation of the drawing engine: `docs/CORE-API.md`. Tests: `npm test` (unit), `npm run test:e2e`
(headless browser UI test; needs Chromium and `node scripts/vendor.js`), and `test/e2e/electron.mjs` (the real desktop app,
needs a display).

## Support

Bug reports, questions and requests (including the GPL source offer): https://github.com/abbas437/ash-draw/issues

The ASH logo and icon are trademarks of ASH Technical & Project Management Services and are not covered by the MIT licence of this repository. You may not use them for other products.
