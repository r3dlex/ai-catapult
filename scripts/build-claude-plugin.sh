#!/usr/bin/env bash
# build-claude-plugin.sh — assemble the ai-catapult Claude Code plugin into dist/claude-plugin/.
#
# Output layout (per Claude Code plugin contract):
#   dist/claude-plugin/            ← PLUGIN ROOT (paths in plugin.json resolve from here)
#     .claude-plugin/
#       plugin.json        (manifest: name, version, description, author, skills)
#       marketplace.json   (marketplace entry with $schema)
#     skills/
#       <name>/            (one flat copy per catalog-resolved vendored skill)
#
# The bundled set is every skill in the vendored catalog that supports Claude
# Code — derived, not listed here, so upstream additions ship on the next lock
# bump. See resolveBundledSkills in src/skill-resolver.js.
#
# .claude-plugin/ holds ONLY manifests. All skill paths in plugin.json are
# relative to the plugin root (dist/claude-plugin/), NOT to .claude-plugin/.
# So "./skills/ai-catapult-init/" resolves to dist/claude-plugin/skills/ai-catapult-init/.
#
# Nothing assembled here is committed (dist/ is gitignored, decision 7).
# Deterministic: version is read from package.json, no timestamps embedded.
# Fail-closed: exits non-zero if vendor/ is missing (run setup.sh first).
#
# Usage:
#   bash scripts/build-claude-plugin.sh
#
# npm script: build:plugin:claude

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

PACKAGE_JSON="${REPO_ROOT}/package.json"
VENDOR_ROOT="${VENDOR_ROOT:-${REPO_ROOT}/vendor}"
VENDOR_SKILLS="${VENDOR_ROOT}/skills"
LISTER="${REPO_ROOT}/scripts/list-bundled-skills.js"
DIST_ROOT="${DIST_ROOT:-${REPO_ROOT}/dist}"
DIST_DIR="${DIST_ROOT}/claude-plugin"
PLUGIN_DIR="${DIST_DIR}/.claude-plugin"
SKILLS_OUT="${DIST_DIR}/skills"

# --- Fail closed if vendor/ is missing ---
if [[ ! -d "${VENDOR_SKILLS}" ]]; then
  echo "ERROR: vendor/skills not found at ${VENDOR_SKILLS}" >&2
  echo "       Run bash setup.sh to populate vendor/ first." >&2
  exit 1
fi

# Fail-closed: a failing lister aborts the build rather than shipping a plugin
# with a silently truncated skill set.
BUNDLED="$(node "${LISTER}" "${VENDOR_SKILLS}" claude-code)"
if [[ -z "${BUNDLED}" ]]; then
  echo "ERROR: no bundled skills resolved from ${VENDOR_SKILLS}" >&2
  exit 1
fi

BUNDLED_NAMES=()
BUNDLED_DIRS=()
while IFS=$'\t' read -r NAME DIR; do
  [[ -n "${NAME}" ]] || continue
  BUNDLED_NAMES+=("${NAME}")
  BUNDLED_DIRS+=("${DIR}")
done <<< "${BUNDLED}"

# --- Read version from package.json (node already required by project) ---
VERSION="$(PACKAGE_JSON="${PACKAGE_JSON}" node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.env.PACKAGE_JSON,'utf8')).version)")"

if [[ -z "${VERSION}" ]]; then
  echo "ERROR: could not read version from ${PACKAGE_JSON}" >&2
  exit 1
fi

echo "Building Claude Code plugin ai-catapult@${VERSION}..."

# --- Clean and recreate output dirs ---
rm -rf "${DIST_DIR}"
mkdir -p "${PLUGIN_DIR}"
mkdir -p "${SKILLS_OUT}"

# --- Copy vendored skills (deterministic: strip .git and the HEAD_SHA sentinel) ---
for i in "${!BUNDLED_NAMES[@]}"; do
  cp -R "${BUNDLED_DIRS[$i]}" "${SKILLS_OUT}/${BUNDLED_NAMES[$i]}"
done
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

# Remove the git directory and HEAD_SHA sentinel — they are setup.sh artefacts,
# not part of the published skill payload. Do not fail if absent.
for NAME in "${BUNDLED_NAMES[@]}"; do
  rm -rf "${SKILLS_OUT}/${NAME}/.git"
  rm -f  "${SKILLS_OUT}/${NAME}/HEAD_SHA"
done

# --- Render the plugin.json skills array from the bundled set ---
SKILLS_JSON="$(SKILL_NAMES="${BUNDLED_NAMES[*]}" node -e "
  const names = process.env.SKILL_NAMES.split(' ').filter(Boolean);
  process.stdout.write(names.map(n => '    \"./skills/' + n + '/\"').join(',\n'));
")"

