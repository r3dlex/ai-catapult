#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${ROOT}/vendor/skills/scripts/matrix-contract.py"
DEST="${ROOT}/dist/matrix-runtime.py"
[[ -f "${SRC}" ]] || { echo "ERROR: missing ${SRC}; run bash setup.sh" >&2; exit 1; }
mkdir -p "$(dirname "${DEST}")"
cp "${SRC}" "${DEST}"
chmod 755 "${DEST}"
echo "OK: staged matrix runtime"
