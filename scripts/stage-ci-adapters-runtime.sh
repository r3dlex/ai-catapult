#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_SKILLS="${AI_CATAPULT_VENDOR_SKILLS:-${ROOT}/vendor/skills}"
RUNTIME_SRC="${VENDOR_SKILLS}/scripts/render-ci-adapters.py"
TEMPLATES_SRC="${VENDOR_SKILLS}/03-configure-generate/ai-catapult-init/templates/ci"
RUNTIME_DEST="${ROOT}/dist/scripts/render-ci-adapters.py"
TEMPLATES_DEST="${ROOT}/dist/03-configure-generate/ai-catapult-init/templates/ci"

[[ -f "${RUNTIME_SRC}" ]] || { echo "ERROR: missing ${RUNTIME_SRC}; run bash setup.sh" >&2; exit 1; }
[[ -d "${TEMPLATES_SRC}" ]] || { echo "ERROR: missing ${TEMPLATES_SRC}; run bash setup.sh" >&2; exit 1; }

mkdir -p "$(dirname "${RUNTIME_DEST}")" "$(dirname "${TEMPLATES_DEST}")"
rm -rf "${TEMPLATES_DEST}"
cp "${RUNTIME_SRC}" "${RUNTIME_DEST}"
cp -R "${TEMPLATES_SRC}" "${TEMPLATES_DEST}"
chmod 755 "${RUNTIME_DEST}"
echo "OK: staged CI adapter runtime and canonical templates"
