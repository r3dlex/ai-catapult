/**
 * SSCM-09 commit 2: vendored-snapshot staleness-gate wiring.
 *
 * Asserts the vendored scripts/check-sync-staleness.sh behaves per the
 * two-mode contract when invoked against the vendored upstream.lock snapshot:
 *   - real vendored lock (stale, unreachable sha) → advisory warn, exit 0
 *   - synthetic OLD lock → hard non-zero even in advisory mode
 *   - synthetic FRESH lock → exit zero
 *
 * The advisory-mode-asserted-once requirement for the vendored snapshot is
 * covered by the first test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const gate = join(root, 'vendor/skills/scripts/check-sync-staleness.sh');
const vendoredLock = join(root, 'vendor/skills/upstream.lock');

function runGate(args) {
  return spawnSync('bash', [gate, ...args], { encoding: 'utf8' });
}

test('vendored real lock: advisory warning + exit 0 (asserted once for the snapshot)', () => {
  // The vendored lock describes the vendored skills tree: its repo-root IS vendor/skills.
  const out = runGate(['--lock', vendoredLock, '--mode', 'advisory', '--repo-root', join(root, 'vendor/skills')]);
  assert.equal(out.status, 0, `gate should exit 0 in advisory mode, got ${out.status}: ${out.stderr}`);
  assert.match(out.stdout + out.stderr, /advisory/);
  assert.match(out.stdout + out.stderr, /Flip to hard at the first live upstream-lock refresh/);
});

test('vendored gate: synthetic stale lock is hard even in advisory mode', () => {
  const tmp = mkdtempSync(join(root, '.tmp-stale-'));
  try {
    const lock = join(tmp, 'old.lock');
    writeFileSync(lock, 'source: mattpocock/skills\nvia: r3dlex/skills\npinned_sha: deadbeef0000000000000000000000000000dead\nupdated: 2026-01-01\nsync_script: scripts/sync-upstream.sh\n');
    const out = runGate(['--lock', lock, '--mode', 'advisory', '--repo-root', root]);
    assert.notEqual(out.status, 0, 'synthetic stale lock must exit non-zero (hard)');
    assert.match(out.stderr, /stale|not reachable/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('vendored gate: synthetic fresh lock exits zero', () => {
  const tmp = mkdtempSync(join(root, '.tmp-fresh-'));
  try {
    const lock = join(tmp, 'fresh.lock');
    // Fresh date = today; sha must be locally reachable (repo HEAD exists in vendor? no —
    // outside-repo-root lock is a synthetic fixture, so reachability is not enforced for
    // non-fake shas; but staleness is hard → fresh date keeps it under threshold).
    const today = new Date().toISOString().slice(0, 10);
    // Non-fake sha + outside-repo-root lock = synthetic fixture: reachability is
    // not asserted for it, so staleness alone decides.
    writeFileSync(lock, `source: mattpocock/skills\nvia: r3dlex/skills\npinned_sha: 1234567890abcdef1234567890abcdef12345678\nupdated: ${today}\nsync_script: scripts/sync-upstream.sh\n`);
    const out = runGate(['--lock', lock, '--mode', 'advisory', '--repo-root', root]);
    assert.equal(out.status, 0, `fresh lock should exit 0: ${out.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});