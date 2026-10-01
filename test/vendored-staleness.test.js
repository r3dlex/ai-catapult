/**
 * SSCM-09 commit 2: vendored-snapshot staleness-gate wiring.
 *
 * Asserts the vendored scripts/check-sync-staleness.sh behaves per the
 * two-mode contract when invoked against the vendored upstream.lock snapshot:
 *   - real vendored lock → exit 0 in advisory mode; the lock was refreshed
 *     live by the skills-repo 73-commit upstream merge (updated 2026-10-01,
 *     d81f3a1), so the gate prints "staleness: ok" — the "stale real lock →
 *     advisory warn" premise ended with that first live refresh, which is
 *     exactly the dated flip condition the gate source describes
 *   - synthetic OLD lock → hard non-zero even in advisory mode
 *   - synthetic FRESH lock → exit zero
 *
 * The real-lock advisory output contract is asserted on a synthetic stale
 * fixture; the fresh-lock contract on the real lock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const gate = join(root, 'vendor/skills/scripts/check-sync-staleness.sh');
const vendoredLock = join(root, 'vendor/skills/upstream.lock');

function runGate(args) {
  return spawnSync('bash', [gate, ...args], { encoding: 'utf8' });
}

test('vendored real lock: fresh after first live refresh — ok + exit 0 (asserted once for the snapshot)', () => {
  // The vendored lock describes the vendored skills tree: its repo-root IS vendor/skills.
  // Post-skills-#83 the lock was refreshed live (d81f3a1, updated 2026-10-01), so the
  // advisory warning no longer fires; the gate reports fresh and exits 0.
  // NOTE: this test fails loudly once the lock age crosses the 49d threshold
  // (~2026-11-19) — fail-loud by design, pinning the snapshot to a live re-vendor.
  const out = runGate(['--lock', vendoredLock, '--mode', 'advisory', '--repo-root', join(root, 'vendor/skills')]);
  assert.equal(out.status, 0, `gate should exit 0 in advisory mode, got ${out.status}: ${out.stderr}`);
  const output = out.stdout + out.stderr;
  assert.match(output, /staleness: ok/);
  const lockDate = readFileSync(vendoredLock, 'utf8').match(/^updated:\s*(\S+)$/m)?.[1];
  assert.ok(lockDate, 'vendored upstream.lock must carry an updated: date');
  assert.match(output, new RegExp(`lock ${lockDate}`));
});

test('advisory warn is unreachable in the vendored snapshot: synthetic stale is hard', () => {
  // The gate treats every synthetic stale lock as hard regardless of mode, so the
  // advisory-warn wording was only reachable on a real stale lock — and the vendored
  // lock is now fresh. The stale-advisory contract stays covered by the skills repo's
  // own sync_staleness_test.sh, not this snapshot.
  const tmp = mkdtempSync(join(root, '.tmp-adv-'));
  try {
    const lock = join(tmp, 'stale-real-shaped.lock');
    writeFileSync(lock, 'source: mattpocock/skills\nvia: r3dlex/skills\npinned_sha: 84fdeffd12f2ee307994d1eb6feb48173b6e0502\nupdated: 2026-08-09\nsync_script: scripts/sync-upstream.sh\n');
    const out = runGate(['--lock', lock, '--mode', 'advisory', '--repo-root', root]);
    assert.notEqual(out.status, 0, 'synthetic stale lock must stay hard even in advisory mode');
    assert.match(out.stderr, /stale/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
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