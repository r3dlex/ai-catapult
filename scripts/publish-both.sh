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
#   AI_CATAPULT_PUBLISH=1 bash scripts/publish-both.sh --yes   # real publish both
#   AI_CATAPULT_PUBLISH=1 bash scripts/publish-both.sh --yes --package @r3dlex/ai-catapult  # scoped retry

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ---------------------------------------------------------------------------
# Parse args
# ---------------------------------------------------------------------------
REAL_PUBLISH=false
PACKAGE=both
PACKAGE_SET=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes)
      [[ "$REAL_PUBLISH" == false ]] || { echo "ERROR: duplicate --yes" >&2; exit 1; }
      REAL_PUBLISH=true
      shift
      ;;
    --package)
      [[ "$PACKAGE_SET" == false && $# -ge 2 ]] || { echo "ERROR: --package requires one exact package name and may appear only once" >&2; exit 1; }
      case "$2" in
        ai-catapult|@r3dlex/ai-catapult) PACKAGE="$2" ;;
        *) echo "ERROR: unsupported package: $2" >&2; exit 1 ;;
      esac
      PACKAGE_SET=true
      shift 2
      ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
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
# Pack once, then compare/publish those exact bytes. Existing immutable registry
# content is an idempotent completion, never an excuse to swallow publish errors.
publish_package() {
  local package_dir="$1" package_name="$2"
  node --input-type=module - "$package_dir" "$package_name" "$VERSION" "$DRY_RUN_FLAG" "$PROVENANCE_FLAG" <<'PUBLISH_EOF'
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
const [dir, name, version, dryRun, provenance] = process.argv.slice(2);
const temp = mkdtempSync(join(tmpdir(), 'ai-catapult-publish-'));
const run = (args) => spawnSync('npm', args, { cwd: dir, encoding: 'utf8' });
const requireSuccess = (result) => {
  process.stderr.write(result.stderr || '');
  if (result.status !== 0) {
    process.stderr.write(result.stdout || '');
    const error = new Error('npm command failed');
    error.status = result.status > 0 ? result.status : 1;
    throw error;
  }
  return result.stdout;
};
try {
  const packed = JSON.parse(requireSuccess(run(['pack', '--json', '--foreground-scripts=false', '--pack-destination', temp])));
  if (!Array.isArray(packed) || packed.length !== 1 || packed[0].name !== name || packed[0].version !== version ||
      typeof packed[0].filename !== 'string' || basename(packed[0].filename) !== packed[0].filename) throw new Error('unexpected local package identity');
  const tarball = join(temp, packed[0].filename);
  const integrity = 'sha512-' + createHash('sha512').update(readFileSync(tarball)).digest('base64');
  if (packed[0].integrity !== integrity) throw new Error('local packed integrity mismatch');
  const archiveManifest = JSON.parse(requireSuccess(spawnSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' })));
  if (archiveManifest.name !== name || archiveManifest.version !== version) throw new Error('packed archive identity mismatch');
  let existing = false;
  if (!dryRun) {
    const remote = run(['view', `${name}@${version}`, 'name', 'version', 'dist.integrity', '--json', '--registry=https://registry.npmjs.org', '--@r3dlex:registry=https://registry.npmjs.org']);
    if (remote.status === 0) {
      process.stderr.write(remote.stderr || '');
      const published = JSON.parse(remote.stdout);
      if (published.name !== name || published.version !== version || published['dist.integrity'] !== integrity) throw new Error('registry identity or payload integrity mismatch');
      existing = true;
    } else {
      let missing = false;
      try { missing = JSON.parse(remote.stdout).error?.code === 'E404'; } catch {}
      if (!missing) requireSuccess(remote);
      process.stderr.write(remote.stderr || '');
    }
  }
  if (existing) {
    console.log(`${name}@${version} already published — VERIFIED existing registry artifact (exact payload).`);
  } else {
    process.stdout.write(requireSuccess(run(['publish', tarball, '--json', ...[dryRun, provenance].filter(Boolean), '--access', 'public', '--registry=https://registry.npmjs.org', '--@r3dlex:registry=https://registry.npmjs.org'])));
  }
} catch (error) {
  console.error(`publish-both: ${error.message}`);
  process.exitCode = error.status || 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
PUBLISH_EOF
}

if [[ "$PACKAGE" == both || "$PACKAGE" == ai-catapult ]]; then
echo "--- [1/2] Publishing ai-catapult (unscoped) ---"
publish_package "$REPO_ROOT" ai-catapult
echo ""
fi

# ---------------------------------------------------------------------------
# 2. Publish scoped: @r3dlex/ai-catapult (stage in tmp dir with patched name)
# ---------------------------------------------------------------------------
if [[ "$PACKAGE" == both || "$PACKAGE" == @r3dlex/ai-catapult ]]; then
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
  } catch (error) {
    // Missing entries are skipped so an optional build artifact does not abort a
    // release — but report them. A bare `catch {}` here hid a `files[]` gap for a
    // month: scripts/stage-readme-contract.sh was never staged, so the scoped
    // mirror's prepack exited 127 on the first release that reached this path,
    // with no earlier warning anywhere.
    process.stderr.write(`publish-both: WARNING not staged: ${rel} (${error.code ?? error.message})\n`);
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

echo ""
publish_package "$TMPDIR_SCOPED" @r3dlex/ai-catapult
echo ""
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
if [[ "${REAL_PUBLISH}" == "true" ]]; then
  if [[ "$PACKAGE" == both ]]; then
    echo "Publication complete: ai-catapult@${VERSION} and @r3dlex/ai-catapult@${VERSION} published or verified existing."
  else
    echo "Publication complete: ${PACKAGE}@${VERSION} published or verified existing."
  fi
else
  echo "Dry-run complete — selected packages validated successfully."
  echo "Publishing requires AI_CATAPULT_PUBLISH=1 and --yes; preserve any --package selection."
fi
