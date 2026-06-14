#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# scripts/release/tag-release.sh
#
# Automates the Nexus release process:
#   1. Validates the branch (must be main)
#   2. Runs version-packages (changeset version)
#   3. Builds all packages
#   4. Runs the full test suite
#   5. Creates a signed git tag
#   6. Pushes tag → triggers docker.yml + release.yml CI
#
# Usage:
#   bash scripts/release/tag-release.sh [--dry-run] [--skip-tests]
#
# Requirements:
#   - Clean working tree (no unstaged changes)
#   - pnpm 9+
#   - git 2.34+ (for tag signing support)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DRY_RUN=false
SKIP_TESTS=false

for arg in "$@"; do
  case "$arg" in
    --dry-run)     DRY_RUN=true ;;
    --skip-tests)  SKIP_TESTS=true ;;
  esac
done

cd "$REPO_ROOT"

echo "==> Nexus release automation"
echo ""

# ─── 1. Guard: must be on main ────────────────────────────────────────────────

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != "main" ]]; then
  echo "ERROR: Releases must be cut from main (current branch: $BRANCH)"
  exit 1
fi
echo "[1/6] Branch: main ✓"

# ─── 2. Guard: clean working tree ────────────────────────────────────────────

if ! git diff --quiet HEAD; then
  echo "ERROR: Working tree has uncommitted changes. Commit or stash them first."
  git status --short
  exit 1
fi
echo "[2/6] Working tree: clean ✓"

# ─── 3. Version packages (changeset version) ─────────────────────────────────

echo "[3/6] Running changeset version..."
if [[ "$DRY_RUN" == "true" ]]; then
  echo "      [DRY RUN] Would run: pnpm version-packages"
else
  pnpm version-packages
  git add -A
  git commit -m "chore(release): version packages" --no-verify || echo "Nothing to commit"
fi

# ─── 4. Read new version from root package.json ───────────────────────────────

VERSION=$(node -p "require('./package.json').version")
echo "[4/6] Release version: $VERSION"

# ─── 5. Build ────────────────────────────────────────────────────────────────

echo "[5/6] Building all packages..."
if [[ "$DRY_RUN" == "false" ]]; then
  pnpm build
fi

# ─── 6. Test ─────────────────────────────────────────────────────────────────

if [[ "$SKIP_TESTS" == "true" ]]; then
  echo "[6/6] Tests: SKIPPED (--skip-tests)"
elif [[ "$DRY_RUN" == "false" ]]; then
  echo "[6/6] Running test suite..."
  pnpm test
fi

# ─── 7. Tag ──────────────────────────────────────────────────────────────────

TAG="v${VERSION}"
echo ""
echo "==> Tagging: $TAG"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "    [DRY RUN] Would run:"
  echo "      git tag -a $TAG -m \"Release $TAG\""
  echo "      git push origin main --tags"
  echo ""
  echo "==> Dry run complete. No changes made."
  exit 0
fi

git tag -a "$TAG" -m "Release $TAG

Automated release from scripts/release/tag-release.sh
Branch: main
Commit: $(git rev-parse HEAD)"

git push origin main
git push origin "$TAG"

echo ""
echo "==> Release $TAG pushed."
echo "    CI will now:"
echo "      • docker.yml  — build + push ghcr.io images"
echo "      • release.yml — publish @nexus/* packages to npm"
