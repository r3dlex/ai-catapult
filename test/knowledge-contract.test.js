/**
 * TDD tests for Goal XSKP-P4-01 — published knowledge contract copies.
 *
 * The repo's cross-surface knowledge publication contract lives under
 * docs/specifications/ACTIVE/cross-surface-knowledge-publication.contract/ and
 * must also be published at .ai/knowledge/contract/ as a byte-identical copy
 * (same file set, same sha256 per file) so downstream consumers can read it
 * from a stable, packaged location.
 *
 * Coverage:
 *   (a) contract.lock.json exists, has schema knowledge-contract-lock/1, and its
 *       own sha256 is pinned (mutation of the lock itself is detectable)
 *   (b) the source spec copy matches every entry in contract.lock.json
 *   (c) .ai/knowledge/contract/ exists and is byte-identical to the source copy
 *       (exact relative file-set equality + per-file sha256 equality vs lock)
 *   (d) the verifier goes red on a mutated byte in a temp copy, and green again
 *       once the original bytes are restored
 *   (e) package.json `files` includes .ai/knowledge/contract/
 *   (f) packed lane: npm pack --ignore-scripts (precedent
 *       test/graph-hooks.test.js:118 — prepack's setup.sh never runs, so
 *       vendor/skills is never touched) and the tarball listing contains every
 *       published contract file
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
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const SPEC_DIR = join(
  root,
  'docs/specifications/ACTIVE/cross-surface-knowledge-publication.contract',
);
const PUBLISHED_DIR = join(root, '.ai/knowledge/contract');
const LOCK_FILE = 'contract.lock.json';
// Pinned by the admitted goal: sha256 of contract.lock.json itself.
const LOCK_SHA256 =
  '9f5d7edfc17554c383b06aa4726dfffe564ecc8d657b16baa89ce72098d5e102';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function readLock() {
  const raw = readFileSync(join(SPEC_DIR, LOCK_FILE), 'utf8');
  return JSON.parse(raw);
}

/** Sorted relative (posix) paths of every file under dir. */
function walkRel(dir) {
  const out = [];
  const visit = (abs) => {
    for (const name of readdirSync(abs).sort()) {
      const p = join(abs, name);
      if (statSync(p).isDirectory()) visit(p);
      else out.push(relative(dir, p));
    }
  };
  visit(dir);
  return out.map((p) => p.split('\\').join('/')).sort();
}

/**
 * Verify a contract copy directory against the lock file: every locked file
 * must exist with exactly the recorded sha256, the lock document itself must
 * be present (it is part of the copy but cannot hash itself), and the copy
 * must contain no extra files besides the lock. Throws with a descriptive
 * message on the first mismatch.
 */
function verifyContractCopy(copyDir) {
  const lock = readLock();
  assert.ok(
    existsSync(join(copyDir, LOCK_FILE)),
    `copy is missing ${LOCK_FILE}`,
  );
  const expectedFiles = Object.keys(lock.files).sort();
  // The lock document ships inside the copy but is not hashed by itself.
  const actualFiles = walkRel(copyDir).filter((f) => f !== LOCK_FILE);

  const missing = expectedFiles.filter((f) => !actualFiles.includes(f));
  if (missing.length > 0) {
    throw new Error(`missing files vs lock: ${missing.join(', ')}`);
  }
  const extra = actualFiles.filter((f) => !expectedFiles.includes(f));
  if (extra.length > 0) {
    throw new Error(`unexpected extra files vs lock: ${extra.join(', ')}`);
  }
  for (const rel of expectedFiles) {
    const actual = sha256File(join(copyDir, rel));
    const wanted = lock.files[rel];
    if (actual !== wanted) {
      throw new Error(`sha256 mismatch for ${rel}: got ${actual}, want ${wanted}`);
    }
  }
}

// ---------------------------------------------------------------------------
// (a) Lock integrity
// ---------------------------------------------------------------------------

test('contract.lock.json is present, correctly schemad, and pinned by sha256', () => {
  const lockPath = join(SPEC_DIR, LOCK_FILE);
  assert.ok(existsSync(lockPath), `missing ${LOCK_FILE} in ${SPEC_DIR}`);
  const lock = readLock();
  assert.equal(lock.schema, 'knowledge-contract-lock/1');
  assert.equal(lock.pack_version, '1');
  assert.ok(Object.keys(lock.files).length > 0, 'lock lists no files');
  // Pin the lock document itself: any edit to the lock trips this assertion.
  assert.equal(sha256File(lockPath), LOCK_SHA256);
});

// ---------------------------------------------------------------------------
// (b) Source spec copy matches the lock
// ---------------------------------------------------------------------------

test('source spec contract copy matches every contract.lock.json entry', () => {
  assert.doesNotThrow(() => verifyContractCopy(SPEC_DIR));
});

