/**
 * TDD tests for Goals XSKP-P4-02 (read verbs) and XSKP-P4-03 (write verbs) —
 * knowledge-registry/1 conformance.
 *
 * XSKP-P4-02 goal record (handoff xskp-p4-adopt-engine, gen 2ce8dbb7…, goals.json):
 *   'ai-catapult knowledge list|find|show|verify|rebuild' passes C01-C06, C14,
 *   the C15 read half and C18 with the same exit codes and error tokens as the
 *   contract. C16: the JS serializer orders keys by Unicode code point (not
 *   UTF-16 code unit) and writes non-ASCII literally; its output equals
 *   fixtures/vectors/serialization-expected.json byte-for-byte; C02 reproduces
 *   the fixture registry.json. Packaged lane: the same cases run against the
 *   dist-snapshot tree. Auto-discovered by node --test under npm test.
 *
 * XSKP-P4-03 goal record (same handoff):
 *   publish/archive/retire/unlock pass C07-C13, the C15 write half and C19
 *   (unlock without --confirm-no-writer exits 2; never automatic; ledgered).
 *   The policy's inline (?i) secret pattern is translated to a JS 'i' flag and
 *   tested explicitly (Node rejects (?i)); the C08 token is assembled at
 *   runtime. The lock is an atomic mkdirSync; contention fails immediately with
 *   locked; a stale lock is reported, never removed automatically. AC-3 (P4):
 *   C01-C19 pass in source and packaged lanes. AC-7: an executable guard wraps
 *   every write test (git status --porcelain plus native/immutable sha256
 *   snapshots, before and after).
 *
 * Cases exercised, from .ai/knowledge/contract/conformance.json:
 *   C01-valid-readback            show example-repo:plan:example (exit 0, digest)
 *   C02-aggregate-reproducible    rebuild --check (exit 0, empty stdout);
 *                                 rebuild reproduces fixture registry.json bytes
 *   C03-hash-mismatch             verify → hash_mismatch, exit 1
 *   C04-missing-without-tombstone verify → missing_without_tombstone, exit 1
 *   C05-path-traversal            verify → unsafe_path (traversal), exit 1
 *   C06-symlink-component         verify → unsafe_path (symlink_component), exit 1
 *   C07-denied-source             publish a deny-listed path → denied_private, exit 1
 *   C08-secret-in-content         publish a runtime-assembled AWS-key shape →
 *                                 secret_detected; the (?i) pattern matches
 *                                 case-insensitively through the JS i flag
 *   C09-id-reuse                  retire, then publish a new doc under the same
 *                                 knowledge_id → id_reused, exit 1
 *   C10-revision-append           edit canonical, republish → rev 2, rev 1 kept;
 *                                 show verifies it
 *   C11-frontmatter-merge         existing frontmatter keys kept; only
 *                                 knowledge_id added
 *   C12-immutable-no-rewrite      immutable path published in place, bytes
 *                                 unchanged, frontmatter_id false
 *   C13-lock-contention           two concurrent publishes of one knowledge_id:
 *                                 one exits 0, the other fails locked at once
 *   C14-federated-absent-child    find --federated with an absent managed child:
 *                                 exit 0, absence reported not failed
 *   C15 read half                 rebuild preserves unknown entry keys (x_extra)
 *   C15 write half                rebuild then republish preserves x_extra
 *   C16-serialization-vector      serialize → bytes equal expected vector;
 *                                 pins code-point key order (x_ｚ before x_😀)
 *   C17-dispatcher-forwarding     `ai-catapult knowledge` forwards argv verbatim
 *                                 and returns the writer's exit and streams.
 *                                 The absent-writer clause has no subject here:
 *                                 the contract scopes it to implementations that
 *                                 ship reader and writer as separate files
 *                                 (root scripts/ai-knowledge); P4 ships both
 *                                 halves in src/knowledge.js, so the writer can
 *                                 never be absent while the reader is present.
 *   C18-stale-lock-reported       verify reports stale_lock, exits 0, lock kept
 *                                 (seeded, and left by a killed real writer)
 *   C19-manual-unlock             unlock refuses without --confirm-no-writer
 *                                 (exit 2); with it the lock goes and the
 *                                 unlock is ledgered prepared → applied
 *   list smoke                    list on the valid fixture (AC names list; no
 *                                 dedicated C-case) pins the 9-key item shape
 *   archive                       the contract verb with no C-case: confirmed,
 *                                 ledgered migrate with reference repair
 *   review-r1 F1                  two identities racing for one canonical or
 *                                 one archive token are serialized (locked,
 *                                 then the sequential refusal)
 *   review-r2/r3/r4               unlock recovers an ownerless lock and a
 *                                 dead unlock's claim, removes only the lock
 *                                 incarnations it snapshotted (each claimed
 *                                 exclusively first; a displaced lock is kept
 *                                 under its claim, never renamed back), refuses
 *                                 a running unlock's claim, and concurrent
 *                                 unlocks remove one stale lock exactly once
 *   review-r5                     ledger appends are whole (short writes
 *                                 retried or truncated away before any
 *                                 removal); an interrupted tail is terminated
 *                                 and ledgered; no damaged audit line blocks
 *                                 unlock
 *
 * Every case runs in TWO lanes against the same fixtures:
 *   source:   this checkout's bin/ai-catapult.js
 *   packaged: an extracted npm tarball staged exactly like
 *             test/knowledge-contract.test.js (dist-snapshot/ becomes dist/;
 *             vendor is absent; the CLI must run from the package alone,
 *             including resolving .ai/knowledge/contract from package files).
 *
 * The tests only ever spawn the CLI (or a child process that imports the
 * lane's src/knowledge.js); they import nothing from src/ themselves so the red
 * state is the dispatch failure itself, not a module load error.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const SOURCE_CONTRACT = join(root, '.ai/knowledge/contract');
// Pinned by the admitted goal: sha256 of the fixture canonical doc (C01) that
// also appears as revisions[-1].sha256 in the fixture entry.
const CANONICAL_SHA256 =
  'c199eb971601a4de443d553886bcdd6279533315d300e7226a8dd85d8d9d8685';

// ---------------------------------------------------------------------------
// Packaged lane (built once per test file)
// ---------------------------------------------------------------------------

// Mirror test/knowledge-contract.test.js: dist-snapshot/ is the stable stand-in
// for the built dist/ tree (populated by npm run pretest / snapshot-dist.sh).
const DIST_SNAPSHOT = process.env.AI_CATAPULT_DIST_ROOT ?? join(root, 'dist-snapshot');

const packaged = { dir: null, tmp: null };
let packTmpDir;

before(() => {
  assert.ok(
    existsSync(DIST_SNAPSHOT),
    `dist-snapshot missing at ${DIST_SNAPSHOT} — run npm test or npm run pretest first`,
  );
  packTmpDir = mkdtempSync(join(tmpdir(), 'ai-catapult-kc-pack-'));
  const stageDir = mkdtempSync(join(tmpdir(), 'ai-catapult-kc-stage-'));
  const extractDir = mkdtempSync(join(tmpdir(), 'ai-catapult-kc-extract-'));
  packaged.tmp = { stageDir, extractDir };
  try {
    // rsync staging, exactly like test/graph-hooks.test.js:101 and
    // test/knowledge-contract.test.js:236 — vendor/, node_modules, .git and the
    // dist trees stay out of the staged package.
    const rsync = spawnSync('rsync', [
      '-a', '--delete',
      '--exclude=node_modules',
      '--exclude=.git',
      '--exclude=dist/',
      '--exclude=dist-snapshot/',
      '--exclude=vendor/',
      `${root}/`,
      `${stageDir}/`,
    ], { encoding: 'utf8', timeout: 120_000 });
    assert.equal(rsync.status, 0, `rsync to stage failed\n${rsync.stderr}`);
    // dist/ is the stable snapshot's CONTENT (skill-templates et al. must sit
    // exactly there — the CLI falls back to dist/skill-templates when vendor/
    // is absent). rsync content-copy, not cp -R, whose dst-exists semantics
    // would nest the snapshot one level too deep.
    mkdirSync(join(stageDir, 'dist'), { recursive: true });
    const rsyncDist = spawnSync('rsync', ['-a', `${DIST_SNAPSHOT}/`, `${join(stageDir, 'dist')}/`], {
      encoding: 'utf8', timeout: 120_000,
    });
    assert.equal(rsyncDist.status, 0, `rsync dist-snapshot → stage/dist failed\n${rsyncDist.stderr}`);
    assert.ok(
      existsSync(join(stageDir, 'dist/skill-templates')),
      'staged dist/skill-templates missing — the packaged CLI cannot even load',
    );

    // --ignore-scripts keeps prepack (setup.sh) from running: vendor/skills is
    // never touched by the packed lane.
    const pack = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', packTmpDir], {
      encoding: 'utf8', cwd: stageDir, timeout: 120_000,
    });
    assert.equal(pack.status, 0, `npm pack failed\n${pack.stdout}\n${pack.stderr}`);
    const tgzName = pack.stdout.trim().split('\n').at(-1).trim();
    const tgzPath = join(packTmpDir, tgzName);
    assert.ok(existsSync(tgzPath), `Expected tarball at ${tgzPath}`);

    const tar = spawnSync('tar', ['-xzf', tgzPath, '-C', extractDir], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(tar.status, 0, `tar extraction failed: ${tar.stderr}`);

    packaged.dir = join(extractDir, 'package');
    // The packaged lane proves the CLI runs without a vendored skills checkout.
    assert.equal(existsSync(join(packaged.dir, 'vendor')), false, 'tarball must not contain vendor/');
    assert.ok(existsSync(join(packaged.dir, 'bin/ai-catapult.js')), 'tarball missing bin/ai-catapult.js');
    assert.ok(
      existsSync(join(packaged.dir, '.ai/knowledge/contract/conformance.json')),
      'tarball missing .ai/knowledge/contract/ (packaged lane has no contract to run against)',
    );
    assert.ok(
      existsSync(join(packaged.dir, '.ai/knowledge/contract/fixtures/valid/.ai/knowledge/registry.json')),
      'tarball missing knowledge fixtures',
    );
  } catch (error) {
    rmSync(stageDir, { recursive: true, force: true });
    rmSync(extractDir, { recursive: true, force: true });
    packaged.tmp = null;
    throw error;
  }
});

after(() => {
  if (packaged.tmp) {
    for (const dir of Object.values(packaged.tmp)) rmSync(dir, { recursive: true, force: true });
  }
  if (packTmpDir) rmSync(packTmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function laneRoot(lane) {
  return lane === 'source'
    ? root
    : assertPackaged();
}

function assertPackaged() {
  assert.ok(packaged.dir, 'packaged lane must be prepared by the file-level before()');
  return packaged.dir;
}

function laneFixtureDir(lane) {
  return join(laneRoot(lane), '.ai/knowledge/contract/fixtures/valid');
}

function laneContractDir(lane) {
  return join(laneRoot(lane), '.ai/knowledge/contract');
}

/**
 * Spawn `node <cli> knowledge --root <rootDir> <args…>` for the lane.
 * The knowledge verbs do not read templates, but bin/ai-catapult.js resolves a
 * template dir at module load; AI_CATAPULT_DIST_ROOT is pinned per lane
 * (readiness-delivery precedent: the extracted package uses its own dist).
 */
function spawnKnowledge(lane, rootDir, args, extraEnv = {}) {
  const cli = join(laneRoot(lane), 'bin/ai-catapult.js');
  const distRoot = lane === 'source' ? DIST_SNAPSHOT : join(packaged.dir, 'dist');
  const result = spawnSync(process.execPath, [cli, 'knowledge', '--root', rootDir, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, AI_CATAPULT_DIST_ROOT: distRoot, ...extraEnv },
  });
  assert.equal(result.error, undefined, `spawn failed: ${result.error}`);
  return result;
}

