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
import { resolveVendorSkill } from '../src/skill-resolver.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const bin = join(root, 'bin/ai-catapult.js');
const manifestPath = join(resolveVendorSkill(join(root, 'vendor/skills')), 'templates/boundary-manifest.json');

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

    // Unique finish-prompt markers — proves this is the finish prompt, not a
    // plain console.log that happened to print the target directory.
    assert.ok(
      result.stdout.includes('scaffold complete'),
      `stdout must contain "scaffold complete" (unique finish-prompt header)\nActual stdout:\n${result.stdout}`,
    );
    assert.ok(
      result.stdout.includes('Next step: complete in-harness'),
      `stdout must contain "Next step: complete in-harness"\nActual stdout:\n${result.stdout}`,
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

test('finish-prompt: NEXT-STEPS.md uses relative paths and references key emitted files', () => {
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

    // File must NOT contain the absolute target path — it uses relative paths
    // so it is machine-independent and byte-identical across CI runs.
    assert.ok(
      !fileContent.includes(tmpDir),
      `NEXT-STEPS.md must NOT contain the absolute target path (file uses relative paths)\nFile content:\n${fileContent}`,
    );

    // File should reference .ai/matrix.json (relative)
    assert.ok(
      fileContent.includes('.ai/matrix.json'),
      `NEXT-STEPS.md must reference ".ai/matrix.json"\nFile content:\n${fileContent}`,
    );

    // File should reference AGENTS.md (relative)
    assert.ok(
      fileContent.includes('AGENTS.md'),
      `NEXT-STEPS.md must reference "AGENTS.md"\nFile content:\n${fileContent}`,
    );

    // The relative paths must actually resolve to real files under tmpDir
    assert.ok(
      existsSync(join(tmpDir, '.ai/matrix.json')),
      `.ai/matrix.json referenced in NEXT-STEPS.md must exist under ${tmpDir}`,
    );
    assert.ok(
      existsSync(join(tmpDir, 'AGENTS.md')),
      `AGENTS.md referenced in NEXT-STEPS.md must exist under ${tmpDir}`,
    );

    // stdout must still contain the absolute path
    assert.ok(
      result.stdout.includes(tmpDir),
      `stdout must contain the absolute target path "${tmpDir}"\nActual stdout:\n${result.stdout}`,
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

test('finish-prompt: NEXT-STEPS.md is byte-identical across two different target directories', () => {
  // The file uses relative paths (pathDisplay='.') so it must be fully
  // byte-identical regardless of where the target directory lives — no
  // normalisation required. This is the stronger property that enables the
  // parity oracle in init.test.js to do a direct byte-diff.
  const tmpDir1 = makeTmpDir('ai-catapult-fp-det1-');
  const tmpDir2 = makeTmpDir('ai-catapult-fp-det2-');

  try {
    const run = (dir) =>
      spawnSync(process.execPath, [bin, 'init', dir, ...FIXED_ARGS], { encoding: 'utf8' });

    const r1 = run(tmpDir1);
    const r2 = run(tmpDir2);

    assert.equal(r1.status, 0, `Run 1 failed: ${r1.stderr}`);
    assert.equal(r2.status, 0, `Run 2 failed: ${r2.stderr}`);

    const f1 = readFileSync(join(tmpDir1, '.ai/handoff/NEXT-STEPS.md'), 'utf8');
    const f2 = readFileSync(join(tmpDir2, '.ai/handoff/NEXT-STEPS.md'), 'utf8');

    // Byte-identical — no normalisation needed
    assert.equal(
      f1,
      f2,
      'NEXT-STEPS.md must be byte-identical across two different target directories ' +
      '(file uses relative paths, so the absolute target path must not appear in it)',
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

// ---------------------------------------------------------------------------
// (g) drift-guard: if install handler is still a stub (exits non-zero),
//     the prompt must carry the forthcoming-marker so they cannot silently
//     drift apart. When install ships (Slice 7), the stub exit code changes
//     to 0 and this test will force a prompt update.
// ---------------------------------------------------------------------------

test('finish-prompt drift-guard: if install is still a stub, prompt must contain forthcoming-marker', () => {
  // Probe whether the install handler is still a stub by running it.
  const installResult = spawnSync(process.execPath, [bin, 'install'], { encoding: 'utf8' });
  const installIsStub = installResult.status !== 0;

  if (!installIsStub) {
    // install has shipped — drift-guard is not needed for this direction.
    // The complementary test below enforces the shipped invariant.
    return;
  }

  // install is still a stub: the finish prompt must carry the forthcoming-marker.
  const tmpDir = makeTmpDir('ai-catapult-fp-driftguard-');

  try {
    const result = spawnSync(process.execPath, [bin, 'init', tmpDir, ...FIXED_ARGS], {
      encoding: 'utf8',
    });

    assert.equal(
      result.status, 0,
      `ai-catapult init exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );

    assert.match(
      result.stdout,
      /later slice|upcoming release|not yet available/i,
      'While install is a stub, the finish prompt must contain a forthcoming-marker ' +
      '(e.g. "upcoming release") so prompt and stub cannot silently drift apart.\n' +
      `Actual stdout:\n${result.stdout}`,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (h) drift-guard complement: once install ships (exit 0), the prompt must
//     NOT carry forthcoming-marker language. This prevents stale "coming soon"
//     text from lingering after the feature is live.
// ---------------------------------------------------------------------------

test('finish-prompt drift-guard complement: once install ships, prompt must NOT contain forthcoming-marker', () => {
  // Probe whether install has shipped (exits 0 with no harness dirs present).
  const installResult = spawnSync(process.execPath, [bin, 'install'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: '/nonexistent-no-home', CODEX_HOME: '/nonexistent-no-codex' },
  });
  const installIsStub = installResult.status !== 0;

  if (installIsStub) {
    // install is still a stub — complementary check does not apply yet.
    return;
  }

  // install has shipped: the finish prompt must NOT carry the forthcoming-marker.
  const tmpDir = makeTmpDir('ai-catapult-fp-driftguard-shipped-');

  try {
    const result = spawnSync(process.execPath, [bin, 'init', tmpDir, ...FIXED_ARGS], {
      encoding: 'utf8',
    });

    assert.equal(
      result.status, 0,
      `ai-catapult init exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );

    assert.doesNotMatch(
      result.stdout,
      /upcoming release|later slice|not yet available/i,
      'Now that install has shipped, the finish prompt must NOT contain forthcoming-marker language ' +
      '(e.g. "upcoming release", "later slice", "not yet available").\n' +
      `Actual stdout:\n${result.stdout}`,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
