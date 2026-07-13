/**
 * TDD test for published-tarball `npx ai-catapult init` path (Defect 1).
 *
 * Reproduces the field failure: the published tarball ships dist/ but NOT
 * vendor/, so VENDOR_TEMPLATES does not exist in the extracted package.
 * The fix introduces dist/skill-templates/ as a fallback when vendor/ is absent.
 *
 * Strategy:
 *   1. `npm pack` the current package into a tmp dir (once, via before()).
 *   2. Extract the tarball (tar xzf).
 *   3. Run `node <extracted>/bin/ai-catapult.js init <fresh-tmpdir>`.
 *   4. Assert the scaffold emitted .ai/matrix.json, AGENTS.md, and
 *      .ai/handoff/NEXT-STEPS.md — and that matrix.json parses with the
 *      expected schema_version and standalone topology.
 *
 * This test runs SLOW (~5-10 s) because of npm pack; it runs once per file
 * via before() so the pack cost is paid exactly once.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// Directories created in before() and torn down in after().
let packTmpDir;   // holds the .tgz
let extractDir;   // holds the extracted package/

before(async () => {
  packTmpDir = mkdtempSync(join(tmpdir(), 'ai-catapult-pack-'));
  extractDir = mkdtempSync(join(tmpdir(), 'ai-catapult-extract-'));

  // Packing strategy: copy the repo tree into a staging dir and replace its
  // dist/ with a snapshot of dist-snapshot/ before packing.  This avoids the
  // race condition where codex-plugin tests wipe+rebuild the live dist/ while
  // npm pack is still reading it, causing ENOENT mid-pack.
  //
  // dist-snapshot/ is stable throughout the test run (populated by pretest
  // via snapshot-dist.sh and never modified by any test).
  //
  // The DIST_SNAPSHOT env var is set by `npm test` via AI_CATAPULT_DIST_ROOT.
  const DIST_SNAPSHOT = process.env.AI_CATAPULT_DIST_ROOT ?? join(root, 'dist-snapshot');

  const stageDir = mkdtempSync(join(tmpdir(), 'ai-catapult-stage-'));

  try {
    // Copy the full repo excluding dist/ (live — being rebuilt concurrently
    // by other tests), node_modules, .git, and dist-snapshot.
    // We supply dist/ separately below from the stable dist-snapshot/.
    const cp = spawnSync('rsync', [
      '-a', '--delete',
      '--exclude=node_modules',
      '--exclude=.git',
      '--exclude=dist/',
      '--exclude=dist-snapshot/',
      root + '/',
      stageDir + '/',
    ], { encoding: 'utf8', timeout: 30_000 });

    assert.equal(
      cp.status, 0,
      `rsync to stage dir failed\nstdout: ${cp.stdout}\nstderr: ${cp.stderr}`,
    );

    // Populate stage/dist/ from dist-snapshot/ (stable pre-built snapshot,
    // never modified during the test run).
    const stageDist = join(stageDir, 'dist');
    const cpDist = spawnSync('cp', ['-R', DIST_SNAPSHOT, stageDist], { encoding: 'utf8' });
    assert.equal(cpDist.status, 0, `cp dist-snapshot → stage/dist failed: ${cpDist.stderr}`);

    // Run npm pack from the stage dir with --ignore-scripts so prepack does
    // not wipe the dist/ we just carefully placed.
    const pack = spawnSync('npm', ['pack', '--pack-destination', packTmpDir, '--ignore-scripts'], {
      encoding: 'utf8',
      cwd: stageDir,
      timeout: 60_000,
    });

    assert.equal(
      pack.status, 0,
      `npm pack failed\nstdout: ${pack.stdout}\nstderr: ${pack.stderr}`,
    );

    // npm pack prints the tarball filename to stdout (one line).
    const tgzName = pack.stdout.trim().split('\n').at(-1).trim();
    const tgzPath = join(packTmpDir, tgzName);

    assert.ok(
      existsSync(tgzPath),
      `Expected tarball at ${tgzPath}\nnpm pack stdout: ${pack.stdout}`,
    );

    // Extract the tarball.  npm pack wraps everything under a "package/" prefix.
    const tar = spawnSync('tar', ['xzf', tgzPath, '-C', extractDir], {
      encoding: 'utf8',
      timeout: 30_000,
    });

    assert.equal(
      tar.status, 0,
      `tar extraction failed\nstderr: ${tar.stderr}`,
    );
  } finally {
    spawnSync('rm', ['-rf', stageDir], { encoding: 'utf8' });
  }
});

after(() => {
  if (packTmpDir) rmSync(packTmpDir, { recursive: true, force: true });
  if (extractDir) rmSync(extractDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper — run init from extracted package with a sandboxed HOME/CODEX_HOME
// ---------------------------------------------------------------------------

function runExtractedInit(args = []) {
  const extractedBin = join(extractDir, 'package', 'bin', 'ai-catapult.js');
  const fakeHome = mkdtempSync(join(tmpdir(), 'ai-catapult-packed-home-'));

  try {
    const result = spawnSync(process.execPath, [extractedBin, 'init', ...args], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: fakeHome,
        CODEX_HOME: join(fakeHome, '.codex'),
      },
    });

    return result;
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test: init from extracted package produces the expected scaffold
// ---------------------------------------------------------------------------

test('packed-init: init from extracted npm tarball exits 0', () => {
  const targetDir = mkdtempSync(join(tmpdir(), 'ai-catapult-packed-target-'));

  try {
    const r = runExtractedInit([
      targetDir,
      '--repo-id', 'packed-test-repo',
      '--date', '2026-01-01',
      '--upstream-url', 'https://github.com/example-org/packed-test-repo.git',
      '--upstream-ref', 'main',
    ]);

    assert.equal(
      r.status, 0,
      `Expected exit 0 from extracted package init\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test('packed-init: .ai/matrix.json exists and parses correctly', () => {
  const targetDir = mkdtempSync(join(tmpdir(), 'ai-catapult-packed-matrix-'));

  try {
    const r = runExtractedInit([
      targetDir,
      '--repo-id', 'packed-test-repo',
      '--date', '2026-01-01',
    ]);

    assert.equal(
      r.status, 0,
      `init failed\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );

    const matrixPath = join(targetDir, '.ai', 'matrix.json');
    assert.ok(
      existsSync(matrixPath),
      `.ai/matrix.json must exist after init\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );

    const matrix = JSON.parse(readFileSync(matrixPath, 'utf8'));

    assert.equal(
      matrix.schema_version, '1.0',
      `.ai/matrix.json schema_version must be "1.0"\nActual: ${JSON.stringify(matrix, null, 2)}`,
    );

    assert.equal(
      matrix.topology_type, 'standalone',
      `.ai/matrix.json topology_type must be "standalone"\nActual: ${JSON.stringify(matrix, null, 2)}`,
    );
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test('packed-init: AGENTS.md exists after init', () => {
  const targetDir = mkdtempSync(join(tmpdir(), 'ai-catapult-packed-agents-'));

  try {
    const r = runExtractedInit([
      targetDir,
      '--repo-id', 'packed-test-repo',
      '--date', '2026-01-01',
    ]);

    assert.equal(
      r.status, 0,
      `init failed\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );

    assert.ok(
      existsSync(join(targetDir, 'AGENTS.md')),
      `AGENTS.md must exist after init\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test('packed-init: canonical README.md exists with observable generated-state verification', () => {
  const targetDir = mkdtempSync(join(tmpdir(), 'ai-catapult-packed-readme-'));

  try {
    const r = runExtractedInit([
      targetDir,
      '--repo-id', 'packed-test-repo',
      '--date', '2026-01-01',
    ]);

    assert.equal(r.status, 0, `init failed\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);

    const readmePath = join(targetDir, 'README.md');
    assert.ok(existsSync(readmePath), 'README.md must exist after packed init');
    const readme = readFileSync(readmePath, 'utf8');
    assert.match(readme, /test -f \.ai\/matrix\.json && test -f \.ai\/handoff\/NEXT-STEPS\.md/);
    assert.match(readme, /\.ai\/matrix\.json` identifies `packed-test-repo`/);
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test('packed-init: .ai/handoff/NEXT-STEPS.md exists after init', () => {
  const targetDir = mkdtempSync(join(tmpdir(), 'ai-catapult-packed-nextsteps-'));

  try {
    const r = runExtractedInit([
      targetDir,
      '--repo-id', 'packed-test-repo',
      '--date', '2026-01-01',
    ]);

    assert.equal(
      r.status, 0,
      `init failed\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );

    assert.ok(
      existsSync(join(targetDir, '.ai', 'handoff', 'NEXT-STEPS.md')),
      `.ai/handoff/NEXT-STEPS.md must exist after init\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test('packed-init: vendor/ directory is NOT present in extracted tarball', () => {
  // This confirms the extracted package truly reproduces the published scenario
  // (vendor/ is not shipped), so the fallback to dist/skill-templates/ is exercised.
  const vendorDir = join(extractDir, 'package', 'vendor');
  assert.ok(
    !existsSync(vendorDir),
    `vendor/ must NOT be present in the extracted tarball — it is a dev-only directory\nFound at: ${vendorDir}`,
  );
});

test('packed-init: dist/skill-templates/ IS present in extracted tarball', () => {
  // Confirms the staging step in prepack placed the templates where the fallback expects.
  const skillTemplatesDir = join(extractDir, 'package', 'dist', 'skill-templates');
  assert.ok(
    existsSync(skillTemplatesDir),
    `dist/skill-templates/ must be present in the extracted tarball\nChecked: ${skillTemplatesDir}`,
  );
});
