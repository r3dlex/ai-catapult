/**
 * Tests for publish-both.sh rerun tolerance.
 *
 * A release run that fails at [2/2] (scoped) after [1/2] (unscoped) succeeded
 * leaves the unscoped version already on the registry. Re-running the publish
 * step against the same tag → npm rejects [1/2] with "You cannot publish over
 * the previously published versions: X.Y.Z" and the scoped mirror never gets
 * its attempt. publish-both.sh must treat already-published-for-this-version
 * as success and continue; other npm failures (ENEEDAUTH) must still abort.
 *
 * Strategy: copy scripts/publish-both.sh into a sandbox tree (package.json +
 * dist plugin markers), shadow npm with a stub on PATH, and run with
 * AI_CATAPULT_PUBLISH=1 --yes. The stub counts its `publish` invocations in
 * $PB_CALLS_FILE and prints the failure text from
 * $PB_ERROR_DIR/error-<call-index> (exiting 1) when that file exists; it
 * exits 0 with a fake success line otherwise. Counting via env-pinned files
 * (not cwd markers) because the scoped publish runs inside its own mktemp
 * staging directory.
 */
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const script = join(root, 'scripts', 'publish-both.sh');

const CANNOT_PUBLISH =
  'npm error You cannot publish over the previously published versions: 9.9.9.';
const ENEEDAUTH =
  'npm error code ENEEDAUTH\nnpm error need auth This command requires you to be logged in.';

const NPM_STUB = `#!/usr/bin/env bash
calls_file="$PB_CALLS_FILE"
err_dir="$PB_ERROR_DIR"
if [[ "$1" == "publish" ]]; then
  n=$(cat "$calls_file" 2>/dev/null || echo 0)
  n=$((n + 1))
  echo "$n" > "$calls_file"
  if [[ -f "$err_dir/error-$n" ]]; then
    cat "$err_dir/error-$n"
    exit 1
  fi
fi
echo "ai-catapult@9.9.9 published (stub)"
exit 0
`;

/** Build a sandbox tree and configure per-call npm stub failures. */
function sandbox({ call1, call2 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'publish-both-test-'));
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'err'));
  mkdirSync(join(dir, 'dist', 'claude-plugin', '.claude-plugin'), { recursive: true });
  mkdirSync(join(dir, 'dist', 'codex-plugin', '.codex-plugin'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'claude-plugin', '.claude-plugin', 'plugin.json'), '{}');
  writeFileSync(join(dir, 'dist', 'codex-plugin', '.codex-plugin', 'plugin.json'), '{}');
  cpSync(script, join(dir, 'scripts', 'publish-both.sh'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'ai-catapult',
    version: '9.9.9',
    files: [],
    scripts: {},
  }));
  if (call1 !== undefined) writeFileSync(join(dir, 'err', 'error-1'), call1);
  if (call2 !== undefined) writeFileSync(join(dir, 'err', 'error-2'), call2);
  writeFileSync(join(dir, 'bin', 'npm'), NPM_STUB);
  chmodSync(join(dir, 'bin', 'npm'), 0o755);
  writeFileSync(join(dir, 'bin', 'node'), `#!/usr/bin/env bash
# Real node delegates: pass through so the staging block runs, but it will
# copy files[] = [] (no-op) and write the staged package.json.
exec "${process.execPath}" "$@"
`);
  chmodSync(join(dir, 'bin', 'node'), 0o755);
  return dir;
}

/** Run the sandboxed publish-both.sh in real mode (-x yes). */
function run(dir) {
  return spawnSync('bash', [join(dir, 'scripts', 'publish-both.sh'), '--yes'], {
    encoding: 'utf8',
    cwd: dir,
    env: {
      ...process.env,
      AI_CATAPULT_PUBLISH: '1',
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      PB_CALLS_FILE: join(dir, 'calls'),
      PB_ERROR_DIR: join(dir, 'err'),
    },
  });
}

test('double gate: --yes without AI_CATAPULT_PUBLISH=1 refuses', () => {
  const dir = sandbox();
  const r = spawnSync('bash', [join(dir, 'scripts', 'publish-both.sh'), '--yes'], {
    encoding: 'utf8',
    cwd: dir,
    env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--yes requires AI_CATAPULT_PUBLISH=1/);
});

test('rerun tolerance: unscoped already-published continues to scoped attempt', () => {
  const dir = sandbox({ call1: CANNOT_PUBLISH });
  const r = run(dir);
  assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /--- \[1\/2\] Publishing ai-catapult \(unscoped\) ---/);
  assert.match(r.stdout, /ai-catapult@9\.9\.9 already published/);
  assert.match(r.stdout, /--- \[2\/2\] Publishing @r3dlex\/ai-catapult \(scoped mirror\) ---/);
  assert.match(r.stdout, /Published ai-catapult@9\.9\.9 and @r3dlex\/ai-catapult@9\.9\.9/);
});

test('unscoped ENEEDAUTH still aborts', () => {
  const dir = sandbox({ call1: ENEEDAUTH });
  const r = run(dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ENEEDAUTH/);
});

test('scoped already-published tolerated (exit 0)', () => {
  const dir = sandbox({ call2: CANNOT_PUBLISH });
  const r = run(dir);
  assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /@r3dlex\/ai-catapult@9\.9\.9 already published/);
  assert.match(r.stdout, /Published ai-catapult@9\.9\.9 and @r3dlex\/ai-catapult@9\.9\.9/);
});

test('scoped ENEEDAUTH still aborts', () => {
  const dir = sandbox({ call2: ENEEDAUTH });
  const r = run(dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ENEEDAUTH/);
});
