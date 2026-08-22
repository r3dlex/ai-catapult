#!/usr/bin/env bash
# build-opencode-plugin.sh — assembles the OpenCode payload into dist/opencode-plugin/.
#
# Output layout:
#   dist/opencode-plugin/
#     .opencode-plugin/plugin.json — manifest marker (install.js ensureBuilt seam)
#     skills/<name>/               — one dir per bundled skill copied from vendor/
#     command/<name>.md            — OpenCode slash commands rendered from the
#                                    shared schema definitions under
#                                    scripts/opencode-commands/
#
# The bundled set is every skill in the vendored catalog that supports
# opencode — derived, not listed here. See resolveBundledSkills in
# src/skill-resolver.js.
#
# Deterministic: always wipes and rebuilds dist/opencode-plugin/ for
# idempotence. Fail-closed: exits non-zero if vendor/skills is absent or the
# bundled set resolves empty, before touching dist.
#
# Accepts VENDOR_ROOT and DIST_ROOT env overrides (for tests) — default to
# <repo>/vendor and <repo>/dist.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

VENDOR_ROOT="${VENDOR_ROOT:-${REPO_ROOT}/vendor}"
VENDOR_SKILLS="${VENDOR_ROOT}/skills"
LISTER="${REPO_ROOT}/scripts/list-bundled-skills.js"
COMMAND_DEFS="${REPO_ROOT}/scripts/opencode-commands"
DIST_ROOT="${DIST_ROOT:-${REPO_ROOT}/dist}"
DIST_DIR="${DIST_ROOT}/opencode-plugin"
PLUGIN_JSON_DIR="${DIST_DIR}/.opencode-plugin"
SKILLS_DEST="${DIST_DIR}/skills"
COMMAND_DEST="${DIST_DIR}/command"

# --- Fail closed if vendor missing (before touching dist) ---
if [[ ! -d "${VENDOR_SKILLS}" ]]; then
  echo "ERROR: vendor/skills directory not found at ${VENDOR_SKILLS} >&2"
  echo "       Run setup.sh first to vendor skills." >&2
  exit 1
fi

# --- Fail closed: a failing or empty lister aborts the build ---
BUNDLED="$(node "${LISTER}" "${VENDOR_SKILLS}" opencode)"
if [[ -z "${BUNDLED}" ]]; then
  echo "ERROR: no bundled skills resolved from ${VENDOR_SKILLS} for host opencode" >&2
  exit 1
fi

BUNDLED_NAMES=()
BUNDLED_DIRS=()
while IFS=$'\t' read -r NAME DIR; do
  [[ -n "${NAME}" ]] || continue
  BUNDLED_NAMES+=("${NAME}")
  BUNDLED_DIRS+=("${DIR}")
done <<< "${BUNDLED}"

# --- Read version from package.json ---
VERSION="$(PKG="${REPO_ROOT}/package.json" node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.env.PKG,'utf8')).version)")"
if [[ -z "${VERSION}" ]]; then
  echo "ERROR: could not read version from package.json" >&2
  exit 1
fi

echo "Building OpenCode payload ai-catapult@${VERSION}..."

# --- Deterministic wipe-and-rebuild ---
rm -rf "${DIST_DIR}"
mkdir -p "${PLUGIN_JSON_DIR}" "${SKILLS_DEST}" "${COMMAND_DEST}"

# --- Skills: verbatim copy per bundled dir ---
for i in "${!BUNDLED_NAMES[@]}"; do
  NAME="${BUNDLED_NAMES[$i]}"
  DIR="${BUNDLED_DIRS[$i]}"
  cp -R "${DIR}" "${SKILLS_DEST}/${NAME}"
done

# --- Commands: render shared-schema definitions deterministically ---
RENDERED="$(CMD_SRC="${COMMAND_DEFS}" CMD_OUT="${COMMAND_DEST}" node -e "
const fs = require('fs');
const path = require('path');
const srcDir = process.env.CMD_SRC;
const outDir = process.env.CMD_OUT;
const defs = fs.readdirSync(srcDir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(srcDir, f), 'utf8')));
if (defs.length === 0) {
  process.stderr.write('ERROR: no command definitions found in ' + srcDir + '\n');
  process.exit(1);
}
for (const d of defs) {
  const md = [
    '---',
    'description: ' + d.description,
    '---',
    '',
    'Invoke the ' + d.skill + ' skill workflow with the user request below.',
    '',
    'User arguments: ' + String.fromCharCode(36) + 'ARGUMENTS',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, d.name + '.md'), md);
}
process.stdout.write(defs.map((d) => d.name).sort().join(' ') + '\n');
")"

# shellcheck disable=SC2086
read -r -a COMMAND_NAMES <<< "${RENDERED}"

# --- Manifest marker ---
MANIFEST_SKILLS="$(printf '%s\n' "${BUNDLED_NAMES[@]}" | sort | node -e "
let input='';
process.stdin.on('data',(c)=>{input+=c});
process.stdin.on('end',()=>{process.stdout.write(JSON.stringify(input.trim().split('\n')))});"
)"
MANIFEST_COMMANDS="$(CMD_SRC="${COMMAND_DEFS}" node -e "
const fs=require('fs'), path=require('path');
const defs=fs.readdirSync(process.env.CMD_SRC).filter(f=>f.endsWith('.json')).sort().map(f=>JSON.parse(fs.readFileSync(path.join(process.env.CMD_SRC,f),'utf8')).name).sort();
process.stdout.write(JSON.stringify(defs));
" )"
CMD_SRC="${COMMAND_DEFS}" node -e "
const fs = require('fs');
const manifest = {
  name: 'ai-catapult',
  version: '${VERSION}',
  description: 'AI-SDLC governance scaffolding payload for OpenCode: bundled skills plus generated slash commands.',
  interface: { displayName: 'ai-catapult (OpenCode)' },
  skills: ${MANIFEST_SKILLS},
  commands: ${MANIFEST_COMMANDS},
};
fs.writeFileSync('${PLUGIN_JSON_DIR}/plugin.json', JSON.stringify(manifest, null, 2) + '\n');
"

# --- Validate ---
node -e "JSON.parse(require('fs').readFileSync('${PLUGIN_JSON_DIR}/plugin.json','utf8'))" \
  || { echo "ERROR: plugin.json is not valid JSON" >&2; exit 1; }

node -e "
  const p = JSON.parse(require('fs').readFileSync('${PLUGIN_JSON_DIR}/plugin.json','utf8'));
  const required = ['name','version','description','skills','commands'];
  for (const f of required) {
    if (!p[f]) { process.stderr.write('ERROR: plugin.json missing required field: ' + f + '\n'); process.exit(1); }
  }
"

for NAME in "${BUNDLED_NAMES[@]}"; do
  if [[ ! -f "${SKILLS_DEST}/${NAME}/SKILL.md" ]]; then
    echo "ERROR: skills/${NAME}/SKILL.md not present in output" >&2
    exit 1
  fi
done

echo "OK: dist/opencode-plugin assembled"
echo "  .opencode-plugin/plugin.json"
echo "  skills/ (${#BUNDLED_NAMES[@]} skills)"
echo "  command/ (${#COMMAND_NAMES[@]} commands)"
