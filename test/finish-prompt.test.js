/**
 * TDD tests for Slice 4 — in-harness finish prompt.
 *
 * After `ai-catapult init` scaffolds the mechanical skeleton it must:
 *   (a) Print a structured next-steps block to stdout that references the
 *       real emitted paths (derived, not hardcoded) and lists the
 *       judgment-laden phases read from boundary-manifest.json.
 *   (b) Write the same block to <target>/.ai/handoff/NEXT-STEPS.md.
 *
 * All assertions use spawnSync so the full CLI path is exercised.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const bin = join(root, 'bin/ai-catapult.js');
const manifestPath = join(root, 'vendor/skills/ai-catapult-init/templates/boundary-manifest.json');

// Fixed canonical inputs — same as init.test.js
const FIXED_ARGS = [
  '--repo-id', 'example-repo',
  '--date', '2026-01-01',
  '--upstream-url', 'https://github.com/example-org/example-repo.git',
  '--upstream-ref', 'main',
];

function makeTmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// (a) stdout contains the resolved target path and references emitted paths
// ---------------------------------------------------------------------------

test('finish-prompt: stdout references the resolved target directory', () => {
  const tmpDir = makeTmpDir('ai-catapult-fp-target-');

  try {
    const result = spawnSync(process.execPath, [bin, 'init', tmpDir, ...FIXED_ARGS], {
      encoding: 'utf8',
    });

    assert.equal(
      result.status, 0,
      `ai-catapult init exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );

    assert.ok(
      result.stdout.includes(tmpDir),
      `stdout must contain the resolved target path "${tmpDir}"\nActual stdout:\n${result.stdout}`,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('finish-prompt: stdout references .ai/matrix.json which actually exists in the emitted tree', () => {
  const tmpDir = makeTmpDir('ai-catapult-fp-matrix-');

  try {
    const result = spawnSync(process.execPath, [bin, 'init', tmpDir, ...FIXED_ARGS], {
      encoding: 'utf8',
    });

    assert.equal(
      result.status, 0,
      `ai-catapult init exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );

    // stdout must mention .ai/matrix.json
    assert.ok(
      result.stdout.includes('.ai/matrix.json'),
      `stdout must reference ".ai/matrix.json"\nActual stdout:\n${result.stdout}`,
    );

    // The referenced file must actually exist
    assert.ok(
      existsSync(join(tmpDir, '.ai/matrix.json')),
      `.ai/matrix.json must exist in emitted tree at ${tmpDir}`,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('finish-prompt: stdout references AGENTS.md which actually exists in the emitted tree', () => {
  const tmpDir = makeTmpDir('ai-catapult-fp-agents-');

  try {
    const result = spawnSync(process.execPath, [bin, 'init', tmpDir, ...FIXED_ARGS], {
      encoding: 'utf8',
    });

    assert.equal(
      result.status, 0,
      `ai-catapult init exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );

    // stdout must mention AGENTS.md
    assert.ok(
      result.stdout.includes('AGENTS.md'),
      `stdout must reference "AGENTS.md"\nActual stdout:\n${result.stdout}`,
    );

    // The referenced file must actually exist
    assert.ok(
      existsSync(join(tmpDir, 'AGENTS.md')),
      `AGENTS.md must exist in emitted tree at ${tmpDir}`,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (b) NEXT-STEPS.md is written to <target>/.ai/handoff/NEXT-STEPS.md
// ---------------------------------------------------------------------------

test('finish-prompt: NEXT-STEPS.md is written to <target>/.ai/handoff/NEXT-STEPS.md', () => {
  const tmpDir = makeTmpDir('ai-catapult-fp-nextsteps-');

  try {
    const result = spawnSync(process.execPath, [bin, 'init', tmpDir, ...FIXED_ARGS], {
      encoding: 'utf8',
    });

    assert.equal(
      result.status, 0,
      `ai-catapult init exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );

    const nextStepsPath = join(tmpDir, '.ai/handoff/NEXT-STEPS.md');
    assert.ok(
      existsSync(nextStepsPath),
      `NEXT-STEPS.md must exist at ${nextStepsPath}`,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('finish-prompt: NEXT-STEPS.md contains the same key references as stdout', () => {
  const tmpDir = makeTmpDir('ai-catapult-fp-nextsteps-match-');

  try {
    const result = spawnSync(process.execPath, [bin, 'init', tmpDir, ...FIXED_ARGS], {
      encoding: 'utf8',
    });

    assert.equal(
      result.status, 0,
      `ai-catapult init exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );

    const nextStepsPath = join(tmpDir, '.ai/handoff/NEXT-STEPS.md');
    const fileContent = readFileSync(nextStepsPath, 'utf8');

    // Both stdout and file should reference the target dir
    assert.ok(
      fileContent.includes(tmpDir),
      `NEXT-STEPS.md must contain the resolved target path "${tmpDir}"\nFile content:\n${fileContent}`,
    );

    // Both should reference .ai/matrix.json
    assert.ok(
      fileContent.includes('.ai/matrix.json'),
      `NEXT-STEPS.md must reference ".ai/matrix.json"\nFile content:\n${fileContent}`,
    );

    // Both should reference AGENTS.md
    assert.ok(
      fileContent.includes('AGENTS.md'),
      `NEXT-STEPS.md must reference "AGENTS.md"\nFile content:\n${fileContent}`,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (c) prompt lists judgment-laden paths from the manifest
// ---------------------------------------------------------------------------

test('finish-prompt: stdout lists at least the judgment-laden paths from boundary-manifest.json', () => {
  const tmpDir = makeTmpDir('ai-catapult-fp-jl-');

  try {
    const result = spawnSync(process.execPath, [bin, 'init', tmpDir, ...FIXED_ARGS], {
      encoding: 'utf8',
    });

    assert.equal(
      result.status, 0,
      `ai-catapult init exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );

    // Read judgment-laden paths from the manifest (derived, not hardcoded)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const judgmentLadenPaths = manifest.paths
      .filter((p) => p.classification === 'judgment_laden')
      .map((p) => p.path);

    assert.ok(
      judgmentLadenPaths.length > 0,
      'Expected at least one judgment-laden path in manifest',
    );

    // Each judgment-laden path must appear somewhere in stdout
    for (const jlPath of judgmentLadenPaths) {
      assert.ok(
        result.stdout.includes(jlPath),
        `stdout must mention judgment-laden path "${jlPath}"\nActual stdout:\n${result.stdout}`,
      );
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('finish-prompt: NEXT-STEPS.md lists judgment-laden paths from boundary-manifest.json', () => {
  const tmpDir = makeTmpDir('ai-catapult-fp-jl-file-');

  try {
    const result = spawnSync(process.execPath, [bin, 'init', tmpDir, ...FIXED_ARGS], {
      encoding: 'utf8',
    });

    assert.equal(
      result.status, 0,
      `ai-catapult init exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );

    const nextStepsPath = join(tmpDir, '.ai/handoff/NEXT-STEPS.md');
    const fileContent = readFileSync(nextStepsPath, 'utf8');

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const judgmentLadenPaths = manifest.paths
      .filter((p) => p.classification === 'judgment_laden')
      .map((p) => p.path);

    for (const jlPath of judgmentLadenPaths) {
      assert.ok(
        fileContent.includes(jlPath),
        `NEXT-STEPS.md must mention judgment-laden path "${jlPath}"\nFile content:\n${fileContent}`,
      );
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (d) prompt mentions the in-harness invocation
// ---------------------------------------------------------------------------

test('finish-prompt: stdout mentions the ai-catapult-init skill invocation', () => {
  const tmpDir = makeTmpDir('ai-catapult-fp-skill-');

  try {
    const result = spawnSync(process.execPath, [bin, 'init', tmpDir, ...FIXED_ARGS], {
      encoding: 'utf8',
    });

    assert.equal(
      result.status, 0,
      `ai-catapult init exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );

    assert.ok(
      result.stdout.includes('ai-catapult-init'),
      `stdout must mention "ai-catapult-init" skill\nActual stdout:\n${result.stdout}`,
    );

    // Must also mention npx ai-catapult install
    assert.ok(
      result.stdout.includes('npx ai-catapult install'),
      `stdout must mention "npx ai-catapult install"\nActual stdout:\n${result.stdout}`,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (e) determinism — same inputs produce identical NEXT-STEPS.md content
// ---------------------------------------------------------------------------

test('finish-prompt: NEXT-STEPS.md content is deterministic for same inputs (different target paths)', () => {
  // Two different target dirs — the prompt content should differ only in the
  // target path, but both must be valid (non-empty, structured).
  const tmpDir1 = makeTmpDir('ai-catapult-fp-det1-');
  const tmpDir2 = makeTmpDir('ai-catapult-fp-det2-');

  try {
    const run = (dir) =>
      spawnSync(process.execPath, [bin, 'init', dir, ...FIXED_ARGS], { encoding: 'utf8' });

    const r1 = run(tmpDir1);
    const r2 = run(tmpDir2);

    assert.equal(r1.status, 0, `Run 1 failed: ${r1.stderr}`);
    assert.equal(r2.status, 0, `Run 2 failed: ${r2.stderr}`);

    // Replace target dir in content to compare structure
    const normalise = (dir, content) => content.replaceAll(dir, '<TARGET>');

    const f1 = readFileSync(join(tmpDir1, '.ai/handoff/NEXT-STEPS.md'), 'utf8');
    const f2 = readFileSync(join(tmpDir2, '.ai/handoff/NEXT-STEPS.md'), 'utf8');

    assert.equal(
      normalise(tmpDir1, f1),
      normalise(tmpDir2, f2),
      'NEXT-STEPS.md structure must be identical given same inputs (modulo target path)',
    );
  } finally {
    rmSync(tmpDir1, { recursive: true, force: true });
    rmSync(tmpDir2, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (f) parity: NEXT-STEPS.md appears in the fixture set (regression guard)
// ---------------------------------------------------------------------------

test('finish-prompt: .ai/handoff/NEXT-STEPS.md exists after init (fixture regression guard)', () => {
  const tmpDir = makeTmpDir('ai-catapult-fp-fixture-');

  try {
    const result = spawnSync(process.execPath, [bin, 'init', tmpDir, ...FIXED_ARGS], {
      encoding: 'utf8',
    });

    assert.equal(
      result.status, 0,
      `ai-catapult init exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );

    assert.ok(
      existsSync(join(tmpDir, '.ai/handoff/NEXT-STEPS.md')),
      '.ai/handoff/NEXT-STEPS.md must be emitted (it lands in the fixture after regen)',
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
