/**
 * TDD parity test for `ai-catapult init` (Slice 3).
 *
 * Runs `ai-catapult init <tmpdir>` with fixed inputs and byte-compares the
 * emitted tree against the committed fixture in test/fixtures/init-standalone/.
 *
 * Fixed inputs (canonical for fixture generation):
 *   --repo-id  example-repo
 *   --date     2026-01-01
 *   --upstream-url  https://github.com/example-org/example-repo.git
 *   --upstream-ref  main
 *
 * The test also asserts that judgment-laden paths are NOT written as files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const bin = join(root, 'bin/ai-catapult.js');
const fixtureDir = join(__dirname, 'fixtures/init-standalone');
const vendorTemplatesDir = join(root, 'vendor/skills/ai-catapult-init/templates');

// Fixed canonical inputs — must match regen-fixture.sh
const FIXED_ARGS = [
  '--repo-id', 'example-repo',
  '--date', '2026-01-01',
  '--upstream-url', 'https://github.com/example-org/example-repo.git',
  '--upstream-ref', 'main',
];

// Token values matching FIXED_ARGS
const FIXED_TOKENS = {
  REPO_ID: 'example-repo',
  DATE: '2026-01-01',
  UPSTREAM_URL: 'https://github.com/example-org/example-repo.git',
  UPSTREAM_REF: 'main',
};

// Judgment-laden paths that must NOT be written as files.
const JUDGMENT_LADEN_PATHS = [
  '.ai/handoff/init-ai-repo-handoff.md',
  '.ai/traceability/graph.json',
  '.ai/traceability/index.md',
  '.ai/traceability/validation-report.md',
  'docs/architecture/adr/0001-init.md',
  '.ai/cascade/cascade-plan.json',
  '.memory/human-override/custom-conventions.md',
  '.memory/human-override/tribal-knowledge.md',
  '.memory/self-learned/error-patterns.json',
  '.memory/self-learned/module-complexity.json',
];

/**
 * Recursively collect all files under a directory as relative paths.
 * Returns sorted array.
 */
function collectFiles(dir, base = dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(fullPath, base, acc);
    } else {
      acc.push(relative(base, fullPath));
    }
  }
  return acc;
}

/**
 * Create a temp directory under os.tmpdir() for test isolation.
 * Returns absolute path.
 */
function makeTmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('ai-catapult init emits mechanical scaffold matching committed fixture', () => {
  const tmpDir = makeTmpDir('ai-catapult-init-parity-');

  try {
    const result = spawnSync(process.execPath, [bin, 'init', tmpDir, ...FIXED_ARGS], {
      encoding: 'utf8',
    });

    assert.equal(
      result.status, 0,
      `ai-catapult init exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );

    // Collect files from fixture and output
    const fixtureFiles = collectFiles(fixtureDir);
    const outputFiles = collectFiles(tmpDir);

    // Every fixture file must be present in output
    for (const relPath of fixtureFiles) {
      assert.ok(
        outputFiles.includes(relPath),
        `Expected output to contain fixture file: ${relPath}\nOutput files: ${outputFiles.join(', ')}`,
      );
    }

    // Every output file must exist in fixture (no extra mechanical files emitted)
    for (const relPath of outputFiles) {
      assert.ok(
        fixtureFiles.includes(relPath),
        `Output emitted unexpected file not in fixture: ${relPath}`,
      );
    }

    // Byte-compare each fixture file
    for (const relPath of fixtureFiles) {
      const expected = readFileSync(join(fixtureDir, relPath), 'utf8');
      const actual = readFileSync(join(tmpDir, relPath), 'utf8');
      assert.equal(actual, expected, `Content mismatch for ${relPath}`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ai-catapult init does NOT write judgment-laden paths as files', () => {
  const tmpDir = makeTmpDir('ai-catapult-init-jl-');

  try {
    const result = spawnSync(process.execPath, [bin, 'init', tmpDir, ...FIXED_ARGS], {
      encoding: 'utf8',
    });

    assert.equal(
      result.status, 0,
      `ai-catapult init exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );

    for (const jlPath of JUDGMENT_LADEN_PATHS) {
      const fullPath = join(tmpDir, jlPath);
      assert.ok(
        !existsSync(fullPath),
        `Judgment-laden path must not be written as a file: ${jlPath}`,
      );
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ai-catapult init accepts --help and exits 0', () => {
  const result = spawnSync(process.execPath, [bin, 'init', '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, `expected exit 0 for init --help; got ${result.status}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /init/, 'help output should mention init');
});

// ---------------------------------------------------------------------------
// Fix #5: Independent rendering assertion (non-tautological)
// ---------------------------------------------------------------------------

test('ai-catapult init: .ai/matrix.json matches inline token substitution (non-fixture path)', () => {
  const tmpDir = makeTmpDir('ai-catapult-init-matrix-');

  try {
    const result = spawnSync(process.execPath, [bin, 'init', tmpDir, ...FIXED_ARGS], {
      encoding: 'utf8',
    });

    assert.equal(
      result.status, 0,
      `ai-catapult init exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );

    // Read the RAW vendored template (not the fixture) and apply substitution inline
    const rawTemplate = readFileSync(join(vendorTemplatesDir, 'dot-ai/matrix.json'), 'utf8');
    const expected = rawTemplate
      .replaceAll('{{REPO_ID}}', FIXED_TOKENS.REPO_ID)
      .replaceAll('{{DATE}}', FIXED_TOKENS.DATE)
      .replaceAll('{{UPSTREAM_URL}}', FIXED_TOKENS.UPSTREAM_URL)
      .replaceAll('{{UPSTREAM_REF}}', FIXED_TOKENS.UPSTREAM_REF);

    const actual = readFileSync(join(tmpDir, '.ai/matrix.json'), 'utf8');
    assert.equal(actual, expected, '.ai/matrix.json does not match inline token substitution of vendored template');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ai-catapult init: no {{TOKEN}} placeholders remain in emitted tree', () => {
  const tmpDir = makeTmpDir('ai-catapult-init-tokens-');

  try {
    const result = spawnSync(process.execPath, [bin, 'init', tmpDir, ...FIXED_ARGS], {
      encoding: 'utf8',
    });

    assert.equal(
      result.status, 0,
      `ai-catapult init exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );

    const tokenPattern = /\{\{(REPO_ID|DATE|UPSTREAM_URL|UPSTREAM_REF)\}\}/;
    const emittedFiles = collectFiles(tmpDir);

    for (const relPath of emittedFiles) {
      const content = readFileSync(join(tmpDir, relPath), 'utf8');
      assert.ok(
        !tokenPattern.test(content),
        `Unreplaced token found in emitted file: ${relPath}`,
      );
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fix #2: Regression test — verb re-slice bug with flag value matching subcommand
// ---------------------------------------------------------------------------

test('ai-catapult --date init init <target> dispatches correctly (fix #2 regression)', () => {
  const tmpDir = makeTmpDir('ai-catapult-init-dispatch-');

  try {
    // `--date init` means the date flag gets value "init" (the first "init" token).
    // The subcommand is the SECOND "init". Without fix #2, rawArgv.indexOf('init')
    // would find the flag value and then slice from there, scaffolding into ./init.
    const result = spawnSync(
      process.execPath,
      [bin, '--date', 'init', 'init', tmpDir, '--repo-id', 'dispatch-test', '--upstream-ref', 'main'],
      { encoding: 'utf8' },
    );

    // Must scaffold into tmpDir, not ./init
    assert.equal(
      result.status, 0,
      `Expected exit 0; got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );

    // The scaffold must have landed in tmpDir, not in ./init
    assert.ok(
      existsSync(join(tmpDir, '.ai/matrix.json')),
      `Expected .ai/matrix.json inside tmpDir (${tmpDir}), not in ./init`,
    );

    // ./init must NOT exist (no mis-dispatch)
    assert.ok(
      !existsSync(join(process.cwd(), 'init', '.ai')),
      'Mis-dispatch: scaffold landed in ./init instead of tmpDir',
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    // clean up ./init if somehow created
    rmSync(join(process.cwd(), 'init'), { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fix #3: Collision detection — refuse without --force, succeed with --force
// ---------------------------------------------------------------------------

test('ai-catapult init refuses to overwrite existing files without --force', () => {
  const tmpDir = makeTmpDir('ai-catapult-init-clobber-');

  try {
    // First init (clean)
    const first = spawnSync(process.execPath, [bin, 'init', tmpDir, ...FIXED_ARGS], { encoding: 'utf8' });
    assert.equal(first.status, 0, `First init failed: ${first.stderr}`);

    // Second init into same dir WITHOUT --force
    const second = spawnSync(process.execPath, [bin, 'init', tmpDir, ...FIXED_ARGS], { encoding: 'utf8' });
    assert.notEqual(second.status, 0, 'Expected non-zero exit when overwriting without --force');
    assert.match(second.stderr, /--force/, 'Error message must mention --force');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ai-catapult init --force succeeds when files already exist', () => {
  const tmpDir = makeTmpDir('ai-catapult-init-force-');

  try {
    // First init
    const first = spawnSync(process.execPath, [bin, 'init', tmpDir, ...FIXED_ARGS], { encoding: 'utf8' });
    assert.equal(first.status, 0, `First init failed: ${first.stderr}`);

    // Modify a file to confirm --force overwrites it
    const matrixPath = join(tmpDir, '.ai/matrix.json');
    writeFileSync(matrixPath, '{"clobbered":true}', 'utf8');

    // Second init WITH --force
    const second = spawnSync(
      process.execPath,
      [bin, 'init', tmpDir, ...FIXED_ARGS, '--force'],
      { encoding: 'utf8' },
    );
    assert.equal(second.status, 0, `Init --force failed: ${second.stderr}`);

    // Confirm the file was restored (not the clobbered sentinel)
    const content = readFileSync(matrixPath, 'utf8');
    assert.ok(!content.includes('"clobbered"'), '.ai/matrix.json was not overwritten by --force');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fix #4: Path traversal — hostile manifest entry is rejected
// ---------------------------------------------------------------------------

test('scaffold rejects path traversal in manifest template path', async () => {
  const { scaffold } = await import('../src/scaffold.js');
  const tmpDir = makeTmpDir('ai-catapult-init-traversal-');

  // Build a minimal fake templates dir with a hostile manifest
  const fakeTemplatesDir = makeTmpDir('ai-catapult-fake-templates-');

  try {
    // Hostile manifest: template path contains '..' to escape targetDir
    const hostileManifest = {
      schema_version: '1.0',
      paths: [
        {
          path: '../evil.txt',
          classification: 'mechanical',
          template: '../../evil.txt',
        },
      ],
    };

    writeFileSync(join(fakeTemplatesDir, 'boundary-manifest.json'), JSON.stringify(hostileManifest), 'utf8');

    assert.throws(
      () => scaffold({
        targetDir: tmpDir,
        templatesDir: fakeTemplatesDir,
        repoId: 'test',
        date: '2026-01-01',
        upstreamUrl: '',
        upstreamRef: 'main',
        force: true,
      }),
      (err) => {
        assert.match(err.message, /traversal/i, 'Error must mention traversal');
        return true;
      },
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(fakeTemplatesDir, { recursive: true, force: true });
  }
});
