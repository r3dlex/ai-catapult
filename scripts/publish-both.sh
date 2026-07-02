#!/usr/bin/env bash
# publish-both.sh — publish ai-catapult to npm under both package names.
#
# Names:
#   ai-catapult          (unscoped, primary)
#   @r3dlex/ai-catapult  (scoped mirror)
#
# Default mode: dry-run (npm publish --dry-run) — safe to run any time.
# Real publish: requires BOTH --yes flag AND env AI_CATAPULT_PUBLISH=1.
#
# Usage:
#   bash scripts/publish-both.sh                               # dry-run
#   AI_CATAPULT_PUBLISH=1 bash scripts/publish-both.sh --yes   # real publish

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ---------------------------------------------------------------------------
# Parse args
# ---------------------------------------------------------------------------
REAL_PUBLISH=false
for arg in "$@"; do
  case "${arg}" in
    --yes) REAL_PUBLISH=true ;;
    *) echo "Unknown argument: ${arg}" >&2; exit 1 ;;
  esac
done

# Double gate: --yes alone is not enough; env var must also be set
if [[ "${REAL_PUBLISH}" == "true" && "${AI_CATAPULT_PUBLISH:-}" != "1" ]]; then
  echo "ERROR: --yes requires AI_CATAPULT_PUBLISH=1 to be set (double gate)." >&2
  echo "       Run: AI_CATAPULT_PUBLISH=1 bash scripts/publish-both.sh --yes" >&2
  exit 1
fi

if [[ "${REAL_PUBLISH}" == "true" ]]; then
  DRY_RUN_FLAG=""
  echo "=== REAL PUBLISH MODE ==="
else
  DRY_RUN_FLAG="--dry-run"
  echo "=== DRY-RUN MODE (no packages will be published) ==="
fi

# --provenance requires OIDC (only available in CI environments like GitHub Actions).
# Guard it so local runs don't fail with "provenance not supported".
PROVENANCE_FLAG=""
if [[ "${CI:-}" == "true" || "${NPM_PROVENANCE:-}" == "1" ]]; then
  PROVENANCE_FLAG="--provenance"
fi

# ---------------------------------------------------------------------------
# Verify builds exist (build if absent)
# ---------------------------------------------------------------------------
if [[ ! -f "${REPO_ROOT}/dist/claude-plugin/.claude-plugin/plugin.json" ]]; then
  echo "Building Claude Code plugin..."
  bash "${SCRIPT_DIR}/build-claude-plugin.sh"
fi

if [[ ! -f "${REPO_ROOT}/dist/codex-plugin/.codex-plugin/plugin.json" ]]; then
  echo "Building Codex plugin..."
  bash "${SCRIPT_DIR}/build-codex-plugin.sh"
fi

# Read version from package.json
VERSION="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('${REPO_ROOT}/package.json','utf8')).version)")"
echo "Version: ${VERSION}"
echo ""

# ---------------------------------------------------------------------------
# 1. Publish unscoped: ai-catapult (from repo root)
# ---------------------------------------------------------------------------
echo "--- [1/2] Publishing ai-catapult (unscoped) ---"
# shellcheck disable=SC2086
(cd "${REPO_ROOT}" && npm publish ${DRY_RUN_FLAG} ${PROVENANCE_FLAG} --access public)
echo ""

# ---------------------------------------------------------------------------
# 2. Publish scoped: @r3dlex/ai-catapult (stage in tmp dir with patched name)
# ---------------------------------------------------------------------------
echo "--- [2/2] Publishing @r3dlex/ai-catapult (scoped mirror) ---"

TMPDIR_SCOPED="$(mktemp -d)"
# shellcheck disable=SC2064
trap "rm -rf '${TMPDIR_SCOPED}'" EXIT

# Stage the scoped package: copy published files + write patched package.json
node --input-type=module - "${REPO_ROOT}" "${TMPDIR_SCOPED}" <<'STAGE_EOF'
import { readFileSync, writeFileSync, cpSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const [, , repoRoot, dest] = process.argv;
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const files = pkg.files ?? [];

for (const rel of files) {
  const src = join(repoRoot, rel);
  const dst = join(dest, rel);
  try {
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst, { recursive: true });
  } catch {
    // skip missing entries (e.g. optional files not present in every build)
  }
}

const scoped = {
  ...pkg,
  name: '@r3dlex/ai-catapult',
  publishConfig: { access: 'public' },
};
// Remove lifecycle scripts not needed in the published artifact
const scripts = { ...scoped.scripts };
delete scripts.pretest;
delete scripts.test;
scoped.scripts = scripts;

writeFileSync(
  join(dest, 'package.json'),
  JSON.stringify(scoped, null, 2) + '\n',
  'utf8',
);
process.stdout.write('Scoped package staged at: ' + dest + '\n');
STAGE_EOF

# shellcheck disable=SC2086
(cd "${TMPDIR_SCOPED}" && npm publish ${DRY_RUN_FLAG} ${PROVENANCE_FLAG} --access public)
echo ""

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
if [[ "${REAL_PUBLISH}" == "true" ]]; then
  echo "Published ai-catapult@${VERSION} and @r3dlex/ai-catapult@${VERSION} to npm."
else
  echo "Dry-run complete — both packages validated successfully."
  echo "To publish for real: AI_CATAPULT_PUBLISH=1 bash scripts/publish-both.sh --yes"
fi