# --- Write plugin.json ---
cat > "${PLUGIN_DIR}/plugin.json" <<EOF
{
  "name": "ai-catapult",
  "version": "${VERSION}",
  "description": "Scaffold init-ai-repo v3 AI-SDLC governance into any repository — no LLM required, one command. Ships the ai-catapult skill catalog for Claude Code.",
  "author": {
    "name": "r3dlex"
  },
  "repository": "https://github.com/r3dlex/ai-catapult",
  "homepage": "https://github.com/r3dlex/ai-catapult",
  "license": "MIT",
  "keywords": [
    "ai-sdlc",
    "governance",
    "scaffold",
    "init-ai-repo",
    "claude-code"
  ],
  "skills": [
${SKILLS_JSON}
  ]
}
EOF

# --- Write marketplace.json ---
cat > "${PLUGIN_DIR}/marketplace.json" <<EOF
{
  "\$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "ai-catapult",
  "description": "Scaffold init-ai-repo v3 AI-SDLC governance — deterministic, no LLM required",
  "owner": {
    "name": "r3dlex"
  },
  "plugins": [
    {
      "name": "ai-catapult",
      "description": "Scaffold init-ai-repo v3 AI-SDLC governance into any repository. One command, zero config, no LLM required. Ships the ai-catapult skill catalog for Claude Code.",
      "version": "${VERSION}",
      "author": {
        "name": "r3dlex"
      },
      "source": "./",
      "category": "productivity",
      "homepage": "https://github.com/r3dlex/ai-catapult",
      "tags": [
        "ai-sdlc",
        "governance",
        "scaffold",
        "init-ai-repo"
      ]
    }
  ],
  "version": "${VERSION}"
}
EOF

# --- Validate the assembled output ---
echo "Validating assembled plugin..."

# 1. plugin.json parses as JSON and has required fields
PLUGIN_JSON="${PLUGIN_DIR}/plugin.json" node -e "
  const p = JSON.parse(require('fs').readFileSync(process.env.PLUGIN_JSON,'utf8'));
  if (!p.name)        { process.stderr.write('plugin.json missing name\n');    process.exit(1); }
  if (!p.version)     { process.stderr.write('plugin.json missing version\n'); process.exit(1); }
  if (!p.description) { process.stderr.write('plugin.json missing description\n'); process.exit(1); }
  if (!p.author)      { process.stderr.write('plugin.json missing author\n');  process.exit(1); }
  if (!Array.isArray(p.skills) || p.skills.length === 0) {
    process.stderr.write('plugin.json skills must be a non-empty array\n'); process.exit(1);
  }
"

# 2. marketplace.json parses and has $schema + plugins array
MARKETPLACE="${PLUGIN_DIR}/marketplace.json" node -e "
  const m = JSON.parse(require('fs').readFileSync(process.env.MARKETPLACE,'utf8'));
  if (!m['\$schema'])                                          { process.stderr.write('marketplace.json missing \$schema\n'); process.exit(1); }
  if (!Array.isArray(m.plugins) || m.plugins.length === 0)  { process.stderr.write('marketplace.json missing plugins array\n'); process.exit(1); }
"

# 3. Regression guard: skills must NOT be nested inside .claude-plugin/
if [[ -d "${PLUGIN_DIR}/skills" ]]; then
  echo "ERROR: skills/ must NOT be nested inside .claude-plugin/ — found ${PLUGIN_DIR}/skills" >&2
  echo "       Skills must live at the plugin root: ${DIST_DIR}/skills/" >&2
  exit 1
fi

# 4. Referenced skill dirs exist and contain SKILL.md
#    Paths in plugin.json are relative to the plugin root (DIST_DIR), not PLUGIN_DIR.
for SKILL_REL in $(PLUGIN_JSON="${PLUGIN_DIR}/plugin.json" node -e "
  const p = JSON.parse(require('fs').readFileSync(process.env.PLUGIN_JSON,'utf8'));
  p.skills.forEach(s => process.stdout.write(s + '\n'));
"); do
  SKILL_ABS="${DIST_DIR}/${SKILL_REL}"
  if [[ ! -d "${SKILL_ABS}" ]]; then
    echo "ERROR: skill directory referenced in plugin.json not found: ${SKILL_ABS}" >&2
    exit 1
  fi
  if [[ ! -f "${SKILL_ABS}/SKILL.md" ]]; then
    echo "ERROR: SKILL.md missing in ${SKILL_ABS}" >&2
    exit 1
  fi
done

echo "OK: dist/claude-plugin assembled and validated (ai-catapult@${VERSION})"
echo "    ${PLUGIN_DIR}/plugin.json"
echo "    ${PLUGIN_DIR}/marketplace.json"
echo "    ${SKILLS_OUT}/ (${#BUNDLED_NAMES[@]} skills, $(find "${SKILLS_OUT}" -type f | wc -l | tr -d ' ') files)"
