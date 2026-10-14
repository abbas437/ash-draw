#!/bin/sh
# Cross-compile LibreDWG for Windows x64 with mingw-w64 (Ubuntu: apt-get install mingw-w64).
# usage: build-win64.sh <libredwg source dir> <build dir> <install prefix>
# Links libredwg-0.dll against the upstream zip's libiconv-2.dll through an import library
# generated from deps/libiconv-2/lib/libiconv-2.def, so the runtime DLL set matches the upstream zip.
# Generated files (import library, static libssp) go into the build dir, never into this folder.
set -eu
SRC=$(cd "$1" && pwd); mkdir -p "$2"; BUILD=$(cd "$2" && pwd); mkdir -p "$3"; PREFIX=$(cd "$3" && pwd)
HERE=$(cd "$(dirname "$0")" && pwd)
ICONV=$BUILD/deps/libiconv-2
mkdir -p "$ICONV/include" "$ICONV/lib"
cp "$HERE/deps/libiconv-2/include/iconv.h" "$ICONV/include/"
x86_64-w64-mingw32-dlltool -d "$HERE/deps/libiconv-2/lib/libiconv-2.def" -l "$ICONV/lib/libiconv.dll.a"
# -fstack-protector/_FORTIFY_SOURCE make gcc link -lssp. Upstream's MSYS2 GCC 15 has SSP in its CRT;
# Ubuntu's mingw-w64 would import libssp-0.dll instead. Put a directory holding only the static
# libssp.a first on the search path so SSP is linked in and no extra DLL is needed.
SSP=$BUILD/deps/static-ssp; mkdir -p "$SSP"
cp "$(x86_64-w64-mingw32-gcc -print-file-name=libssp.a)" "$SSP/libssp.a"
cd "$BUILD"
# Same flags as upstream's AppVeyor nightly (CFLAGS=-fstack-protector ./configure --disable-static);
# bindings/docs off (not shipped by ASH). For repeatable output: no PE link timestamp, and the
# source/build paths are mapped out of __FILE__ strings.
CFLAGS="-fstack-protector -ffile-prefix-map=$SRC=libredwg -ffile-prefix-map=$BUILD=build" \
LDFLAGS="-L$SSP -Wl,--no-insert-timestamp" "$SRC/configure" --host=x86_64-w64-mingw32 --prefix=/ \
  --disable-static --disable-bindings --disable-docs --disable-werror \
  --with-libiconv-prefix="$ICONV"
make -j"$(nproc)"
make install DESTDIR="$PREFIX"
