#!/usr/bin/env bash
# snapshot-dist.sh — copy dist/ to dist-snapshot/ for stable test isolation.
#
# The install command respects AI_CATAPULT_DIST_ROOT; npm test sets it to
# dist-snapshot/ so install tests (and the finish-prompt drift-guard) always
# read from a stable snapshot rather than the live dist/ that claude-plugin
# tests wipe and rebuild concurrently.
#
# Run by: npm run pretest (before node --test)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SRC="${REPO_ROOT}/dist"
DEST="${REPO_ROOT}/dist-snapshot"

if [[ ! -d "${SRC}" ]]; then
  echo "ERROR: dist/ not found at ${SRC} — run build scripts first" >&2
  exit 1
fi

rm -rf "${DEST}"
cp -R "${SRC}" "${DEST}"
echo "OK: dist-snapshot/ created from dist/"
