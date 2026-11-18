#!/usr/bin/env bash
# Run Go's race detector on Windows with the Zig toolchain.
#
# Go's Windows race runtime needs two things this host's zig cc does not supply:
#   1. WaitOnAddress/WakeByAddress* imports (tools/tsan_shim.c resolves them at
#      run time), and
#   2. a load address low enough for TSan's shadow map, which high-entropy ASLR
#      breaks on Windows 11 (-Wl,--no-dynamicbase).
#
# Usage: bash scripts/race-windows.sh [packages...]   (default: ./...)
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
command -v zig >/dev/null 2>&1 || { echo "race-windows: zig is not on PATH" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

zig cc -target x86_64-windows-gnu -c "$root/tools/tsan_shim.c" -o "$tmp/tsan_shim.o"
shim="$tmp/tsan_shim.o"
if command -v cygpath >/dev/null 2>&1; then
  shim="$(cygpath -m "$shim")"
fi

cd "$root"
packages=("$@")
if [ ${#packages[@]} -eq 0 ]; then
  packages=(./...)
fi
CC="zig cc" CGO_ENABLED=1 CGO_LDFLAGS="-Wl,--no-dynamicbase $shim" \
  go test -race -count=1 "${packages[@]}"