// ---------------------------------------------------------------------------
// (c) Published copy is byte-identical
// ---------------------------------------------------------------------------

test('.ai/knowledge/contract exists and is byte-identical to the spec copy', () => {
  assert.ok(existsSync(PUBLISHED_DIR), `.ai/knowledge/contract missing at ${PUBLISHED_DIR}`);
  assert.ok(existsSync(join(PUBLISHED_DIR, LOCK_FILE)), 'published copy lacks contract.lock.json');
  assert.doesNotThrow(() => verifyContractCopy(PUBLISHED_DIR));
});

// ---------------------------------------------------------------------------
// (d) Mutation sensitivity (goes red on a mutated byte in a temp copy)
// ---------------------------------------------------------------------------

test('verifier goes red on a mutated byte in a temp copy, green after restore', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ai-catapult-kc-mutate-'));
  try {
    cpSync(SPEC_DIR, tmp, { recursive: true });
    // Untouched temp copy is green.
    assert.doesNotThrow(() => verifyContractCopy(tmp));

    const target = join(tmp, 'publication-policy.json');
    const bytes = readFileSync(target);
    const mutated = Buffer.from(bytes);
    mutated[mutated.length - 1] = mutated[mutated.length - 1] ^ 0x01;
    writeFileSync(target, mutated);

    assert.throws(
      () => verifyContractCopy(tmp),
      (err) => err instanceof Error && /sha256 mismatch for publication-policy\.json/.test(err.message),
      'mutated byte must be caught by the verifier',
    );

    // Restoring the original bytes turns the verifier green again.
    writeFileSync(target, bytes);
    assert.doesNotThrow(() => verifyContractCopy(tmp));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (e)+(f) Packaged lane
// ---------------------------------------------------------------------------

test('package.json files includes .ai/knowledge/contract/', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.ok(
    pkg.files.some((f) => f.replace(/\/$/, '') === '.ai/knowledge/contract'),
    `package.json files must include .ai/knowledge/contract/; got ${JSON.stringify(pkg.files)}`,
  );
});

let packTmpDir;

before(() => {
  packTmpDir = mkdtempSync(join(tmpdir(), 'ai-catapult-kc-pack-'));
});

after(() => {
  if (packTmpDir) rmSync(packTmpDir, { recursive: true, force: true });
});

test('npm pack tarball contains every published contract file', () => {
  const lock = readLock();
  const DIST_SNAPSHOT = process.env.AI_CATAPULT_DIST_ROOT ?? join(root, 'dist-snapshot');
  const stageDir = mkdtempSync(join(tmpdir(), 'ai-catapult-kc-stage-'));
  let tgzPath;
  try {
    // rsync staging, exactly like test/graph-hooks.test.js:101 — vendor/,
    // node_modules, .git and dist trees stay out of the staged package.
    mkdirSync(join(stageDir, 'dist'), { recursive: true });
    const rsync = spawnSync('rsync', [
      '-a', '--delete',
      '--exclude=node_modules',
      '--exclude=.git',
      '--exclude=dist/',
      '--exclude=dist-snapshot/',
      '--exclude=vendor/',
      `${root}/`,
      `${stageDir}/`,
    ], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(rsync.status, 0, `rsync to stage failed\n${rsync.stderr}`);

    const cpDist = spawnSync('cp', ['-R', DIST_SNAPSHOT, join(stageDir, 'dist')], { encoding: 'utf8' });
    assert.equal(cpDist.status, 0, `cp dist-snapshot failed: ${cpDist.stderr}`);

    // --ignore-scripts keeps prepack (setup.sh) from running: vendor/skills is
    // never touched by the packed lane.
    const pack = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', packTmpDir], {
      encoding: 'utf8',
      cwd: stageDir,
      timeout: 60_000,
    });
    assert.equal(pack.status, 0, `npm pack failed\n${pack.stdout}\n${pack.stderr}`);

    const tgzName = pack.stdout.trim().split('\n').at(-1).trim();
    tgzPath = join(packTmpDir, tgzName);
    assert.ok(existsSync(tgzPath), `Expected tarball at ${tgzPath}`);

    const tar = spawnSync('tar', ['-tzf', tgzPath], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(tar.status, 0, `tar listing failed: ${tar.stderr}`);
    const listing = tar.stdout.split('\n');

    for (const rel of Object.keys(lock.files)) {
      const entry = `package/.ai/knowledge/contract/${rel}`;
      assert.ok(
        listing.includes(entry),
        `tarball missing ${entry}\n--- tarball listing ---\n${tar.stdout}`,
      );
    }
    assert.ok(
      listing.includes(`package/.ai/knowledge/contract/${LOCK_FILE}`),
      `tarball missing package/.ai/knowledge/contract/${LOCK_FILE}`,
    );
  } finally {
    if (tgzPath) rmSync(tgzPath, { force: true });
    rmSync(stageDir, { recursive: true, force: true });
  }
});