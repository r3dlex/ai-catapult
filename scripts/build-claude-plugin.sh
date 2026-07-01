#!/usr/bin/env bash
# build-claude-plugin.sh — assemble the ai-catapult Claude Code plugin into dist/claude-plugin/.
#
# Output layout (per Claude Code plugin contract):
#   dist/claude-plugin/            ← PLUGIN ROOT (paths in plugin.json resolve from here)
#     .claude-plugin/
#       plugin.json        (manifest: name, version, description, author, skills)
#       marketplace.json   (marketplace entry with $schema)
#     skills/
#       ai-catapult-init/  (copy of vendor/skills/ai-catapult-init/)
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
VENDOR_SKILL="${REPO_ROOT}/vendor/skills/ai-catapult-init"
DIST_DIR="${REPO_ROOT}/dist/claude-plugin"
PLUGIN_DIR="${DIST_DIR}/.claude-plugin"
SKILLS_OUT="${DIST_DIR}/skills"

# --- Fail closed if vendor/ is missing ---
if [[ ! -d "${VENDOR_SKILL}" ]]; then
  echo "ERROR: vendor/skills/ai-catapult-init not found at ${VENDOR_SKILL}" >&2
  echo "       Run bash setup.sh to populate vendor/ first." >&2
  exit 1
fi

if [[ ! -f "${VENDOR_SKILL}/SKILL.md" ]]; then
  echo "ERROR: vendor/skills/ai-catapult-init/SKILL.md missing — vendor may be corrupt" >&2
  echo "       Run bash setup.sh to re-vendor." >&2
  exit 1
fi

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

# --- Copy vendored skill (deterministic: rsync excludes .git, HEAD_SHA sentinel) ---
# Use cp -R and then strip the git artefacts that setup.sh left.
cp -R "${VENDOR_SKILL}" "${SKILLS_OUT}/ai-catapult-init"

# Remove the git directory and HEAD_SHA sentinel — they are setup.sh artefacts,
# not part of the published skill payload. Do not fail if absent.
rm -rf "${SKILLS_OUT}/ai-catapult-init/.git"
rm -f  "${SKILLS_OUT}/ai-catapult-init/HEAD_SHA"

# --- Write plugin.json ---
cat > "${PLUGIN_DIR}/plugin.json" <<EOF
{
  "name": "ai-catapult",
  "version": "${VERSION}",
  "description": "Scaffold init-ai-repo v3 AI-SDLC governance into any repository — no LLM required, one command. Ships as a Claude Code skill.",
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
    "./skills/ai-catapult-init/"
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
      "description": "Scaffold init-ai-repo v3 AI-SDLC governance into any repository. One command, zero config, no LLM required. Provides the ai-catapult-init skill for Claude Code.",
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
echo "    ${SKILLS_OUT}/ai-catapult-init/ ($(find "${SKILLS_OUT}/ai-catapult-init" -type f | wc -l | tr -d ' ') files)"
