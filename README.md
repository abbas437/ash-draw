# ASH Draw Studio

A free, MIT-licensed drawing viewer and editor for Windows that opens, edits and saves
DXF drawings, with DWG file support through the separately bundled LibreDWG converters.
Built with Electron by ASH Technical & Project Management Services (ASH PMCS).

## Features

- **Open** DXF (ASCII) and DWG drawings; drag-and-drop, File > Open, or "Open with" from Explorer.
- **View**: pan and zoom around the drawing.
- **Edit** existing entities and create new ones.
- **Layers** panel.
- **Object snaps** for precise drawing.
- **Draw and modify tools** for everyday 2D drafting.
- **Export** to PDF, SVG, PNG, DXF and DWG (DWG output in R2000 or R14 format).

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

`npm run dist` runs `scripts/fetch-libredwg.mjs`, which downloads the official LibreDWG 0.13.3
Windows x64 archive, refuses it unless its SHA-256 matches the pinned value, and extracts only
`dwg2dxf.exe`, `dxf2dwg.exe` and `libredwg-0.dll` into `build/libredwg/` together with the GPL
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
| `print()` | Print the current view. |
| `setTitle(title)` | Set the window title. |
| `showItem(path)` | Show a granted file in Explorer. |
| `settingsGet(key)` / `settingsSet(key, value)` | Read / write a persisted setting. |
| `dwgAvailable()` | Whether the LibreDWG converters are present and usable. |
| `dwgToDxf(bytes)` | Convert DWG bytes to DXF via `dwg2dxf.exe`. |
| `dxfToDwg(dxfBytes, version)` | Convert DXF bytes to DWG via `dxf2dwg.exe`; `version` is `'r2000'` or `'r14'`. |

## Licence

ASH Draw Studio is free software under the MIT licence (see `LICENSE`).
Copyright (c) 2026 ASH Technical & Project Management Services (ASH PMCS).

Third-party components are listed with their licence texts in `THIRD-PARTY-NOTICES.md`
(shipped in the installation's `resources` folder). npm runtime dependencies are MIT
(pdf-lib, @pdf-lib/fontkit; pako is MIT AND Zlib). Electron is MIT; its Chromium
notices ship as `LICENSES.chromium.html` in the installation folder.

**LibreDWG.** DWG support uses GNU LibreDWG 0.13.3 (libredwg), which is licensed under the
GPL-3.0-or-later. ASH Draw Studio does not link to or load LibreDWG: the unmodified upstream
programs `dwg2dxf.exe` and `dxf2dwg.exe` (with `libredwg-0.dll`) are shipped in
`resources/libredwg/` and started as separate processes (`execFile`, no shell) that convert
through temporary files. They keep their own licence; the GPL text is in
`resources/libredwg/COPYING`. The complete corresponding source is the LibreDWG 0.13.3
release, available from https://github.com/LibreDWG/libredwg/releases/tag/0.13.3 and
https://ftp.gnu.org/gnu/libredwg/libredwg-0.13.3.tar.xz, and the same tarball
(`libredwg-0.13.3.tar.xz`) is attached to every ASH Draw Studio GitHub Release.
`resources/libredwg/README-SOURCE.txt` contains a written offer for the source.
GPL source offer contact: https://github.com/abbas437/ash-draw/issues

DWG is used here only as the descriptive name of a file format. ASH Draw Studio is not
affiliated with or endorsed by Autodesk. See `docs/COPYRIGHT-REVIEW.md`.

## Limitations

- **DWG writing** is limited to the R2000 and R14 formats that LibreDWG can write.
- **DWG reading** quality depends on LibreDWG; newer proprietary objects and proxy entities
  are not shown.
- **Autodesk SHX fonts are not available**; text is drawn with system fonts, so spacing and
  appearance may differ from the original.
- **3D solids** (ACIS bodies and similar) are not displayed.
- **Binary DXF** is not supported; save as ASCII DXF.
- **Unsigned executables**: Windows SmartScreen warns on first run (see above).

## Support

Bug reports, questions and requests (including the GPL source offer): https://github.com/abbas437/ash-draw/issues
