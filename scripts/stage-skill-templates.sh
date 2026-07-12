#!/usr/bin/env bash
# stage-skill-templates.sh — copy vendored ai-catapult-init templates into
# dist/skill-templates/ so they ship in the npm tarball.
#
# This is a packaged copy of the catalog-resolved SSOT templates for `ai-catapult init` when vendor/ is absent
# (i.e. when the package is installed via npx rather than cloned from source).
#
# Resolution order in bin/ai-catapult.js:
#   1. catalog-resolved vendored templates          (dev checkout)
#   2. dist/skill-templates/                        (published package — this dir)
#
# Run by: npm run prepack (after build-claude-plugin.sh and build-codex-plugin.sh)
# Also called by: npm run pretest (via snapshot-dist.sh which copies dist/)
#
# Usage:
#   bash scripts/stage-skill-templates.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

VENDOR_ROOT="${VENDOR_ROOT:-${REPO_ROOT}/vendor}"
VENDOR_SKILLS="${VENDOR_ROOT}/skills"
SKILL_SRC="$(node "${REPO_ROOT}/scripts/resolve-vendor-skill.js" "${VENDOR_SKILLS}" ai-catapult-init)"
SRC="${SKILL_SRC}/templates"
DEST="${REPO_ROOT}/dist/skill-templates"

if [[ ! -d "${SRC}" ]]; then
  echo "ERROR: resolved ai-catapult-init templates not found at ${SRC}" >&2
  echo "       Run bash setup.sh to populate vendor/ first." >&2
  exit 1
fi

rm -rf "${DEST}"
cp -R "${SRC}" "${DEST}"

echo "OK: dist/skill-templates/ staged from resolved ai-catapult-init/templates/"
echo "    $(find "${DEST}" -type f | wc -l | tr -d ' ') files"
