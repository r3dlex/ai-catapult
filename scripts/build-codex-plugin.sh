#!/usr/bin/env bash
# build-codex-plugin.sh — assembles the Codex plugin into dist/codex-plugin/.
#
# Output layout:
#   dist/codex-plugin/
#     .codex-plugin/plugin.json   — plugin manifest
#     skills/ai-catapult-init/    — bundled skill copied from vendor/
#
# Deterministic: always wipes and rebuilds dist/codex-plugin/ for idempotence.
# Fail-closed: exits non-zero if vendor/skills is absent or incomplete.
#
# Accepts VENDOR_ROOT env override (for tests) — defaults to <repo>/vendor.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

VENDOR_ROOT="${VENDOR_ROOT:-${REPO_ROOT}/vendor}"
VENDOR_SKILLS="${VENDOR_ROOT}/skills"
SKILL_NAME="ai-catapult-init"
RESOLVER="${REPO_ROOT}/scripts/resolve-vendor-skill.js"
DIST_ROOT="${DIST_ROOT:-${REPO_ROOT}/dist}"
DIST_DIR="${DIST_ROOT}/codex-plugin"
PLUGIN_JSON_DIR="${DIST_DIR}/.codex-plugin"
SKILLS_DEST="${DIST_DIR}/skills"

# --- Fail closed if vendor missing ---
if [[ ! -d "${VENDOR_SKILLS}" ]]; then
  echo "ERROR: vendor/skills directory not found at ${VENDOR_SKILLS}" >&2
  echo "       Run setup.sh first to vendor skills." >&2
  exit 1
fi

SKILL_SRC="$(node "${RESOLVER}" "${VENDOR_SKILLS}" "${SKILL_NAME}")"

# --- Read version from package.json (node already required by project) ---
VERSION="$(PKG="${REPO_ROOT}/package.json" node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.env.PKG,'utf8')).version)")"
if [[ -z "${VERSION}" ]]; then
  echo "ERROR: could not read version from package.json" >&2
  exit 1
fi

echo "Building Codex plugin ai-catapult@${VERSION}..."

# --- Wipe + recreate output dirs for determinism ---
rm -rf "${DIST_DIR}"
mkdir -p "${PLUGIN_JSON_DIR}"
mkdir -p "${SKILLS_DEST}"

# --- Write plugin.json ---
cat > "${PLUGIN_JSON_DIR}/plugin.json" <<PLUGIN_JSON
{
  "name": "ai-catapult",
  "version": "${VERSION}",
  "description": "CLI + Claude Code and Codex plugins for init-ai-repo v3 AI-SDLC governance scaffolding",
  "skills": "./skills/",
  "interface": {
    "displayName": "ai-catapult",
    "shortDescription": "Scaffold init-ai-repo v3 AI-SDLC governance structure in any repo.",
    "category": "Developer Tools"
  }
}
PLUGIN_JSON

# --- Copy vendored skill ---
cp -r "${SKILL_SRC}" "${SKILLS_DEST}/${SKILL_NAME}"
if [[ -f "${VENDOR_SKILLS}/scripts/matrix-contract.py" ]]; then
  mkdir -p "${DIST_DIR}/scripts"
  cp "${VENDOR_SKILLS}/scripts/matrix-contract.py" "${DIST_DIR}/scripts/matrix-contract.py"
  chmod 755 "${DIST_DIR}/scripts/matrix-contract.py"
fi
if [[ -f "${VENDOR_SKILLS}/scripts/render-ci-adapters.py" ]]; then
  mkdir -p "${DIST_DIR}/scripts" "${DIST_DIR}/03-configure-generate/ai-catapult-init/templates"
  cp "${VENDOR_SKILLS}/scripts/render-ci-adapters.py" "${DIST_DIR}/scripts/render-ci-adapters.py"
  cp -R "${VENDOR_SKILLS}/03-configure-generate/ai-catapult-init/templates/ci" \
    "${DIST_DIR}/03-configure-generate/ai-catapult-init/templates/ci"
  chmod 755 "${DIST_DIR}/scripts/render-ci-adapters.py"
fi

# --- Validate output ---
if [[ ! -f "${PLUGIN_JSON_DIR}/plugin.json" ]]; then
  echo "ERROR: plugin.json was not written" >&2
  exit 1
fi

# Validate JSON parses
node -e "JSON.parse(require('fs').readFileSync('${PLUGIN_JSON_DIR}/plugin.json','utf8'))" \
  || { echo "ERROR: plugin.json is not valid JSON" >&2; exit 1; }

# Validate required fields
node -e "
  const p = JSON.parse(require('fs').readFileSync('${PLUGIN_JSON_DIR}/plugin.json','utf8'));
  const required = ['name','version','description','skills','interface'];
  for (const f of required) {
    if (!p[f]) { process.stderr.write('ERROR: plugin.json missing required field: ' + f + '\n'); process.exit(1); }
  }
  if (!p.interface.displayName) { process.stderr.write('ERROR: plugin.json interface.displayName missing\n'); process.exit(1); }
"

if [[ ! -d "${SKILLS_DEST}/${SKILL_NAME}" ]]; then
  echo "ERROR: skills/${SKILL_NAME} directory not present in output" >&2
  exit 1
fi

if [[ ! -f "${SKILLS_DEST}/${SKILL_NAME}/SKILL.md" ]]; then
  echo "ERROR: skills/${SKILL_NAME}/SKILL.md not present in output" >&2
  exit 1
fi

echo "OK: dist/codex-plugin assembled"
echo "  .codex-plugin/plugin.json"
echo "  skills/${SKILL_NAME}/SKILL.md"
