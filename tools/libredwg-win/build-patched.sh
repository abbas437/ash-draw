#!/bin/sh
# Build the patched LibreDWG Windows x64 converters that ASH Draw Studio ships.
# usage: build-patched.sh <libredwg-0.14.8597.tar.xz> <libredwg-0.14.8597-win64.zip> <work dir> <out dir>
# Both inputs are the upstream release files, SHA-256-verified by `node scripts/fetch-libredwg.mjs --source <dir>`.
# Extracts the source, applies libredwg-llp64-bitpos.patch, cross-builds with build-win64.sh and writes
# <out dir>/libredwg-0.14.8597-llp64-win64.zip (+ .sha256) with package-win64.sh.
# Needs: mingw-w64, make, patch, xz, zip, unzip (Ubuntu: apt-get install mingw-w64 zip).
set -eu
VER=0.14.8597
HERE=$(cd "$(dirname "$0")" && pwd)
TARBALL=$1; UPZIP=$2; mkdir -p "$3"; WORK=$(cd "$3" && pwd); OUT=$4
rm -rf "$WORK/src" "$WORK/build" "$WORK/inst"; mkdir -p "$WORK/src"
tar -xJf "$TARBALL" -C "$WORK/src"
SRC=$WORK/src/libredwg-$VER
patch -d "$SRC" -p1 --forward -i "$HERE/libredwg-llp64-bitpos.patch"
sh "$HERE/build-win64.sh" "$SRC" "$WORK/build" "$WORK/inst"
sh "$HERE/package-win64.sh" "$WORK/inst" "$SRC" "$UPZIP" "$OUT" "libredwg-$VER-llp64-win64"
