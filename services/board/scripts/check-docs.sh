#!/usr/bin/env bash
# Verify the documentation layout: one docs folder, every markdown link resolves,
# the index covers every file in docs/, and nothing still points at the old root
# paths of documents that moved.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

fail=0
links=0
files=0

link_targets() {
  perl -ne '
    while (/\]\(\s*<([^>]+)>\s*\)/g) { print "$1\n" }
    while (/\]\(\s*([^)\s]+)\s*\)/g)   { print "$1\n" }
    while (/^\s*\[[^\]]+\]:\s*(\S+)/)  { print "$1\n" }
  ' "$1"
}

resolve() {
  local file="$1" link="$2" target dir decoded
  case "$link" in
    http://*|https://*|mailto:*|'#'*|'') return 0 ;;
  esac
  target="${link%%#*}"
  [ -z "$target" ] && return 0
  dir="$(dirname "$file")"
  decoded="$(perl -MURI::Escape -e 'print uri_unescape($ARGV[0])' "$target" 2>/dev/null || printf '%s' "$target")"
  if [ -e "$dir/$target" ] || [ -e "$dir/$decoded" ]; then
    printf '%s\n' "$dir/$decoded"
    return 0
  fi
  return 1
}

# 1. Project markdown lives in docs/; the root keeps only README.md.
stray="$(find . -maxdepth 1 -type f \( -name '*.md' -o -name '*.txt' \) -not -name 'README.md' -print)"
if [ -n "$stray" ]; then
  echo "FAIL  project documents outside docs/:"
  echo "$stray"
  fail=1
fi

# 2. Every relative link and reference definition resolves.
mapfile -t md < <(find . -name '*.md' -not -path './board/*' -not -path './sources/*' -not -path './.git/*' -not -path './.freebuff/*' | sort)
for file in "${md[@]}"; do
  files=$((files + 1))
  while IFS= read -r link; do
    [ -z "$link" ] && continue
    links=$((links + 1))
    if ! resolve "$file" "$link" >/dev/null; then
      echo "FAIL  $file -> $link"
      fail=1
    fi
  done < <(link_targets "$file")
done
echo "checked $links links in $files markdown files"

# 3. docs/README.md indexes every file that is actually in docs/.
indexed="$(link_targets docs/README.md | while IFS= read -r link; do resolve docs/README.md "$link" || true; done | sort -u)"
missing=0
while IFS= read -r doc; do
  if ! printf '%s\n' "$indexed" | grep -qxF "$doc"; then
    echo "FAIL  docs/README.md does not index $doc"
    missing=1
    fail=1
  fi
done < <(find docs -maxdepth 1 -type f -printf '%p\n' | sort)
[ "$missing" = "0" ] && echo "index covers $(find docs -maxdepth 1 -type f | wc -l | tr -d ' ') files in docs/"

# 4. No code, script or root README still refers to a document's old root path.
stale="$(grep -nE --exclude=check-docs.sh '(^|[^/[:alnum:]_.-])(ARCHITECTURE\.md|PLAN\.md|mission\.txt|SRS_Agent_Board_v[0-9.]+\.md|SRS Agent Board)' \
  README.md scripts/*.sh $(find cmd pkg -name '*.go') 2>/dev/null || true)"
if [ -n "$stale" ]; then
  echo "FAIL  stale root-path references:"
  echo "$stale"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "DOC CHECK FAILED"
  exit 1
fi
echo "DOC CHECK PASS"
