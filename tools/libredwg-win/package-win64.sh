#!/bin/sh
# Package an install tree from build-win64.sh in the upstream libredwg-<ver>-win64.zip layout
# (executables and DLLs at the zip root, plus include/ lib/ share/ README.txt).
# usage: package-win64.sh <install prefix> <libredwg source dir> <upstream win64 zip> <out dir> <name>
# libiconv-2.dll is taken unmodified from the upstream zip (libredwg-0.dll imports it).
# The patch is packed too: scripts/fetch-libredwg.mjs accepts a non-upstream zip only when its
# libredwg-llp64-bitpos.patch is byte-identical to the one in this folder.
set -eu
INST=$(cd "$1" && pwd); SRC=$(cd "$2" && pwd); UPZIP=$(cd "$(dirname "$3")" && pwd)/$(basename "$3")
mkdir -p "$4"; OUT=$(cd "$4" && pwd); NAME=$5
HERE=$(cd "$(dirname "$0")" && pwd)
STAGE=$OUT/$NAME; rm -rf "$STAGE" "$OUT/$NAME.zip"; mkdir -p "$STAGE"
cp "$INST"/bin/* "$STAGE"/
cp -r "$INST/include" "$INST/lib" "$INST/share" "$STAGE"/
unzip -q -j -o "$UPZIP" libiconv-2.dll -d "$STAGE"
cp "$SRC/README" "$STAGE/README.txt"; cp "$SRC/COPYING" "$STAGE/COPYING"
cp "$HERE/libredwg-llp64-bitpos.patch" "$STAGE"/
# Fixed mtimes, sorted entries, no extra attributes: the zip depends only on the file contents.
(cd "$STAGE" && TZ=UTC find . -exec touch -d 2026-09-10T00:00:00 {} + && find . -type f | LC_ALL=C sort | sed 's|^\./||' | TZ=UTC zip -X -q "$OUT/$NAME.zip" -@)
(cd "$OUT" && sha256sum "$NAME.zip" > "$NAME.zip.sha256" && cat "$NAME.zip.sha256")
