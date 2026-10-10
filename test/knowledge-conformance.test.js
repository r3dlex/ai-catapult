/**
 * TDD tests for Goal XSKP-P4-02 — knowledge read verbs (knowledge-registry/1).
 *
 * Goal record (handoff xskp-p4-adopt-engine, gen 2ce8dbb7…, goals.json):
 *   'ai-catapult knowledge list|find|show|verify|rebuild' passes C01-C06, C14,
 *   the C15 read half and C18 with the same exit codes and error tokens as the
 *   contract. C16: the JS serializer orders keys by Unicode code point (not
 *   UTF-16 code unit) and writes non-ASCII literally; its output equals
 *   fixtures/vectors/serialization-expected.json byte-for-byte; C02 reproduces
 *   the fixture registry.json. Packaged lane: the same cases run against the
 *   dist-snapshot tree. Auto-discovered by node --test under npm test.
 *
 * Cases exercised, from .ai/knowledge/contract/conformance.json:
 *   C01-valid-readback            show example-repo:plan:example (exit 0, digest)
 *   C02-aggregate-reproducible    rebuild --check (exit 0, empty stdout);
 *                                 rebuild reproduces fixture registry.json bytes
 *   C03-hash-mismatch             verify → hash_mismatch, exit 1
 *   C04-missing-without-tombstone verify → missing_without_tombstone, exit 1
 *   C05-path-traversal            verify → unsafe_path (traversal), exit 1
 *   C06-symlink-component         verify → unsafe_path (symlink_component), exit 1
 *   C14-federated-absent-child    find --federated with an absent managed child:
 *                                 exit 0, absence reported not failed
 *   C15 read half                 rebuild preserves unknown entry keys (x_extra)
 *   C16-serialization-vector      serialize → bytes equal expected vector;
 *                                 pins code-point key order (x_ｚ before x_😀)
 *   C18-stale-lock-reported       verify reports stale_lock, exit 0, lock kept
 *   list smoke                    list on the valid fixture (AC names list; no
 *                                 dedicated C-case) pins the 9-key item shape
 *
 * Every case runs in TWO lanes against the same fixtures:
 *   source:   this checkout's bin/ai-catapult.js
 *   packaged: an extracted npm tarball staged exactly like
 *             test/knowledge-contract.test.js (dist-snapshot/ becomes dist/;
 *             vendor is absent; the CLI must run from the package alone,
 *             including resolving .ai/knowledge/contract from package files).
 *
 * The tests only ever spawn the CLI; they import nothing from src/ so the red
 * state is the dispatch failure itself, not a module load error.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

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
function spawnKnowledge(lane, rootDir, args) {
  const cli = join(laneRoot(lane), 'bin/ai-catapult.js');
  const distRoot = lane === 'source' ? DIST_SNAPSHOT : join(packaged.dir, 'dist');
  const result = spawnSync(process.execPath, [cli, 'knowledge', '--root', rootDir, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, AI_CATAPULT_DIST_ROOT: distRoot },
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