/** Copy the valid fixture into a fresh temp root, mutate, return the path. */
function stageFixture(lane, mutate) {
  const tmp = mkdtempSync(join(tmpdir(), 'ai-catapult-kc-fix-'));
  cpSync(laneFixtureDir(lane), tmp, { recursive: true });
  if (mutate) mutate(tmp);
  return tmp;
}

/** A guaranteed-dead pid: spawnSync reaps before returning. */
function deadPid() {
  for (let i = 0; i < 20; i += 1) {
    const p = spawnSync('true').pid;
    if (typeof p === 'number' && p > 0) {
      try {
        process.kill(p, 0);
      } catch (error) {
        if (error.code === 'ESRCH') return p;
      }
    }
  }
  throw new Error('could not find a dead pid');
}

/** Run mutate/asserts per lane; always cleans the staged fixture. */
function perLane(name, runLane) {
  for (const lane of ['source', 'packaged']) {
    const tmp = stageFixture(lane);
    try {
      runLane(lane, tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

// The one aggregate item the fixture registry.json carries (mirrors the fixed
// 9-key shape the contract pins for aggregate items).
const EXPECTED_ITEM = {
  entry: '.ai/knowledge/entries/example-repo__plan__example.json',
  kind: 'plan',
  knowledge_id: 'example-repo:plan:example',
  lifecycle: 'active',
  path: 'docs/plans/example.md',
  rev: 1,
  sha256: CANONICAL_SHA256,
  surface: 'omo',
  title: 'Example plan',
};
const EXPECTED_REGISTRY_FILE = '.ai/knowledge/registry.json';
const ENTRY_FILE_REL = '.ai/knowledge/entries/example-repo__plan__example.json';

// ---------------------------------------------------------------------------
// C01 — valid readback
// ---------------------------------------------------------------------------

test('XSKP-P4-02 C01-valid-readback: show emits the entry with the canonical digest (source + packaged)', () => {
  perLane('C01', (lane, tmp) => {
    const result = spawnKnowledge(lane, tmp, ['show', 'example-repo:plan:example']);
    assert.equal(result.status, 0, `show failed (exit ${result.status})\n${result.stderr}`);
    assert.ok(result.stdout.endsWith('\n'), 'stdout must end with a newline (canonical bytes)');
    const entry = JSON.parse(result.stdout);
    assert.equal(entry.knowledge_id, 'example-repo:plan:example');
    assert.equal(entry.lifecycle, 'active');
    assert.equal(entry.revisions.at(-1).sha256, CANONICAL_SHA256);
    // The shown revision digest is the digest of the canonical bytes on disk.
    assert.equal(sha256File(join(tmp, 'docs/plans/example.md')), CANONICAL_SHA256);
  });
});

// ---------------------------------------------------------------------------
// C02 — aggregate reproducible + reproduced bytes
// ---------------------------------------------------------------------------

test('XSKP-P4-02 C02-aggregate-reproducible: rebuild --check is green and silent; rebuild reproduces fixture registry.json (source + packaged)', () => {
  perLane('C02', (lane, tmp) => {
    const check = spawnKnowledge(lane, tmp, ['rebuild', '--check']);
    assert.equal(check.status, 0, `rebuild --check failed (exit ${check.status})\n${check.stderr}`);
    assert.equal(check.stdout, '', 'rebuild --check on a fresh aggregate must print nothing');

    // Full reproduction on a second untouched copy: the rebuilt aggregate is
    // byte-identical to the fixture registry.json.
    const tmp2 = stageFixture(lane);
    try {
      const rebuild = spawnKnowledge(lane, tmp2, ['rebuild']);
      assert.equal(rebuild.status, 0, `rebuild failed (exit ${rebuild.status})\n${rebuild.stderr}`);
      assert.deepEqual(JSON.parse(rebuild.stdout), { rebuilt: EXPECTED_REGISTRY_FILE, entries: 1 });
      assert.deepEqual(
        readFileSync(join(tmp2, EXPECTED_REGISTRY_FILE)),
        readFileSync(join(laneFixtureDir(lane), EXPECTED_REGISTRY_FILE)),
        'rebuilt registry.json must be byte-identical to the fixture aggregate',
      );
    } finally {
      rmSync(tmp2, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// C03 — hash mismatch
// ---------------------------------------------------------------------------

test('XSKP-P4-02 C03-hash-mismatch: verify reports hash_mismatch and exits 1 (source + packaged)', () => {
  perLane('C03', (lane, tmp) => {
    appendFileSync(join(tmp, 'docs/plans/example.md'), 'x');
    const result = spawnKnowledge(lane, tmp, ['verify']);
    assert.equal(result.status, 1, `verify must fail (exit ${result.status})\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.deepEqual(report.warnings, []);
    assert.deepEqual(report.errors, [{
      entry: 'example-repo:plan:example',
      error: 'hash_mismatch',
      detail: 'docs/plans/example.md',
    }]);
  });
});

// ---------------------------------------------------------------------------
// C04 — missing without tombstone
// ---------------------------------------------------------------------------

test('XSKP-P4-02 C04-missing-without-tombstone: verify reports missing_without_tombstone and exits 1 (source + packaged)', () => {
  perLane('C04', (lane, tmp) => {
    rmSync(join(tmp, 'docs/plans/example.md'));
    const result = spawnKnowledge(lane, tmp, ['verify']);
    assert.equal(result.status, 1, `verify must fail (exit ${result.status})\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.deepEqual(report.errors, [{
      entry: 'example-repo:plan:example',
      error: 'missing_without_tombstone',
      detail: 'docs/plans/example.md',
    }]);
  });
});

// ---------------------------------------------------------------------------
// C05 — path traversal
// ---------------------------------------------------------------------------

test('XSKP-P4-02 C05-path-traversal: verify reports unsafe_path (traversal) and exits 1 (source + packaged)', () => {
  perLane('C05', (lane, tmp) => {
    const entryPath = join(tmp, ENTRY_FILE_REL);
    const entry = JSON.parse(readFileSync(entryPath, 'utf8'));
    entry.canonical.path = '../outside.md';
    writeFileSync(entryPath, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
    const result = spawnKnowledge(lane, tmp, ['verify']);
    assert.equal(result.status, 1, `verify must fail (exit ${result.status})\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0].error, 'unsafe_path');
    assert.match(report.errors[0].detail, /traversal/);
  });
});

// ---------------------------------------------------------------------------
// C06 — symlink component
// ---------------------------------------------------------------------------

test('XSKP-P4-02 C06-symlink-component: verify reports unsafe_path (symlink_component) and exits 1 (source + packaged)', () => {
  perLane('C06', (lane, tmp) => {
    const outside = mkdtempSync(join(tmpdir(), 'ai-catapult-kc-outside-'));
    try {
      rmSync(join(tmp, 'docs/plans'), { recursive: true, force: true });
      symlinkSync(outside, join(tmp, 'docs/plans'), 'dir');
      const result = spawnKnowledge(lane, tmp, ['verify']);
      assert.equal(result.status, 1, `verify must fail (exit ${result.status})\n${result.stderr}`);
      const report = JSON.parse(result.stdout);
      assert.equal(report.ok, false);
      assert.equal(report.errors.length, 1);
      assert.equal(report.errors[0].error, 'unsafe_path');
      assert.match(report.errors[0].detail, /symlink_component/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// C14 — federated read with an absent managed child
// ---------------------------------------------------------------------------

test('XSKP-P4-02 C14-federated-absent-child: find --federated exits 0 and reports the absent child (source + packaged)', () => {
  perLane('C14', (lane, tmp) => {
    mkdirSync(join(tmp, '.ai'), { recursive: true });
    writeFileSync(
      join(tmp, '.ai/matrix.json'),
      `${JSON.stringify({ managed_repositories: [{ path: 'absent-child' }] }, null, 2)}\n`,
      'utf8',
    );
    const result = spawnKnowledge(lane, tmp, ['find', '--federated', 'example']);
    assert.equal(result.status, 0, `find --federated failed (exit ${result.status})\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    // Absence is a report, never a failure.
    assert.deepEqual(report.repositories, [{ path: 'absent-child', status: 'absent' }]);
    assert.deepEqual(report.entries, [EXPECTED_ITEM]);
    assert.equal(report.query, 'example');
  });
});

// ---------------------------------------------------------------------------
// C15 read half — rebuild preserves unknown entry keys
// ---------------------------------------------------------------------------

test('XSKP-P4-02 C15-read-half-unknown-keys-preserved: rebuild keeps x_extra and the aggregate reproduces (source + packaged)', () => {
  perLane('C15', (lane, tmp) => {
    const entryPath = join(tmp, ENTRY_FILE_REL);
    const entry = JSON.parse(readFileSync(entryPath, 'utf8'));
    entry.x_extra = { note: 'unknown keys survive the rebuild' };
    writeFileSync(entryPath, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');

    const rebuild = spawnKnowledge(lane, tmp, ['rebuild']);
    assert.equal(rebuild.status, 0, `rebuild failed (exit ${rebuild.status})\n${rebuild.stderr}`);
    // The rebuilt aggregate is byte-identical to the fixture one: x_extra is
    // entry-level state, not an aggregate field.
    assert.deepEqual(
      readFileSync(join(tmp, EXPECTED_REGISTRY_FILE)),
      readFileSync(join(laneFixtureDir(lane), EXPECTED_REGISTRY_FILE)),
      'rebuilt registry.json must be byte-identical to the fixture aggregate',
    );
    // The entry file still carries the unknown key; the schema preserves it.
    const afterRebuild = JSON.parse(readFileSync(entryPath, 'utf8'));
    assert.deepEqual(afterRebuild.x_extra, { note: 'unknown keys survive the rebuild' });

    // And the registry is fresh afterwards: verify stays green.
    const verify = spawnKnowledge(lane, tmp, ['verify']);
    assert.equal(verify.status, 0, `verify after rebuild failed (exit ${verify.status})\n${verify.stderr}`);
    assert.equal(JSON.parse(verify.stdout).ok, true);
  });
});

// ---------------------------------------------------------------------------
// C16 — serialization vector (code-point key order)
// ---------------------------------------------------------------------------

test('XSKP-P4-02 C16-serialization-vector: serialize output equals the expected vector byte-for-byte (source + packaged)', () => {
  for (const lane of ['source', 'packaged']) {
    const contractDir = laneContractDir(lane);
    // Root must contain the vectors: serialize resolves its source against it,
    // and only reads under the root are trusted.
    const result = spawnKnowledge(lane, contractDir, ['serialize', 'fixtures/vectors/serialization-input.json']);
    assert.equal(result.status, 0, `serialize failed (exit ${result.status})\n${result.stderr}`);
    assert.deepEqual(
      Buffer.from(result.stdout, 'utf8'),
      readFileSync(join(contractDir, 'fixtures/vectors/serialization-expected.json')),
      'serialized bytes must equal fixtures/vectors/serialization-expected.json: keys order by Unicode code point (x_ｚ U+FF5A before x_😀 U+1F600), non-ASCII literal (ensure_ascii=False), indent=2, trailing newline',
    );
  }
});

// ---------------------------------------------------------------------------
// C18 — stale lock reported, never removed
// ---------------------------------------------------------------------------

test('XSKP-P4-02 C18-stale-lock-reported: verify warns stale_lock, exits 0, keeps the lock (source + packaged)', () => {
  perLane('C18', (lane, tmp) => {
    const pid = deadPid();
    const lockDir = join(tmp, '.ai/knowledge/.locks/example-repo__plan__example.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'owner.json'), `${JSON.stringify({ pid })}\n`, 'utf8');

    const result = spawnKnowledge(lane, tmp, ['verify']);
    assert.equal(result.status, 0, `verify must pass (exit ${result.status})\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.checked, 1);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.warnings, [{
      lock: '.ai/knowledge/.locks/example-repo__plan__example.lock',
      warning: 'stale_lock',
      pid,
    }]);
    // Stale locks are reported, never removed automatically.
    assert.equal(existsSync(lockDir), true, 'verify must not remove the lock');
  });
});

// ---------------------------------------------------------------------------
// list smoke (AC names list; no dedicated C-case)
// ---------------------------------------------------------------------------

test('XSKP-P4-02 list-smoke: list emits the fixture aggregate item and no skipped fixtures (source + packaged)', () => {
  perLane('list', (lane, tmp) => {
    const result = spawnKnowledge(lane, tmp, ['list']);
    assert.equal(result.status, 0, `list failed (exit ${result.status})\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report, { entries: [EXPECTED_ITEM], skipped: [] });
  });
});

// ---------------------------------------------------------------------------
// Review regressions — codex PR #56 round 1 (F1 major, F2 minor)
// ---------------------------------------------------------------------------

test('XSKP-P4-02 review-r1 F1: serialize rejects an in-root symlink source (source + packaged)', () => {
  perLane('r1-symlink', (lane, tmp) => {
    symlinkSync(join(tmp, EXPECTED_REGISTRY_FILE), join(tmp, 'alias.json'));
    const result = spawnKnowledge(lane, tmp, ['serialize', 'alias.json']);
    assert.equal(result.status, 1, `serialize must reject the symlink source (exit ${result.status})\n${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), {
      error: 'unsafe_path',
      detail: 'alias.json: symlink_component',
    });
  });
});

test('XSKP-P4-02 review-r1 F1: serialize rejects traversal, even when normalization would hide it (source + packaged)', () => {
  perLane('r1-traversal', (lane, tmp) => {
    // resolvePath(join(root, source)) normalizes to docs/plans/example.md — an
    // existing file — so resolve-first ordering silently accepts the `..`
    // segment. The component-wise check must run before resolution.
    const normalized = spawnKnowledge(lane, tmp, ['serialize', 'docs/plans/../plans/example.md']);
    assert.equal(normalized.status, 1, `serialize must reject the traversal source (exit ${normalized.status})\n${normalized.stderr}`);
    assert.deepEqual(JSON.parse(normalized.stdout), {
      error: 'unsafe_path',
      detail: 'docs/plans/../plans/example.md: traversal',
    });
    const escape = spawnKnowledge(lane, tmp, ['serialize', '../escapes.json']);
    assert.equal(escape.status, 1, `traversal must exit 1 (exit ${escape.status})\n${escape.stderr}`);
    assert.deepEqual(JSON.parse(escape.stdout), {
      error: 'unsafe_path',
      detail: '../escapes.json: traversal',
    });
  });
});

test('XSKP-P4-02 review-r1 F2: verify rejects extra positional args with usage exit 2 (source + packaged)', () => {
  perLane('r1-verify-extra', (lane, tmp) => {
    const withRoot = spawnKnowledge(lane, tmp, ['verify', 'unexpected']);
    assert.equal(withRoot.status, 2, `verify with an extra positional must be a usage error (exit ${withRoot.status})\n${withRoot.stderr}`);
    assert.ok(withRoot.stderr.startsWith('ai-catapult knowledge: unrecognized arguments'), withRoot.stderr);
    // Usage errors must also precede any root resolution, so run without
    // --root (root defaults to cwd) on an otherwise valid fixture root.
    const withoutRoot = spawnSync(
      process.execPath,
      [join(laneRoot(lane), 'bin/ai-catapult.js'), 'knowledge', 'verify', 'unexpected'],
      {
        encoding: 'utf8', cwd: tmp, timeout: 30_000,
        env: { ...process.env, AI_CATAPULT_DIST_ROOT: lane === 'source' ? DIST_SNAPSHOT : join(packaged.dir, 'dist') },
      },
    );
    assert.equal(withoutRoot.status, 2, `verify with an extra positional must be a usage error, with or without --root (exit ${withoutRoot.status})\n${withoutRoot.stderr}`);
    assert.ok(withoutRoot.stderr.startsWith('ai-catapult knowledge: unrecognized arguments'), withoutRoot.stderr);
  });
});
// ===========================================================================
// XSKP-P4-03 — write verbs (publish / archive / retire / unlock)
// ===========================================================================

const LANES = ['source', 'packaged'];
const EXAMPLE_ID = 'example-repo:plan:example';
const EXAMPLE_DOC = 'docs/plans/example.md';
const ENTRY_LOCK_REL = '.ai/knowledge/.locks/example-repo__plan__example.json.lock';
const CLAIM_NAME = /^example-repo__plan__example\.json\.unlocking-[0-9]+-[0-9a-f-]{36}\.lock$/;
/** The name an unlock run by claimerPid gives a lock it is removing. */
function claimRel(claimerPid) {
  return `.ai/knowledge/.locks/example-repo__plan__example.json.unlocking-${claimerPid}-${randomUUID()}.lock`;
}
/** The refusal a writer of another identity gets while lockRel is held. */
function serialized(lockRel) {
  return { error: 'locked', detail: `${lockRel}: held by another writer; writers are serialized (unlock it if stale)` };
}
const LOCK_EVENTS_REL = '.ai/knowledge/lock-events.jsonl';
const LOCKED = { error: 'locked', detail: 'entry lock already exists; explicit unlock required' };
const POLICY = JSON.parse(readFileSync(join(SOURCE_CONTRACT, 'publication-policy.json'), 'utf8'));

// ---------------------------------------------------------------------------
// AC-7 executable guard
// ---------------------------------------------------------------------------

/**
 * The policy's glob semantics, ported here independently of src/: `*` stays
 * inside one path component, `**\/` spans zero or more directories.
 */
function policyGlob(path, pattern) {
  let expression = '';
  for (let i = 0; i < pattern.length;) {
    if (pattern.startsWith('**/', i)) {
      expression += '(?:.*/)?';
      i += 3;
    } else if (pattern.startsWith('**', i)) {
      expression += '.*';
      i += 2;
    } else if (pattern[i] === '*') {
      expression += '[^/]*';
      i += 1;
    } else {
      expression += pattern[i].replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${expression}$`, 's').test(path);
}

// AC-7 scope: every native-artifact rule and every immutable path the policy names.
const GUARDED_GLOBS = [...POLICY.native_rules.map((rule) => rule.glob), ...POLICY.immutable];
// Walk only the literal directory prefix of each glob.
const GUARDED_ROOTS = [...new Set(GUARDED_GLOBS.map((glob) => {
  const parts = glob.split('/');
  const wild = parts.findIndex((part) => part.includes('*'));
  return (wild < 0 ? parts : parts.slice(0, wild)).join('/');
}))];

/** sha256 of every native/immutable file under dir; symlinks recorded, never followed. */
function guardedDigests(dir) {
  const found = new Set();
  const visit = (rel) => {
    const abs = join(dir, rel);
    let info;
    try {
      info = lstatSync(abs);
    } catch {
      return;
    }
    if (info.isDirectory()) {
      for (const name of readdirSync(abs)) visit(`${rel}/${name}`);
      return;
    }
    if (!GUARDED_GLOBS.some((glob) => policyGlob(rel, glob))) return;
    found.add(info.isSymbolicLink() ? `${rel} -> ${readlinkSync(abs)}` : `${rel} ${sha256File(abs)}`);
  };
  for (const prefix of GUARDED_ROOTS) visit(prefix);
  return [...found].sort();
}

function checkoutSnapshot() {
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: root, encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(status.status, 0, `git status failed\n${status.stderr}`);
  return { status: status.stdout, digests: guardedDigests(root) };
}

/**
 * AC-7: run a write-verb body and prove the real checkout kept its
 * `git status --porcelain` and every native/immutable digest across it. A
 * failing body still reports a guard violation; a guard violation never hides
 * a failing body.
 */
async function ac7Guarded(name, body) {
  const before = checkoutSnapshot();
  let failure = null;
  try {
    await body();
  } catch (error) {
    failure = error;
  }
  const after = checkoutSnapshot();
  if (failure) {
    if (!isDeepStrictEqual(after, before)) failure.message += `\nAC-7: ${name} also changed the checkout`;
    throw failure;
  }
  assert.deepEqual(after, before, `AC-7: ${name} changed the checkout's git status or a native/immutable file`);
}

function gitIn(dir, ...args) {
  const result = spawnSync('git', [
    '-c', 'user.name=Conformance', '-c', 'user.email=conformance@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args,
  ], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed\n${result.stderr}`);
  return result.stdout.trim();
}

/**
 * Run body once per lane on a fresh staged fixture carrying the repo profile
 * the writer reads, inside the AC-7 guard. The staged root's own
 * native/immutable digests are compared before and after each lane too: a
 * write verb may add entries and canonical documents, never touch a native
 * artifact or an immutable file.
 */
async function writeCase(name, { mutate, git = false } = {}, body) {
  await ac7Guarded(name, async () => {
    for (const lane of LANES) {
      const tmp = stageFixture(lane, (dir) => {
        mkdirSync(join(dir, '.ai/init'), { recursive: true });
        writeFileSync(
          join(dir, '.ai/init/repo-profile.json'),
          `${JSON.stringify({ repo_id: 'example-repo' }, null, 2)}\n`,
          'utf8',
        );
        if (mutate) mutate(dir);
      });
      try {
        if (git) {
          gitIn(tmp, 'init', '-q');
          gitIn(tmp, 'add', '-A');
          gitIn(tmp, 'commit', '-q', '-m', 'conformance fixture');
        }
        const before = guardedDigests(tmp);
        await body(lane, tmp);
        assert.deepEqual(
          guardedDigests(tmp),
          before,
          `AC-7: ${name} (${lane}) changed a native or immutable file in the staged root`,
        );
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Real concurrent writers
// ---------------------------------------------------------------------------

function spawnKnowledgeAsync(lane, rootDir, args, extraEnv = {}) {
  const cli = join(laneRoot(lane), 'bin/ai-catapult.js');
  const distRoot = lane === 'source' ? DIST_SNAPSHOT : join(packaged.dir, 'dist');
  const child = spawn(process.execPath, [cli, 'knowledge', '--root', rootDir, ...args], {
    env: { ...process.env, AI_CATAPULT_DIST_ROOT: distRoot, ...extraEnv },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolveExit, reject) => {
    child.on('error', reject);
    child.on('close', (status, signal) => resolveExit({ status, signal, stdout, stderr }));
  });
  return { child, exited };
}

function lockOwnerPid(tmp, lockRel = ENTRY_LOCK_REL) {
  try {
    return JSON.parse(readFileSync(join(tmp, lockRel, 'owner.json'), 'utf8')).pid;
  } catch {
    return undefined;
  }
}

/** Await a child's exit, killing and failing it past a deadline so CI never hangs. */
async function exitWithin(writer, what, timeoutMs = 30_000) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      writer.child.kill('SIGKILL');
      reject(new Error(`${what} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([writer.exited, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Kill (if still running) and reap a writer, bounded; a parked writer's FIFO end is closed. */
async function reap(writer) {
  writer.child.kill('SIGKILL');
  const result = await exitWithin(writer, 'a killed writer', 10_000);
  if (writer.fd !== undefined && writer.fd !== null) {
    closeSync(writer.fd);
    writer.fd = null;
  }
  return result;
}

/**
 * Park a real writer inside its critical section. A FIFO in the entries
 * directory blocks the writer's entry scan, which runs only after it took its
 * entry lock and passed the writer serialization check. The FIFO's write end
 * opens (non-blocking; ENXIO until then) only once that reader exists, which
 * proves the writer is parked there; holding the end open keeps it parked.
 * No test hook in src/.
 */
async function parkPublisher(lane, tmp, args, extraEnv = {}) {
  const fifo = join(tmp, '.ai/knowledge/entries/example-repo__plan__zz-parked.json');
  const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
  assert.equal(made.status, 0, `mkfifo failed\n${made.stderr}`);
  const writer = spawnKnowledgeAsync(lane, tmp, args, extraEnv);
  const deadline = Date.now() + 20_000;
  while (writer.fd === undefined) {
    try {
      writer.fd = openSync(fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
    } catch (error) {
      const exited = writer.child.exitCode !== null || writer.child.signalCode !== null;
      if (error.code !== 'ENXIO' || exited || Date.now() > deadline) {
        const result = await reap(writer);
        throw new Error(`the writer never parked (${error.code}${exited ? ', exited' : ''})\n${result.stdout}${result.stderr}`);
      }
      await new Promise((wake) => setTimeout(wake, 25));
    }
  }
  return Object.assign(writer, { fifo });
}

/** Release a parked writer: hand its entry scan one valid entry, then EOF. */
function feedParked(parked, bytes) {
  try {
    writeSync(parked.fd, bytes);
  } finally {
    closeSync(parked.fd);
    parked.fd = null;
  }
}

/** A valid entry for the parked scan, pointing at a real canonical file. */
function parkedEntryBytes(tmp) {
  const doc = 'docs/plans/zz-parked.md';
  writeFileSync(join(tmp, doc), '# Parked\n', 'utf8');
  return `${JSON.stringify({
    canonical: { format: 'markdown', frontmatter_id: false, immutable: false, path: doc },
    kind: 'plan',
    knowledge_id: 'example-repo:plan:zz-parked',
    lifecycle: 'active',
    origin: { host: 'none', native: false, producer: 'manual', surface: 'workspace' },
    relations: [],
    repo_id: 'example-repo',
    revisions: [{
      derived_from: [],
      evidence_class: 'verified-current',
      published_at: '2026-10-10T00:00:00Z',
      rev: 1,
      sha256: sha256File(join(tmp, doc)),
    }],
    schema: 'knowledge-registry/1',
    title: 'Parked',
    tombstone: null,
  }, null, 2)}\n`;
}

function readLedger(dir, rel) {
  return readFileSync(join(dir, rel), 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line));
}

function laneModuleUrl(lane) {
  return pathToFileURL(join(laneRoot(lane), 'src/knowledge.js')).href;
}

// ---------------------------------------------------------------------------
// Usage shapes
// ---------------------------------------------------------------------------

test('XSKP-P4-03 usage: write verbs reject missing arguments with exit 2 (source + packaged)', async () => {
  await writeCase('usage', {}, (lane, tmp) => {
    const cases = [
      [['publish'], 'the following arguments are required: path'],
      [['archive'], 'the following arguments are required: id'],
      [['retire', EXAMPLE_ID], 'the following arguments are required: --reason'],
      [['retire'], 'the following arguments are required: id, --reason'],
      [['unlock', EXAMPLE_ID], 'the following arguments are required: --confirm-no-writer'],
      [['publish', EXAMPLE_DOC, '--unknown'], 'unrecognized argument: --unknown'],
    ];
    for (const [args, message] of cases) {
      const result = spawnKnowledge(lane, tmp, args);
      assert.equal(result.status, 2, `${JSON.stringify(args)} must be a usage error (exit ${result.status})\n${result.stderr}`);
      assert.ok(result.stderr.startsWith(`ai-catapult knowledge: ${message}`), `${JSON.stringify(args)}\n${result.stderr}`);
      assert.equal(result.stdout, '');
    }
    assert.equal(existsSync(join(tmp, '.ai/knowledge/.locks')), false, 'usage errors never take a lock');
  });
});

// ---------------------------------------------------------------------------
// C07 — denied source
// ---------------------------------------------------------------------------

test('XSKP-P4-03 C07-denied-source: publish refuses a deny-listed path with denied_private (source + packaged)', async () => {
  await writeCase('C07', {
    mutate: (dir) => {
      mkdirSync(join(dir, '.omo/run-continuation'), { recursive: true });
      writeFileSync(join(dir, '.omo/run-continuation/ses_x.json'), '{"session": "x"}\n', 'utf8');
    },
  }, (lane, tmp) => {
    const registryBefore = readFileSync(join(tmp, EXPECTED_REGISTRY_FILE));
    const result = spawnKnowledge(lane, tmp, ['publish', '.omo/run-continuation/ses_x.json']);
    assert.equal(result.status, 1, `publish of a private path must exit 1 (exit ${result.status})\n${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), { error: 'denied_private', detail: 'source is private' });
    assert.deepEqual(readdirSync(join(tmp, '.ai/knowledge/entries')), ['example-repo__plan__example.json']);
    assert.deepEqual(readFileSync(join(tmp, EXPECTED_REGISTRY_FILE)), registryBefore);
  });
});

// ---------------------------------------------------------------------------
// C08 — secret in content; the (?i) inline flag becomes the JS i flag
// ---------------------------------------------------------------------------

test('XSKP-P4-03 C08-secret-in-content: publish refuses a runtime-assembled AWS key shape (source + packaged)', async () => {
  // Assembled at runtime, never stored literally (conformance C08 mutate rule).
  const awsShaped = 'AKIA' + '0'.repeat(16);
  await writeCase('C08', {
    mutate: (dir) => writeFileSync(join(dir, 'docs/leak.md'), `# Leak\n\nkey ${awsShaped}\n`, 'utf8'),
  }, (lane, tmp) => {
    const result = spawnKnowledge(lane, tmp, ['publish', 'docs/leak.md']);
    assert.equal(result.status, 1, `publish must refuse secret content (exit ${result.status})\n${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), { error: 'secret_detected', detail: 'source contains a secret-shaped value' });
    assert.equal(existsSync(join(tmp, '.ai/knowledge/entries/example-repo__doc__leak.json')), false);
    assert.equal(readFileSync(join(tmp, 'docs/leak.md'), 'utf8'), `# Leak\n\nkey ${awsShaped}\n`, 'a refused source is never rewritten');
  });
});

test('XSKP-P4-03 C08 (?i) translation: the inline-flag pattern compiles to the JS i flag and matches any case (source + packaged)', async () => {
  const raw = POLICY.deny.secret_patterns.find((pattern) => pattern.startsWith('(?i)'));
  assert.ok(raw, 'the frozen policy carries an inline (?i) secret pattern');
  // Why the translation exists: JavaScript has no leading inline-flag group.
  assert.throws(() => new RegExp(raw), SyntaxError);
  // Runtime-assembled probes; only a case-insensitive match catches the upper-case key.
  const upper = `TOKEN: ${'x'.repeat(20)}`;
  const mixed = `Password = "${'Ab9'.repeat(6)}"`;
  const control = 'TOKEN: short';
  await writeCase('C08-flag', {
    mutate: (dir) => {
      writeFileSync(join(dir, 'docs/upper.md'), `# Upper\n\n${upper}\n`, 'utf8');
      writeFileSync(join(dir, 'docs/mixed.md'), `# Mixed\n\n${mixed}\n`, 'utf8');
      writeFileSync(join(dir, 'docs/control.md'), `# Control\n\n${control}\n`, 'utf8');
    },
  }, (lane, tmp) => {
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', [
      'const { compileSecretPattern } = await import(process.argv[1]);',
      'const compiled = compileSecretPattern(process.argv[2]);',
      'process.stdout.write(JSON.stringify({ source: compiled.source, flags: compiled.flags,',
      '  upper: compiled.test(process.argv[3]), lower: compiled.test(process.argv[3].toLowerCase()) }));',
    ].join('\n'), laneModuleUrl(lane), raw, upper], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(probe.status, 0, `compileSecretPattern probe failed\n${probe.stderr}`);
    const compiled = JSON.parse(probe.stdout);
    assert.equal(compiled.source, new RegExp(raw.slice('(?i)'.length)).source, 'only the (?i) prefix is removed');
    assert.ok(compiled.flags.includes('i'), `the translated pattern carries the i flag (got ${compiled.flags})`);
    assert.equal(compiled.upper, true);
    assert.equal(compiled.lower, true);

    for (const doc of ['docs/upper.md', 'docs/mixed.md']) {
      const result = spawnKnowledge(lane, tmp, ['publish', doc]);
      assert.equal(result.status, 1, `${doc} must be refused (exit ${result.status})\n${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stdout), { error: 'secret_detected', detail: 'source contains a secret-shaped value' });
    }
    // A short value is no secret shape: the translation does not over-match.
    const control = spawnKnowledge(lane, tmp, ['publish', 'docs/control.md']);
    assert.equal(control.status, 0, `the control document must publish (exit ${control.status})\n${control.stdout}${control.stderr}`);
    assert.equal(JSON.parse(control.stdout).knowledge_id, 'example-repo:doc:control');
  });
});

// ---------------------------------------------------------------------------
// C09 — id reuse after retire
// ---------------------------------------------------------------------------

test('XSKP-P4-03 C09-id-reuse: retire writes the tombstone; republishing the retired id fails id_reused (source + packaged)', async () => {
  await writeCase('C09', {
    mutate: (dir) => writeFileSync(join(dir, 'docs/plans/replacement.md'), '# Replacement\n', 'utf8'),
  }, (lane, tmp) => {
    const retire = spawnKnowledge(lane, tmp, ['retire', EXAMPLE_ID, '--reason', 'superseded by replacement']);
    assert.equal(retire.status, 0, `retire must exit 0 (exit ${retire.status})\n${retire.stdout}${retire.stderr}`);
    const retired = JSON.parse(retire.stdout);
    assert.equal(retired.lifecycle, 'retired');
    assert.equal(retired.tombstone.reason, 'superseded by replacement');
    assert.equal(retired.tombstone.last_sha256, CANONICAL_SHA256);
    assert.match(retired.tombstone.retired_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
    assert.deepEqual(JSON.parse(readFileSync(join(tmp, ENTRY_FILE_REL), 'utf8')), retired);
    assert.equal(JSON.parse(readFileSync(join(tmp, EXPECTED_REGISTRY_FILE), 'utf8')).entries[0].lifecycle, 'retired');

    const reuse = spawnKnowledge(lane, tmp, ['publish', 'docs/plans/replacement.md', '--id', EXAMPLE_ID]);
    assert.equal(reuse.status, 1, `republishing a retired id must exit 1 (exit ${reuse.status})\n${reuse.stderr}`);
    assert.deepEqual(JSON.parse(reuse.stdout), { error: 'id_reused', detail: 'retired identity cannot be reused' });
    assert.equal(readFileSync(join(tmp, 'docs/plans/replacement.md'), 'utf8'), '# Replacement\n');

    // The tombstone keeps the entry valid once the caller removes the canonical file.
    rmSync(join(tmp, EXAMPLE_DOC));
    const verify = spawnKnowledge(lane, tmp, ['verify']);
    assert.equal(verify.status, 0, `verify after retire must pass (exit ${verify.status})\n${verify.stdout}`);
    assert.equal(JSON.parse(verify.stdout).ok, true);
  });
});

// ---------------------------------------------------------------------------
// C10 — revision append
// ---------------------------------------------------------------------------

test('XSKP-P4-03 C10-revision-append: republishing an edited canonical appends rev 2 and keeps rev 1 (source + packaged)', async () => {
  await writeCase('C10', {
    mutate: (dir) => appendFileSync(join(dir, EXAMPLE_DOC), '\nSecond pass.\n', 'utf8'),
  }, (lane, tmp) => {
    const edited = sha256File(join(tmp, EXAMPLE_DOC));
    const publish = spawnKnowledge(lane, tmp, ['publish', EXAMPLE_DOC]);
    assert.equal(publish.status, 0, `publish must exit 0 (exit ${publish.status})\n${publish.stdout}${publish.stderr}`);
    const entry = JSON.parse(publish.stdout);
    assert.deepEqual(entry.revisions.map((revision) => [revision.rev, revision.sha256]), [[1, CANONICAL_SHA256], [2, edited]]);
    assert.deepEqual(entry.revisions[1].derived_from, [{
      classification: 'canonical', path: EXAMPLE_DOC, sha256: edited, surface: 'workspace',
    }]);
    // First-revision metadata is kept, not re-derived.
    assert.deepEqual(entry.origin, { host: 'opencode', native: true, producer: 'prometheus', surface: 'omo' });
    assert.equal(entry.title, 'Example plan');
    assert.equal(sha256File(join(tmp, EXAMPLE_DOC)), edited, 'a canonical that already carries its id is not rewritten');
    assert.equal(readFileSync(join(tmp, ENTRY_FILE_REL), 'utf8'), publish.stdout, 'the entry file holds the canonical bytes the writer printed');

    const show = spawnKnowledge(lane, tmp, ['show', EXAMPLE_ID]);
    assert.equal(show.status, 0, `show must verify rev 2 (exit ${show.status})\n${show.stdout}`);
    const shown = JSON.parse(show.stdout);
    assert.equal(shown.revisions.at(-1).rev, 2);
    assert.equal(shown.revisions[0].sha256, CANONICAL_SHA256, 'previous revision kept');
    const check = spawnKnowledge(lane, tmp, ['rebuild', '--check']);
    assert.equal(check.status, 0, `the written aggregate must reproduce (exit ${check.status})\n${check.stdout}`);
  });
});

// ---------------------------------------------------------------------------
// C11 — frontmatter merge
// ---------------------------------------------------------------------------

test('XSKP-P4-03 C11-frontmatter-merge: only knowledge_id is added; existing keys and body are kept (source + packaged)', async () => {
  const original = '---\ntitle: Custom title\nowner: docs-team\n---\n\n# Custom title\n\nBody text.\n';
  await writeCase('C11', {
    mutate: (dir) => writeFileSync(join(dir, 'docs/mergeme.md'), original, 'utf8'),
  }, (lane, tmp) => {
    const publish = spawnKnowledge(lane, tmp, ['publish', 'docs/mergeme.md']);
    assert.equal(publish.status, 0, `publish must exit 0 (exit ${publish.status})\n${publish.stdout}${publish.stderr}`);
    const merged = '---\nknowledge_id: example-repo:doc:mergeme\ntitle: Custom title\nowner: docs-team\n---\n\n# Custom title\n\nBody text.\n';
    assert.equal(readFileSync(join(tmp, 'docs/mergeme.md'), 'utf8'), merged);
    const entry = JSON.parse(publish.stdout);
    assert.equal(entry.knowledge_id, 'example-repo:doc:mergeme');
    assert.deepEqual(entry.canonical, { format: 'markdown', frontmatter_id: true, immutable: false, path: 'docs/mergeme.md' });
    assert.deepEqual(entry.origin, { host: 'none', native: false, producer: 'manual', surface: 'workspace' });
    assert.equal(entry.revisions[0].sha256, sha256File(join(tmp, 'docs/mergeme.md')));
    assert.deepEqual(entry.revisions[0].derived_from, [{
      classification: 'canonical', path: 'docs/mergeme.md', sha256: createHash('sha256').update(original).digest('hex'), surface: 'workspace',
    }]);
    // Republishing the merged file is a no-op on its bytes (merge, never overwrite).
    const again = spawnKnowledge(lane, tmp, ['publish', 'docs/mergeme.md']);
    assert.equal(again.status, 0, `republish must exit 0 (exit ${again.status})\n${again.stdout}`);
    assert.equal(readFileSync(join(tmp, 'docs/mergeme.md'), 'utf8'), merged);
    // A conflicting frontmatter id is refused, never overwritten.
    const conflict = spawnKnowledge(lane, tmp, ['publish', 'docs/mergeme.md', '--id', 'example-repo:doc:other']);
    assert.equal(conflict.status, 1);
    assert.deepEqual(JSON.parse(conflict.stdout), { error: 'id_conflict', detail: 'frontmatter identity differs' });
  });
});

// ---------------------------------------------------------------------------
// C12 — immutable source published in place
// ---------------------------------------------------------------------------

test('XSKP-P4-03 C12-immutable-no-rewrite: an immutable path is registered in place, bytes unchanged, no frontmatter id (source + packaged)', async () => {
  const handoff = '.ai/handoff/readiness-v1/example-plan/0123abcd/handoff.md';
  await writeCase('C12', {
    mutate: (dir) => {
      mkdirSync(dirname(join(dir, handoff)), { recursive: true });
      writeFileSync(join(dir, handoff), '# Frozen handoff\n\nNo frontmatter here.\n', 'utf8');
    },
  }, (lane, tmp) => {
    const before = sha256File(join(tmp, handoff));
    const publish = spawnKnowledge(lane, tmp, ['publish', handoff]);
    assert.equal(publish.status, 0, `publish must exit 0 (exit ${publish.status})\n${publish.stdout}${publish.stderr}`);
    assert.equal(sha256File(join(tmp, handoff)), before, 'immutable bytes are never rewritten');
    const entry = JSON.parse(publish.stdout);
    assert.equal(entry.knowledge_id, 'example-repo:doc:handoff');
    assert.deepEqual(entry.canonical, { format: 'markdown', frontmatter_id: false, immutable: true, path: handoff });
    assert.equal(entry.revisions[0].sha256, before);
    const verify = spawnKnowledge(lane, tmp, ['verify']);
    assert.equal(verify.status, 0, `verify after an immutable publish must pass (exit ${verify.status})\n${verify.stdout}`);
    // An immutable entry is never retired or rewritten through a lifecycle verb.
    const retire = spawnKnowledge(lane, tmp, ['retire', 'example-repo:doc:handoff', '--reason', 'no']);
    assert.equal(retire.status, 1);
    assert.equal(JSON.parse(retire.stdout).error, 'unsafe_target');
  });
});

// ---------------------------------------------------------------------------
// C13 — two concurrent publishes of one knowledge_id
// ---------------------------------------------------------------------------

test('XSKP-P4-03 C13-lock-contention: of two concurrent publishes one exits 0, the other fails locked at once (source + packaged)', async () => {
  await writeCase('C13', {
    mutate: (dir) => appendFileSync(join(dir, EXAMPLE_DOC), '\nConcurrent pass.\n', 'utf8'),
  }, async (lane, tmp) => {
    const holder = await parkPublisher(lane, tmp, ['publish', EXAMPLE_DOC]);
    try {
      const contender = spawnKnowledge(lane, tmp, ['publish', EXAMPLE_DOC]);
      assert.equal(contender.status, 1, `the contender must fail (exit ${contender.status})\n${contender.stdout}${contender.stderr}`);
      assert.deepEqual(JSON.parse(contender.stdout), LOCKED);
      // Immediately: it returned while the holder still owns the lock.
      assert.equal(holder.child.exitCode, null, 'the contender must not wait for the holder');
      assert.equal(lockOwnerPid(tmp), holder.child.pid, 'the contender must not touch the holder\'s lock');

      feedParked(holder, parkedEntryBytes(tmp));
      const done = await exitWithin(holder, 'the released holder');
      assert.equal(done.status, 0, `the holder must complete (exit ${done.status})\n${done.stdout}${done.stderr}`);
      assert.deepEqual(JSON.parse(done.stdout).revisions.map((revision) => revision.rev), [1, 2]);
    } finally {
      await reap(holder);
    }
    assert.equal(existsSync(join(tmp, ENTRY_LOCK_REL)), false, 'the holder releases its own lock');
    // Swap the drained FIFO for a regular file so later scans read the same entry.
    rmSync(holder.fifo);
    writeFileSync(holder.fifo, parkedEntryBytes(tmp), 'utf8');
    const check = spawnKnowledge(lane, tmp, ['rebuild', '--check']);
    assert.equal(check.status, 0, `the holder's aggregate must reproduce (exit ${check.status})\n${check.stdout}`);
  });
});

// ---------------------------------------------------------------------------
// C15 write half — unknown keys survive rebuild then republish
// ---------------------------------------------------------------------------

test('XSKP-P4-03 C15-write-half: rebuild then republish preserves x_extra (source + packaged)', async () => {
  await writeCase('C15-write', {
    mutate: (dir) => {
      const entryPath = join(dir, ENTRY_FILE_REL);
      const entry = JSON.parse(readFileSync(entryPath, 'utf8'));
      entry.x_extra = { nested: { kept: true }, note: 'unknown keys survive writes' };
      writeFileSync(entryPath, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
    },
  }, (lane, tmp) => {
    const rebuild = spawnKnowledge(lane, tmp, ['rebuild']);
    assert.equal(rebuild.status, 0, `rebuild must exit 0 (exit ${rebuild.status})\n${rebuild.stdout}`);
    appendFileSync(join(tmp, EXAMPLE_DOC), '\nRepublished.\n', 'utf8');
    const publish = spawnKnowledge(lane, tmp, ['publish', EXAMPLE_DOC]);
    assert.equal(publish.status, 0, `publish must exit 0 (exit ${publish.status})\n${publish.stdout}${publish.stderr}`);
    const written = JSON.parse(readFileSync(join(tmp, ENTRY_FILE_REL), 'utf8'));
    assert.deepEqual(written.x_extra, { nested: { kept: true }, note: 'unknown keys survive writes' });
    assert.equal(written.revisions.length, 2);
    assert.deepEqual(JSON.parse(publish.stdout).x_extra, written.x_extra);
  });
});

// ---------------------------------------------------------------------------
// C17 — dispatcher forwarding
// ---------------------------------------------------------------------------

test('XSKP-P4-03 C17-dispatcher-forwarding: `ai-catapult knowledge` forwards argv verbatim and returns the writer\'s exit and streams (source + packaged)', async () => {
  await writeCase('C17', {
    mutate: (dir) => {
      mkdirSync(join(dir, '.omo/run-continuation'), { recursive: true });
      writeFileSync(join(dir, '.omo/run-continuation/ses_x.json'), '{}\n', 'utf8');
    },
  }, (lane, tmp) => {
    const argvs = [
      ['publish', '--kind', 'spec', 'a b', '', '--', '--not-a-flag'],
      ['publish', '.omo/run-continuation/ses_x.json'],
      ['unlock', EXAMPLE_ID],
      ['retire', EXAMPLE_ID, '--reason', 'forwarded verbatim'],
    ];
    const exits = [];
    for (const argv of argvs) {
      const viaDispatcher = spawnKnowledge(lane, tmp, argv);
      const direct = spawnSync(process.execPath, ['--input-type=module', '-e', [
        'const { runKnowledge } = await import(process.argv[1]);',
        'process.exitCode = runKnowledge(JSON.parse(process.argv[2]));',
      ].join('\n'), laneModuleUrl(lane), JSON.stringify(['--root', tmp, ...argv])], { encoding: 'utf8', timeout: 30_000 });
      assert.deepEqual(
        { status: viaDispatcher.status, stdout: viaDispatcher.stdout, stderr: viaDispatcher.stderr },
        { status: direct.status, stdout: direct.stdout, stderr: direct.stderr },
        `dispatcher and writer must agree for ${JSON.stringify(argv)}`,
      );
      exits.push(viaDispatcher.status);
    }
    assert.deepEqual(exits, [2, 1, 2, 0], 'the probes cover usage, refusal and success');
  });
});

// ---------------------------------------------------------------------------
// C18 + C19 — a stale lock is reported, never removed automatically; manual
// unlock is explicit and ledgered
// ---------------------------------------------------------------------------

test('XSKP-P4-03 C18/C19 stale lock from a killed writer: reported, never stolen, unlocked only with --confirm-no-writer (source + packaged)', async () => {
  await writeCase('C19', {}, async (lane, tmp) => {
    // A real writer dies inside its critical section and leaves its lock.
    const holder = await parkPublisher(lane, tmp, ['publish', EXAMPLE_DOC]);
    const pid = holder.child.pid;
    const killed = await reap(holder);
    assert.equal(killed.signal, 'SIGKILL');
    rmSync(holder.fifo);
    const lockDir = join(tmp, ENTRY_LOCK_REL);
    const ownerBytes = readFileSync(join(lockDir, 'owner.json'));
    assert.equal(JSON.parse(ownerBytes).pid, pid);
    assert.deepEqual(readdirSync(join(tmp, '.ai/knowledge/.locks')), [ENTRY_LOCK_REL.split('/').at(-1)],
      'a killed writer leaves exactly its entry lock');

    const verify = spawnKnowledge(lane, tmp, ['verify']);
    assert.equal(verify.status, 0, `verify must report, not fail (exit ${verify.status})\n${verify.stdout}`);
    assert.deepEqual(JSON.parse(verify.stdout).warnings, [{ lock: ENTRY_LOCK_REL, pid, warning: 'stale_lock' }]);

    const blocked = spawnKnowledge(lane, tmp, ['publish', EXAMPLE_DOC]);
    assert.equal(blocked.status, 1);
    assert.deepEqual(JSON.parse(blocked.stdout), LOCKED);
    // Another identity is serialized behind the stale lock, and leaves no lock of its own.
    writeFileSync(join(tmp, 'docs/other.md'), '# Other\n', 'utf8');
    const other = spawnKnowledge(lane, tmp, ['publish', 'docs/other.md']);
    assert.equal(other.status, 1);
    assert.deepEqual(JSON.parse(other.stdout), serialized(ENTRY_LOCK_REL));
    assert.equal(existsSync(join(tmp, '.ai/knowledge/.locks/example-repo__doc__other.json.lock')), false);
    const otherUnlock = spawnKnowledge(lane, tmp, ['unlock', 'example-repo:doc:other', '--confirm-no-writer']);
    assert.equal(otherUnlock.status, 1, 'unlock removes only the named identity\'s lock');
    assert.deepEqual(JSON.parse(otherUnlock.stdout), { error: 'not_locked', detail: 'entry lock directory does not exist' });
    assert.deepEqual(readFileSync(join(lockDir, 'owner.json')), ownerBytes, 'a stale lock is never stolen');

    const refused = spawnKnowledge(lane, tmp, ['unlock', EXAMPLE_ID]);
    assert.equal(refused.status, 2, `unlock without --confirm-no-writer must exit 2 (exit ${refused.status})`);
    assert.ok(refused.stderr.startsWith('ai-catapult knowledge: the following arguments are required: --confirm-no-writer'), refused.stderr);
    assert.deepEqual(readFileSync(join(lockDir, 'owner.json')), ownerBytes);
    assert.equal(existsSync(join(tmp, LOCK_EVENTS_REL)), false, 'a refused unlock writes no ledger line');

    const unlock = spawnKnowledge(lane, tmp, ['unlock', EXAMPLE_ID, '--confirm-no-writer']);
    assert.equal(unlock.status, 0, `confirmed unlock must exit 0 (exit ${unlock.status})\n${unlock.stdout}${unlock.stderr}`);
    assert.equal(existsSync(lockDir), false, 'the confirmed unlock removes the lock');
    assert.deepEqual(readdirSync(join(tmp, '.ai/knowledge/.locks')), [], 'and leaves no claim behind');
    const event = JSON.parse(unlock.stdout);
    assert.equal(event.schema, 'knowledge-lock-event/1');
    assert.equal(event.result, 'applied');
    const lines = readFileSync(join(tmp, LOCK_EVENTS_REL), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 2, 'ledgered as prepared, then applied');
    // Python json.dumps(sort_keys=True) line shape, shared with the root writer.
    for (const line of lines) assert.ok(line.startsWith('{"action": "unlock", "at": '), line);
    const [prepared, applied] = lines.map((line) => JSON.parse(line));
    assert.deepEqual(applied, event);
    assert.deepEqual({ ...prepared, at: applied.at, result: 'applied' }, applied);
    assert.equal(prepared.result, 'prepared');
    assert.deepEqual(
      { action: applied.action, confirm_no_writer: applied.confirm_no_writer, knowledge_id: applied.knowledge_id, lock_path: applied.lock_path },
      { action: 'unlock', confirm_no_writer: true, knowledge_id: EXAMPLE_ID, lock_path: ENTRY_LOCK_REL },
    );
    assert.match(applied.run_id, /^[0-9a-f-]{36}$/);

    // Recovery complete: the next edit publishes normally.
    appendFileSync(join(tmp, EXAMPLE_DOC), '\nAfter recovery.\n', 'utf8');
    const recovered = spawnKnowledge(lane, tmp, ['publish', EXAMPLE_DOC]);
    assert.equal(recovered.status, 0, `publish after unlock must succeed (exit ${recovered.status})\n${recovered.stdout}`);
    assert.deepEqual(JSON.parse(recovered.stdout).revisions.map((revision) => revision.sha256), [
      CANONICAL_SHA256, sha256File(join(tmp, EXAMPLE_DOC)),
    ]);
    const again = spawnKnowledge(lane, tmp, ['unlock', EXAMPLE_ID, '--confirm-no-writer']);
    assert.equal(again.status, 1);
    assert.deepEqual(JSON.parse(again.stdout), { error: 'not_locked', detail: 'entry lock directory does not exist' });
    assert.equal(readFileSync(join(tmp, LOCK_EVENTS_REL), 'utf8').split('\n').filter(Boolean).length, 2);
  });
});

// ---------------------------------------------------------------------------
// Cross-identity serialization (review round 1, F1)
// ---------------------------------------------------------------------------

test('XSKP-P4-03 review-r1 F1: concurrent publishes of two identities to one canonical serialize; the later writer gets locked, then canonical_collision (source + packaged)', async () => {
  await writeCase('r1-cross-collision', {
    mutate: (dir) => writeFileSync(join(dir, 'docs/shared.txt'), 'shared canonical\n', 'utf8'),
  }, async (lane, tmp) => {
    const holder = await parkPublisher(lane, tmp, ['publish', 'docs/shared.txt', '--id', 'example-repo:doc:shared-a']);
    try {
      const contender = spawnKnowledge(lane, tmp, ['publish', 'docs/shared.txt', '--id', 'example-repo:doc:shared-b']);
      assert.equal(contender.status, 1, `the other identity must be serialized (exit ${contender.status})\n${contender.stdout}`);
      assert.deepEqual(JSON.parse(contender.stdout), serialized('.ai/knowledge/.locks/example-repo__doc__shared-a.json.lock'));
      assert.equal(holder.child.exitCode, null, 'the contender must not wait for the holder');
      assert.equal(existsSync(join(tmp, '.ai/knowledge/.locks/example-repo__doc__shared-b.json.lock')), false,
        'the contender releases the entry lock it took');
      feedParked(holder, parkedEntryBytes(tmp));
      const done = await exitWithin(holder, 'the released holder');
      assert.equal(done.status, 0, `the holder must complete (exit ${done.status})\n${done.stdout}${done.stderr}`);
    } finally {
      await reap(holder);
    }
    rmSync(holder.fifo);
    writeFileSync(holder.fifo, parkedEntryBytes(tmp), 'utf8');
    const retry = spawnKnowledge(lane, tmp, ['publish', 'docs/shared.txt', '--id', 'example-repo:doc:shared-b']);
    assert.equal(retry.status, 1);
    assert.deepEqual(JSON.parse(retry.stdout), { error: 'canonical_collision', detail: 'canonical belongs to another identity' });
    assert.equal(existsSync(join(tmp, '.ai/knowledge/entries/example-repo__doc__shared-b.json')), false);
    const verify = spawnKnowledge(lane, tmp, ['verify']);
    assert.equal(verify.status, 0, `one canonical, one owner: verify must pass (exit ${verify.status})\n${verify.stdout}`);
  });
});

test('XSKP-P4-03 review-r1 F1: concurrent archives of two identities cannot both spend one confirmation token (source + packaged)', async () => {
  await writeCase('r1-cross-token', {
    git: true,
    mutate: (dir) => writeFileSync(join(dir, 'docs/plans/second.md'), '# Second\n', 'utf8'),
  }, async (lane, tmp) => {
    const second = spawnKnowledge(lane, tmp, ['publish', 'docs/plans/second.md']);
    assert.equal(second.status, 0, `setup publish failed\n${second.stdout}${second.stderr}`);
    const secondId = JSON.parse(second.stdout).knowledge_id;
    gitIn(tmp, 'add', '-A');
    gitIn(tmp, 'commit', '-q', '-m', 'second entry');
    const head = gitIn(tmp, 'rev-parse', 'HEAD');
    const token = 'ct-2026-10-10-007';
    const manifest = (runId, knowledgeId, source) => {
      const backup = `.ai/drift/backups/${runId}/${source}`;
      mkdirSync(dirname(join(tmp, backup)), { recursive: true });
      copyFileSync(join(tmp, source), join(tmp, backup));
      const rel = `.ai/knowledge/migration/${runId}/archive-confirmation.json`;
      mkdirSync(dirname(join(tmp, rel)), { recursive: true });
      writeFileSync(join(tmp, rel), `${JSON.stringify({
        backup,
        confirmation_token: token,
        confirmed: true,
        knowledge_id: knowledgeId,
        references: [],
        repo_id: 'example-repo',
        repo_root: realpathSync(tmp),
        run_id: runId,
        schema: 'knowledge-archive-confirmation/1',
        sha256: sha256File(join(tmp, source)),
        source,
        source_commit: head,
        target: source.replace('docs/plans/', 'docs/plans/ARCHIVED/'),
      }, null, 2)}\n`, 'utf8');
      return { AI_KNOWLEDGE_ARCHIVE_MANIFEST: rel };
    };
    const envA = manifest('run-a', EXAMPLE_ID, EXAMPLE_DOC);
    const envB = manifest('run-b', secondId, 'docs/plans/second.md');

    const holder = await parkPublisher(lane, tmp, ['archive', EXAMPLE_ID], envA);
    try {
      const contender = spawnKnowledge(lane, tmp, ['archive', secondId], envB);
      assert.equal(contender.status, 1, `the second archive must be serialized (exit ${contender.status})\n${contender.stdout}`);
      assert.deepEqual(JSON.parse(contender.stdout), serialized(ENTRY_LOCK_REL));
      assert.equal(holder.child.exitCode, null, 'the contender must not wait for the holder');
      feedParked(holder, parkedEntryBytes(tmp));
      const done = await exitWithin(holder, 'the released archive');
      assert.equal(done.status, 0, `the holder must complete (exit ${done.status})\n${done.stdout}${done.stderr}`);
    } finally {
      await reap(holder);
    }
    rmSync(holder.fifo);
    writeFileSync(holder.fifo, parkedEntryBytes(tmp), 'utf8');
    const retry = spawnKnowledge(lane, tmp, ['archive', secondId], envB);
    assert.equal(retry.status, 1);
    assert.deepEqual(JSON.parse(retry.stdout), { error: 'confirmation_consumed', detail: 'retry requires fresh confirmation' });
    assert.ok(existsSync(join(tmp, 'docs/plans/second.md')), 'the refused archive moves nothing');
    assert.equal(readLedger(tmp, '.ai/knowledge/migration/confirmations.jsonl').length, 1, 'the token was spent once');
    assert.deepEqual(readLedger(tmp, '.ai/knowledge/migration/ledger.jsonl').map((event) => [event.seq, event.run_id]), [[1, 'run-a']]);
  });
});

// ---------------------------------------------------------------------------
// Native promotion — the native artifact stays a byte-identical working copy
// ---------------------------------------------------------------------------

test('XSKP-P4-03 native promotion: publishing an .omo plan writes a canonical copy and leaves the native file untouched (source + packaged)', async () => {
  const native = '# Fresh native plan\n\nSteps.\n';
  await writeCase('native', {
    mutate: (dir) => writeFileSync(join(dir, '.omo/plans/fresh.md'), native, 'utf8'),
  }, (lane, tmp) => {
    const publish = spawnKnowledge(lane, tmp, ['publish', '.omo/plans/fresh.md', '--producer', 'prometheus']);
    assert.equal(publish.status, 0, `publish must exit 0 (exit ${publish.status})\n${publish.stdout}${publish.stderr}`);
    const entry = JSON.parse(publish.stdout);
    assert.equal(entry.knowledge_id, 'example-repo:plan:fresh');
    assert.deepEqual(entry.canonical, { format: 'markdown', frontmatter_id: true, immutable: false, path: 'docs/plans/fresh.md' });
    assert.deepEqual(entry.origin, { host: 'opencode', native: true, producer: 'prometheus', surface: 'omo' });
    assert.deepEqual(entry.revisions[0].derived_from, [{
      classification: 'native', path: '.omo/plans/fresh.md', sha256: createHash('sha256').update(native).digest('hex'), surface: 'omo',
    }]);
    assert.equal(readFileSync(join(tmp, '.omo/plans/fresh.md'), 'utf8'), native);
    assert.equal(
      readFileSync(join(tmp, 'docs/plans/fresh.md'), 'utf8'),
      `---\nknowledge_id: example-repo:plan:fresh\n---\n${native}`,
    );
    const verify = spawnKnowledge(lane, tmp, ['verify']);
    assert.equal(verify.status, 0, `verify after promotion must pass (exit ${verify.status})\n${verify.stdout}`);
  });
});

// ---------------------------------------------------------------------------
// archive — confirmed, ledgered migrate with reference repair
// ---------------------------------------------------------------------------

test('XSKP-P4-03 archive: a confirmed run moves the canonical, repairs the reference and ledgers the migrate (source + packaged)', async () => {
  const reference = 'docs/ref-link.md';
  const referenceText = '# Reference\n\nSee [the example](plans/example.md).\n';
  await writeCase('archive', {
    git: true,
    mutate: (dir) => writeFileSync(join(dir, reference), referenceText, 'utf8'),
  }, (lane, tmp) => {
    const manifestRel = '.ai/knowledge/migration/run-1/archive-confirmation.json';
    const env = { AI_KNOWLEDGE_ARCHIVE_MANIFEST: manifestRel };
    const unconfirmed = spawnKnowledge(lane, tmp, ['archive', EXAMPLE_ID], { AI_KNOWLEDGE_ARCHIVE_MANIFEST: '' });
    assert.equal(unconfirmed.status, 1);
    assert.deepEqual(JSON.parse(unconfirmed.stdout), { error: 'archive_confirmation_required', detail: 'explicit run manifest is required' });
    assert.equal(existsSync(join(tmp, ENTRY_LOCK_REL)), false, 'a refused archive releases its lock');

    const backup = '.ai/drift/backups/run-1/docs/plans/example.md';
    mkdirSync(dirname(join(tmp, backup)), { recursive: true });
    copyFileSync(join(tmp, EXAMPLE_DOC), join(tmp, backup));
    const receipt = {
      backup,
      confirmation_token: 'not-a-token',
      confirmed: true,
      knowledge_id: EXAMPLE_ID,
      references: [{ path: reference, sha256: sha256File(join(tmp, reference)) }],
      repo_id: 'example-repo',
      repo_root: realpathSync(tmp),
      run_id: 'run-1',
      schema: 'knowledge-archive-confirmation/1',
      sha256: CANONICAL_SHA256,
      source: EXAMPLE_DOC,
      source_commit: gitIn(tmp, 'rev-parse', 'HEAD'),
      target: 'docs/plans/ARCHIVED/example.md',
    };
    mkdirSync(dirname(join(tmp, manifestRel)), { recursive: true });
    writeFileSync(join(tmp, manifestRel), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    const badToken = spawnKnowledge(lane, tmp, ['archive', EXAMPLE_ID], env);
    assert.equal(badToken.status, 1);
    assert.deepEqual(JSON.parse(badToken.stdout), { error: 'invalid_confirmation', detail: 'receipt does not bind this exact archive run' });
    assert.ok(existsSync(join(tmp, EXAMPLE_DOC)), 'a refused archive moves nothing');

    receipt.confirmation_token = 'ct-2026-10-10-001';
    writeFileSync(join(tmp, manifestRel), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    const archive = spawnKnowledge(lane, tmp, ['archive', EXAMPLE_ID], env);
    assert.equal(archive.status, 0, `confirmed archive must exit 0 (exit ${archive.status})\n${archive.stdout}${archive.stderr}`);
    const entry = JSON.parse(archive.stdout);
    assert.equal(entry.lifecycle, 'archived');
    assert.equal(entry.canonical.path, 'docs/plans/ARCHIVED/example.md');
    assert.equal(existsSync(join(tmp, EXAMPLE_DOC)), false);
    assert.equal(sha256File(join(tmp, 'docs/plans/ARCHIVED/example.md')), CANONICAL_SHA256, 'the move keeps the bytes');
    assert.equal(readFileSync(join(tmp, reference), 'utf8'), '# Reference\n\nSee [the example](plans/ARCHIVED/example.md).\n');

    const [migrate] = readLedger(tmp, '.ai/knowledge/migration/ledger.jsonl');
    assert.deepEqual({ ...migrate, at: null }, {
      action: 'migrate',
      after_sha256: CANONICAL_SHA256,
      at: null,
      backup,
      before_sha256: CANONICAL_SHA256,
      refs_repaired: [{
        after_sha256: sha256File(join(tmp, reference)),
        before_sha256: receipt.references[0].sha256,
        file: reference,
      }],
      result: 'applied',
      run_id: 'run-1',
      schema: 'knowledge-migration-event/1',
      seq: 1,
      source: EXAMPLE_DOC,
      target: 'docs/plans/ARCHIVED/example.md',
    });
    const [consumed] = readLedger(tmp, '.ai/knowledge/migration/confirmations.jsonl');
    assert.equal(consumed.confirmation_token, 'ct-2026-10-10-001');
    assert.equal(consumed.manifest_sha256, sha256File(join(tmp, manifestRel)));
    assert.equal(consumed.result, 'consumed');
    assert.equal(existsSync(join(tmp, ENTRY_LOCK_REL)), false, 'a completed archive releases its lock');
    const verify = spawnKnowledge(lane, tmp, ['verify']);
    assert.equal(verify.status, 0, `verify after archive must pass (exit ${verify.status})\n${verify.stdout}`);

    // A completed archive is idempotent through its audit; no second migrate.
    const retry = spawnKnowledge(lane, tmp, ['archive', EXAMPLE_ID], env);
    assert.equal(retry.status, 0, `archive retry must exit 0 (exit ${retry.status})\n${retry.stdout}`);
    assert.equal(readLedger(tmp, '.ai/knowledge/migration/ledger.jsonl').length, 1);
  });
});

// ---------------------------------------------------------------------------
// Contract pin — the writer fails closed on a mutated pack (D4)
// ---------------------------------------------------------------------------

test('XSKP-P4-03 contract pin: write verbs refuse a mutated contract pack with contract_mismatch (packaged copy)', async () => {
  await ac7Guarded('contract-pin', () => {
    const copy = mkdtempSync(join(tmpdir(), 'ai-catapult-kc-pkgcopy-'));
    const tmp = stageFixture('packaged');
    try {
      cpSync(assertPackaged(), copy, { recursive: true });
      mkdirSync(join(tmp, '.ai/init'), { recursive: true });
      writeFileSync(join(tmp, '.ai/init/repo-profile.json'), '{"repo_id": "example-repo"}\n', 'utf8');
      appendFileSync(join(copy, '.ai/knowledge/contract/publication-policy.json'), ' ');
      const before = guardedDigests(tmp);
      const result = spawnSync(process.execPath, [join(copy, 'bin/ai-catapult.js'), 'knowledge', '--root', tmp, 'publish', EXAMPLE_DOC], {
        encoding: 'utf8', timeout: 30_000, env: { ...process.env, AI_CATAPULT_DIST_ROOT: join(copy, 'dist') },
      });
      assert.equal(result.status, 1, `a mutated pack must fail closed (exit ${result.status})\n${result.stdout}${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stdout), { error: 'contract_mismatch', detail: 'publication-policy.json' });
      assert.deepEqual(guardedDigests(tmp), before, 'AC-7: contract-pin changed a native or immutable file in the staged root');
    } finally {
      rmSync(copy, { recursive: true, force: true });
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Unlock recovery (review round 2)
// ---------------------------------------------------------------------------

test('XSKP-P4-03 review-r2 F2: a lock without owner.json (writer killed before writing it) is reported, blocks writers, and unlock recovers it (source + packaged)', async () => {
  await writeCase('r2-ownerless', {
    mutate: (dir) => {
      mkdirSync(join(dir, ENTRY_LOCK_REL), { recursive: true });
      writeFileSync(join(dir, 'docs/other.md'), '# Other\n', 'utf8');
    },
  }, (lane, tmp) => {
    const verify = spawnKnowledge(lane, tmp, ['verify']);
    assert.equal(verify.status, 0, `verify must report, not fail (exit ${verify.status})\n${verify.stdout}`);
    assert.deepEqual(JSON.parse(verify.stdout).warnings, [{ lock: ENTRY_LOCK_REL, pid: null, warning: 'lock_state_unknown' }]);
    const blocked = spawnKnowledge(lane, tmp, ['publish', 'docs/other.md']);
    assert.equal(blocked.status, 1);
    assert.deepEqual(JSON.parse(blocked.stdout), serialized(ENTRY_LOCK_REL));
    const unlock = spawnKnowledge(lane, tmp, ['unlock', EXAMPLE_ID, '--confirm-no-writer']);
    assert.equal(unlock.status, 0, `confirmed unlock must exit 0 (exit ${unlock.status})\n${unlock.stdout}${unlock.stderr}`);
    assert.deepEqual(readdirSync(join(tmp, '.ai/knowledge/.locks')), []);
    assert.deepEqual(readLedger(tmp, LOCK_EVENTS_REL).map((event) => [event.lock_path, event.result]), [
      [ENTRY_LOCK_REL, 'prepared'], [ENTRY_LOCK_REL, 'applied'],
    ]);
    const published = spawnKnowledge(lane, tmp, ['publish', 'docs/other.md']);
    assert.equal(published.status, 0, `writers proceed after recovery (exit ${published.status})\n${published.stdout}`);
  });
});

/**
 * Run planUnlock, then a disturbance, then executeUnlock in one child process
 * importing the lane's module: the interleavings a concurrent unlock or a new
 * writer could produce between snapshot and removal, made deterministic.
 */
function unlockProbe(lane, tmp, disturb) {
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', [
    "import { mkdirSync, rmSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    'const [url, root, disturb] = process.argv.slice(1);',
    'const { planUnlock, executeUnlock } = await import(url);',
    `const targets = planUnlock(root, ${JSON.stringify(EXAMPLE_ID)});`,
    'for (const step of JSON.parse(disturb)) {',
    '  const path = join(root, step.path);',
    "  if (step.op === 'rm') rmSync(path, { recursive: true });",
    "  if (step.op === 'mkdir') mkdirSync(path, { recursive: true });",
    "  if (step.op === 'write') writeFileSync(path, step.data);",
    '}',
    'try {',
    `  const event = executeUnlock(root, ${JSON.stringify(EXAMPLE_ID)}, targets);`,
    '  process.stdout.write(JSON.stringify({ planned: targets.map((t) => t.relative), applied: event.lock_path }));',
    '} catch (error) {',
    '  process.stdout.write(JSON.stringify({ planned: targets.map((t) => t.relative), error: error.error }));',
    '}',
  ].join('\n'), laneModuleUrl(lane), realpathSync(tmp), JSON.stringify(disturb)], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(probe.status, 0, `unlock probe failed\n${probe.stderr}`);
  return JSON.parse(probe.stdout);
}

function seedLock(tmp, rel, owner) {
  mkdirSync(join(tmp, rel), { recursive: true });
  if (owner !== undefined) writeFileSync(join(tmp, rel, 'owner.json'), owner, 'utf8');
}

const liveOwner = () => `${JSON.stringify({ pid: process.pid, token: randomUUID() })}\n`;
const deadOwner = () => `${JSON.stringify({ pid: deadPid() })}\n`;

test('XSKP-P4-03 review-r2/r3: unlock removes only the lock incarnations it snapshotted, each claimed exclusively first (source + packaged)', async () => {
  await writeCase('r3-claims', {}, (lane, tmp) => {
    const locks = join(tmp, '.ai/knowledge/.locks');
    const lockEvents = () => readLedger(tmp, LOCK_EVENTS_REL).map((event) => [event.lock_path, event.result]);

    const claims = () => readdirSync(locks).filter((name) => CLAIM_NAME.test(name));

    // (a) The stale entry lock is replaced (another unlock removed it, a new
    // writer took the path) between snapshot and removal: lock_changed. The
    // displaced incarnation is kept, intact, under its claim name and nothing
    // is renamed back onto the entry lock path (a rename-back could replace a
    // lock another writer just created there).
    seedLock(tmp, ENTRY_LOCK_REL, deadOwner());
    const replacement = liveOwner();
    const replaced = unlockProbe(lane, tmp, [
      { op: 'rm', path: ENTRY_LOCK_REL }, { op: 'mkdir', path: ENTRY_LOCK_REL },
      { op: 'write', path: `${ENTRY_LOCK_REL}/owner.json`, data: replacement },
    ]);
    assert.deepEqual(replaced, { planned: [ENTRY_LOCK_REL], error: 'lock_changed' });
    assert.equal(existsSync(join(tmp, ENTRY_LOCK_REL)), false, 'nothing is restored onto the entry lock path');
    assert.equal(claims().length, 1);
    const displaced = `.ai/knowledge/.locks/${claims()[0]}`;
    assert.equal(readFileSync(join(tmp, displaced, 'owner.json'), 'utf8'), replacement, 'the displaced lock is kept intact');
    const ledgered = readLedger(tmp, LOCK_EVENTS_REL);
    assert.deepEqual(ledgered.map((event) => [event.lock_path, event.result]), [[ENTRY_LOCK_REL, 'prepared'], [ENTRY_LOCK_REL, 'failed']]);
    assert.equal(ledgered[1].claim_path, displaced, 'the failure ledgers where the displaced lock is kept');
    // The claim still serializes writers, and an explicit unlock recovers it
    // once the unlock that made it has exited.
    writeFileSync(join(tmp, 'docs/other.md'), '# Other\n', 'utf8');
    const held = spawnKnowledge(lane, tmp, ['publish', 'docs/other.md']);
    assert.deepEqual(JSON.parse(held.stdout), serialized(displaced));
    const recovered = spawnKnowledge(lane, tmp, ['unlock', EXAMPLE_ID, '--confirm-no-writer']);
    assert.equal(recovered.status, 0, `unlock must recover the displaced claim (exit ${recovered.status})\n${recovered.stdout}`);
    assert.equal(JSON.parse(recovered.stdout).lock_path, displaced);
    assert.deepEqual(readdirSync(locks), []);

    // (b) A claim left by an unlock that died blocks writers. A writer lock that
    // appears after planning (once the claim is gone) is never adopted.
    const leftover = claimRel(deadPid());
    seedLock(tmp, leftover, deadOwner());
    const fresh = liveOwner();
    const adopted = unlockProbe(lane, tmp, [
      { op: 'mkdir', path: ENTRY_LOCK_REL }, { op: 'write', path: `${ENTRY_LOCK_REL}/owner.json`, data: fresh },
    ]);
    assert.deepEqual(adopted, { planned: [leftover], applied: leftover });
    assert.equal(readFileSync(join(tmp, ENTRY_LOCK_REL, 'owner.json'), 'utf8'), fresh, 'the new writer\'s lock is untouched');
    assert.deepEqual(readdirSync(locks), [ENTRY_LOCK_REL.split('/').at(-1)]);
    rmSync(join(tmp, ENTRY_LOCK_REL), { recursive: true });

    // (c) A leftover claim replaced between snapshot and removal is never
    // deleted: it is kept intact under a fresh claim name.
    const resumed = claimRel(deadPid());
    seedLock(tmp, resumed, deadOwner());
    const other = liveOwner();
    const resumedRace = unlockProbe(lane, tmp, [
      { op: 'rm', path: resumed }, { op: 'mkdir', path: resumed }, { op: 'write', path: `${resumed}/owner.json`, data: other },
    ]);
    assert.deepEqual(resumedRace, { planned: [resumed], error: 'lock_changed' });
    assert.equal(existsSync(join(tmp, resumed)), false);
    assert.equal(claims().length, 1);
    assert.equal(readFileSync(join(locks, claims()[0], 'owner.json'), 'utf8'), other, 'the replaced claim is kept intact');
    rmSync(join(locks, claims()[0]), { recursive: true });

    // (d) A claim held by an unlock that is still running is refused, untouched.
    const running = claimRel(process.pid);
    seedLock(tmp, running, deadOwner());
    const inProgress = spawnKnowledge(lane, tmp, ['unlock', EXAMPLE_ID, '--confirm-no-writer']);
    assert.equal(inProgress.status, 1);
    assert.deepEqual(JSON.parse(inProgress.stdout), { error: 'locked', detail: `${running}: claimed by an unlock that is still running` });
    assert.ok(existsSync(join(tmp, running, 'owner.json')));
    rmSync(join(tmp, running), { recursive: true });

    // (e) Through the CLI: a dead unlock's claim blocks writers; the confirmed unlock finishes it.
    const dead = claimRel(deadPid());
    seedLock(tmp, dead, deadOwner());
    writeFileSync(join(tmp, 'docs/other.md'), '# Other\n', 'utf8');
    const blocked = spawnKnowledge(lane, tmp, ['publish', 'docs/other.md']);
    assert.equal(blocked.status, 1);
    assert.deepEqual(JSON.parse(blocked.stdout), serialized(dead));
    const unlock = spawnKnowledge(lane, tmp, ['unlock', EXAMPLE_ID, '--confirm-no-writer']);
    assert.equal(unlock.status, 0, `unlock must finish the claim (exit ${unlock.status})\n${unlock.stdout}${unlock.stderr}`);
    assert.deepEqual(readdirSync(locks), []);
    const published = spawnKnowledge(lane, tmp, ['publish', 'docs/other.md']);
    assert.equal(published.status, 0, `writers proceed after recovery (exit ${published.status})\n${published.stdout}`);
  });
});

test('XSKP-P4-03 review-r2 F1: concurrent confirmed unlocks of one stale lock remove it exactly once (source + packaged)', async () => {
  await writeCase('r2-concurrent-unlock', {
    mutate: (dir) => {
      mkdirSync(join(dir, ENTRY_LOCK_REL), { recursive: true });
      writeFileSync(join(dir, ENTRY_LOCK_REL, 'owner.json'), `${JSON.stringify({ pid: deadPid() })}\n`, 'utf8');
    },
  }, async (lane, tmp) => {
    const unlocks = Array.from({ length: 4 }, () => spawnKnowledgeAsync(lane, tmp, ['unlock', EXAMPLE_ID, '--confirm-no-writer']));
    const results = [];
    try {
      for (const unlock of unlocks) results.push(await exitWithin(unlock, 'a concurrent unlock'));
    } finally {
      for (const unlock of unlocks) await reap(unlock);
    }
    assert.deepEqual(results.map((result) => result.status).sort(), [0, 1, 1, 1],
      results.map((result) => result.stdout + result.stderr).join('\n'));
    assert.equal(readLedger(tmp, LOCK_EVENTS_REL).filter((event) => event.result === 'applied').length, 1);
    assert.deepEqual(readdirSync(join(tmp, '.ai/knowledge/.locks')), []);
  });
});

// ---------------------------------------------------------------------------
// Ledger durability (review round 5)
// ---------------------------------------------------------------------------

test('XSKP-P4-03 review-r5: an interrupted audit tail is terminated and ledgered; no damaged audit line blocks unlock (source + packaged)', async () => {
  await writeCase('r5-ledger', {}, (lane, tmp) => {
    const ledger = join(tmp, LOCK_EVENTS_REL);
    // (a) An append cut short left an unterminated record.
    seedLock(tmp, ENTRY_LOCK_REL, deadOwner());
    const fragment = '{"action": "unlock", "at": "2026-10';
    mkdirSync(dirname(ledger), { recursive: true });
    writeFileSync(ledger, `{"note": "committed"}\n${fragment}`, 'utf8');
    const unlock = spawnKnowledge(lane, tmp, ['unlock', EXAMPLE_ID, '--confirm-no-writer']);
    assert.equal(unlock.status, 0, `unlock must succeed past an interrupted tail (exit ${unlock.status})\n${unlock.stdout}${unlock.stderr}`);
    assert.equal(existsSync(join(tmp, ENTRY_LOCK_REL)), false);
    const [committed, cut, repair, prepared, applied, end] = readFileSync(ledger, 'utf8').split('\n');
    assert.equal(committed, '{"note": "committed"}');
    assert.equal(cut, fragment, 'the fragment is kept, terminated on its own line');
    const { at, ...repaired } = JSON.parse(repair);
    assert.match(at, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(repaired, {
      action: 'terminate_interrupted_record',
      fragment_bytes: Buffer.byteLength(fragment),
      fragment_sha256: createHash('sha256').update(fragment).digest('hex'),
      schema: 'knowledge-ledger-repair/1',
    });
    assert.deepEqual([JSON.parse(prepared).result, JSON.parse(applied).result], ['prepared', 'applied']);
    assert.equal(end, '', 'every record is newline-terminated');

    // (b) A damaged committed line: unlock never reads the audit, so it still recovers.
    seedLock(tmp, ENTRY_LOCK_REL, deadOwner());
    appendFileSync(ledger, 'not json\n', 'utf8');
    const again = spawnKnowledge(lane, tmp, ['unlock', EXAMPLE_ID, '--confirm-no-writer']);
    assert.equal(again.status, 0, `a damaged audit line must not block unlock (exit ${again.status})\n${again.stdout}`);
    assert.equal(existsSync(join(tmp, ENTRY_LOCK_REL)), false);
  });
});

test('XSKP-P4-03 review-r5: under a file-size limit, unlock either completes with a whole audit or keeps the lock (source + packaged)', async () => {
  await writeCase('r5-fsize', {}, (lane, tmp) => {
    const ledger = join(tmp, LOCK_EVENTS_REL);
    const owner = deadOwner();
    seedLock(tmp, ENTRY_LOCK_REL, owner);
    // Just under one 1024-byte block, so the next record crosses `ulimit -f 1`.
    mkdirSync(dirname(ledger), { recursive: true });
    writeFileSync(ledger, `${JSON.stringify({ note: 'x'.repeat(1000 - 12) })}\n`, 'utf8');
    assert.equal(readFileSync(ledger).length, 1000);
    const env = { ...process.env, AI_CATAPULT_DIST_ROOT: lane === 'source' ? DIST_SNAPSHOT : join(packaged.dir, 'dist') };
    delete env.NODE_COMPILE_CACHE;
    const limited = spawnSync('bash', [
      '-c', 'ulimit -f 1 && exec "$@"', 'bash',
      process.execPath, join(laneRoot(lane), 'bin/ai-catapult.js'), 'knowledge', '--root', tmp, 'unlock', EXAMPLE_ID, '--confirm-no-writer',
    ], { encoding: 'utf8', timeout: 30_000, env });
    const text = readFileSync(ledger, 'utf8');
    const terminated = text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean);
    for (const line of terminated) JSON.parse(line);
    if (limited.status === 0) {
      // The whole audit was written: the lock may go.
      assert.ok(text.endsWith('\n'), 'a completed unlock leaves no partial record');
      assert.deepEqual(terminated.slice(-2).map((line) => JSON.parse(line).result), ['prepared', 'applied']);
      assert.equal(existsSync(join(tmp, ENTRY_LOCK_REL)), false);
    } else {
      // The audit could not be written whole: the lock stays, byte for byte.
      assert.equal(readFileSync(join(tmp, ENTRY_LOCK_REL, 'owner.json'), 'utf8'), owner,
        `a failed audit must keep the lock\n${limited.stdout}${limited.stderr}`);
    }
    // Without the limit, recovery always completes.
    const recovered = spawnKnowledge(lane, tmp, ['unlock', EXAMPLE_ID, '--confirm-no-writer']);
    if (limited.status === 0) {
      assert.deepEqual(JSON.parse(recovered.stdout), { error: 'not_locked', detail: 'entry lock directory does not exist' });
    } else {
      assert.equal(recovered.status, 0, `recovery must succeed (exit ${recovered.status})\n${recovered.stdout}${recovered.stderr}`);
      assert.equal(existsSync(join(tmp, ENTRY_LOCK_REL)), false);
      assert.ok(readFileSync(ledger, 'utf8').endsWith('\n'));
    }
  });
});
