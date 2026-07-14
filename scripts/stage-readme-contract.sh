#!/usr/bin/env bash
# Stage the pinned README generator and template for the published CLI.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
VENDOR_ROOT="${VENDOR_ROOT:-${REPO_ROOT}/vendor}"
VENDOR_SKILLS="${VENDOR_ROOT}/skills"
SKILL_SRC="$(node "${REPO_ROOT}/scripts/resolve-vendor-skill.js" "${VENDOR_SKILLS}" ai-catapult-init)"
DEST="${REPO_ROOT}/dist/readme-contract"

GENERATOR="${SKILL_SRC}/scripts/readme-generate.sh"
TEMPLATE="${SKILL_SRC}/assets/readme/template.md"

if [[ ! -f "${GENERATOR}" || ! -f "${TEMPLATE}" ]]; then
  echo "ERROR: pinned canonical README contract is incomplete" >&2
  echo "       expected ${GENERATOR}" >&2
  echo "       expected ${TEMPLATE}" >&2
  exit 1
fi

rm -rf "${DEST}"
mkdir -p "${DEST}/scripts" "${DEST}/assets/readme"
cp "${GENERATOR}" "${DEST}/scripts/readme-generate.sh"
cp "${TEMPLATE}" "${DEST}/assets/readme/template.md"
chmod 755 "${DEST}/scripts/readme-generate.sh"

echo "OK: dist/readme-contract/ staged from the pinned ai-catapult-init skill"
