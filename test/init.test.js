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
import { mkdirSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const bin = join(root, 'bin/ai-catapult.js');
const fixtureDir = join(__dirname, 'fixtures/init-standalone');

// Fixed canonical inputs — must match regen-fixture.sh
const FIXED_ARGS = [
  '--repo-id', 'example-repo',
  '--date', '2026-01-01',
  '--upstream-url', 'https://github.com/example-org/example-repo.git',
  '--upstream-ref', 'main',
];

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

test('ai-catapult init emits mechanical scaffold matching committed fixture', () => {
  const tmpDir = join(root, '.tmp-init-test');
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

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
  const tmpDir = join(root, '.tmp-init-jl-test');
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

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
