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
import { rmSync, readFileSync, writeFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveVendorSkill } from '../src/skill-resolver.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const bin = join(root, 'bin/ai-catapult.ts');
const fixtureDir = join(__dirname, 'fixtures/init-standalone');
const vendorTemplatesDir = join(resolveVendorSkill(join(root, 'vendor/skills')), 'templates');

// Fixed canonical inputs — must match scripts/regen-fixture.ts
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
function collectFiles(dir: string, base: string = dir, acc: string[] = []): string[] {
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
function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

void test('ai-catapult init emits mechanical scaffold matching committed fixture', () => {
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

    // Byte-compare each fixture file.
    // NEXT-STEPS.md now uses relative paths in the file (pathDisplay='.') so it
    // is machine-independent and byte-identical across environments — no
    // normalisation needed.
    for (const relPath of fixtureFiles) {
      const expected = readFileSync(join(fixtureDir, relPath), 'utf8');
      const actual = readFileSync(join(tmpDir, relPath), 'utf8');
      assert.equal(actual, expected, `Content mismatch for ${relPath}`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

void test('ai-catapult init does NOT write judgment-laden paths as files', () => {
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

void test('ai-catapult init accepts --help and exits 0', () => {
  const result = spawnSync(process.execPath, [bin, 'init', '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, `expected exit 0 for init --help; got ${result.status}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /init/, 'help output should mention init');
});

// ---------------------------------------------------------------------------
// Fix #5: Independent rendering assertion (non-tautological)
// ---------------------------------------------------------------------------

void test('ai-catapult init: .ai/matrix.json matches inline token substitution (non-fixture path)', () => {
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

void test('ai-catapult init: no {{TOKEN}} placeholders remain in emitted tree', () => {
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

void test('ai-catapult --date init init <target> dispatches correctly (fix #2 regression)', () => {
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

void test('ai-catapult init refuses to overwrite existing files without --force', () => {
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

void test('ai-catapult init --force succeeds when files already exist', () => {
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

void test('scaffold rejects path traversal in manifest template path', async () => {
  const { scaffold } = await import('../src/scaffold.ts');
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
      (err: unknown) => {
        assert.match((err as Error).message, /traversal/i, 'Error must mention traversal');
        return true;
      },
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(fakeTemplatesDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ACH-C-03: seeded readiness-policy/2 (N3) — semantics, validator gaps, collision
// ---------------------------------------------------------------------------

const POLICY_REL = '.ai/policies/readiness-policy.json';
const N3_ACCEPT = ['agent-self', 'ssh-tag', 'in-session'];

type SeededPolicy = {
  schema: string;
  identity_model: string;
  required_checks: unknown[];
  repository: { id: string };
  approval: { accept: string[]; default_mode: string; anchor_sha256: string | null };
};

type AdmissionStage = { admitted: boolean; policy_codes: string[] };

type ValidatorReport = {
  accept: string[];
  default_mode: string;
  policy_gaps: string[];
  stages: Record<string, AdmissionStage>;
};

// Disposable pure-validator seam. Not a live admission and not authority.
const VALIDATOR_SCRIPT = `
import json, sys
from datetime import datetime, timezone
from pathlib import Path
autobahn, policy_path = map(Path, sys.argv[1:3])
assert sys.flags.isolated and sys.dont_write_bytecode, "python3 -I -B required"
sys.path.insert(0, str(autobahn / "lib"))
import readiness_contract_v2 as v2
data = policy_path.read_bytes()
policy = json.loads(data)
v2.validate_policy(policy)
bundle = {
    "schema": "handoff-goals/2", "id": "seed-check", "repository": policy["repository"],
    "spec": {"path": "spec.md"},
    "goals": [{"id": "G1", "scope": ["src/probe.txt"],
               "acceptance_criteria": ["Seeded policy admission gaps"],
               "dependencies": [], "verification": ["bash tests/check.sh"]}],
}
sidecar = {
    "schema": "readiness-sidecar/1", "plan_id": "seed-check",
    "goals": {"G1": {
        "readiness": {"preparation": "unknown", "implementation": "unknown", "merge": "unknown"},
        "coverage_status": "unknown", "legacy_safe_tdd": True,
        "legacy_risk_reason": "Disposable seeded-policy admission check; coverage unknown",
    }},
}
digests = {
    "bundle_sha256": v2.bundle_sha256(bundle), "spec_sha256": "0" * 64,
    "policy_sha256": v2.sha256(data), "anchor_sha256": policy["approval"]["anchor_sha256"],
}
generation = v2.generation_v2(**digests)
stages = {}
for stage in ("planning", "preparation", "implementation", "merge"):
    context = v2.admission({
        "stage": stage, "goals": ["G1"], "now": datetime(2026, 10, 10, tzinfo=timezone.utc),
        "registered": {"id": "disposable", "generation": generation},
        "policy": policy, "policy_mode": "live", "bundle": bundle, "sidecar": sidecar,
        "digests": digests, "carrier": None,
        "observation": {"schema": "observation/1", "adapter": "none", "facts": {}},
        "errors": [],
    })
    stages[stage] = {
        "admitted": context["admitted"],
        "policy_codes": [gap["code"] for gap in context["gaps"] if gap.get("source") == "policy"],
    }
json.dump({
    "accept": policy["approval"]["accept"], "default_mode": policy["approval"]["default_mode"],
    "policy_gaps": v2.policy_gaps(policy), "stages": stages,
}, sys.stdout)
`;

function renderedPolicyTemplate(): string {
  const raw = readFileSync(join(vendorTemplatesDir, 'dot-ai/policies/readiness-policy.json'), 'utf8');
  return raw
    .replaceAll('{{REPO_ID}}', FIXED_TOKENS.REPO_ID)
    .replaceAll('{{DATE}}', FIXED_TOKENS.DATE)
    .replaceAll('{{UPSTREAM_URL}}', FIXED_TOKENS.UPSTREAM_URL)
    .replaceAll('{{UPSTREAM_REF}}', FIXED_TOKENS.UPSTREAM_REF);
}

function assertN3(policy: SeededPolicy): void {
  assert.equal(policy.schema, 'readiness-policy/2');
  assert.equal(policy.identity_model, 'multi');
  assert.equal(policy.repository.id, FIXED_TOKENS.REPO_ID);
  assert.equal(policy.approval.anchor_sha256, null);
  assert.deepEqual(policy.required_checks, []);
  assert.deepEqual(policy.approval.accept, N3_ACCEPT);
  assert.equal(policy.approval.default_mode, 'agent');
}

function runFixedInit(target: string, extra: string[] = []) {
  return spawnSync(process.execPath, [bin, 'init', target, ...FIXED_ARGS, ...extra], { encoding: 'utf8' });
}

function writeSentinelPolicy(target: string): string {
  const full = join(target, POLICY_REL);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, '{"sentinel":true}\n', 'utf8');
  return full;
}

function validateEmittedPolicy(policyPath: string): void {
  const autobahn = join(root, 'vendor/skills/04-validate-handoff/autobahn');
  const result = spawnSync('python3', ['-I', '-B', '-c', VALIDATOR_SCRIPT, autobahn, policyPath], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `validator failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const report = JSON.parse(result.stdout) as ValidatorReport;
  assert.deepEqual(report.policy_gaps, ['anchor_unset', 'required_checks_unset']);
  assert.deepEqual(report.accept, N3_ACCEPT);
  assert.equal(report.default_mode, 'agent');
  for (const stage of ['planning', 'preparation', 'implementation', 'merge']) {
    const named = report.stages[stage];
    assert.ok(named, `admission missing stage ${stage}`);
    assert.equal(named.admitted, false, `${stage} must stay unadmitted while placeholders are unset`);
    assert.ok(named.policy_codes.includes('anchor_unset'), `${stage} admission must name anchor_unset`);
    assert.ok(named.policy_codes.includes('required_checks_unset'), `${stage} admission must name required_checks_unset`);
  }
}

void test('ACH-C-03 init emits the seeded readiness-policy from the vendored template', () => {
  const tmpDir = makeTmpDir('ai-catapult-init-policy-');
  try {
    const result = runFixedInit(tmpDir);
    assert.equal(result.status, 0, `init failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    const emitted = readFileSync(join(tmpDir, POLICY_REL), 'utf8');
    const rendered = renderedPolicyTemplate();
    const fixture = readFileSync(join(fixtureDir, POLICY_REL), 'utf8');
    assert.equal(emitted, rendered, 'emitted policy must be the vendored template with fixed tokens');
    assert.equal(emitted, fixture, 'emitted policy must match the C-02 fixture; do not regenerate it here');
    assertN3(JSON.parse(emitted) as SeededPolicy);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

void test('ACH-C-03 init seeded policy admission names anchor_unset and required_checks_unset', () => {
  const tmpDir = makeTmpDir('ai-catapult-init-policy-gaps-');
  try {
    const result = runFixedInit(tmpDir);
    assert.equal(result.status, 0, `init failed\nstderr: ${result.stderr}`);
    validateEmittedPolicy(join(tmpDir, POLICY_REL));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

void test('ACH-C-03 init refuses a policy-only collision without --force and writes nothing', () => {
  const tmpDir = makeTmpDir('ai-catapult-init-policy-collision-');
  try {
    const policyPath = writeSentinelPolicy(tmpDir);
    const before = readFileSync(policyPath, 'utf8');
    const result = runFixedInit(tmpDir);
    assert.notEqual(result.status, 0, 'policy-only collision must refuse');
    assert.match(result.stderr, /--force/, 'refusal must name --force');
    assert.match(result.stderr, /\.ai\/policies\/readiness-policy\.json/, 'refusal must name the policy path');
    assert.deepEqual(collectFiles(tmpDir), [POLICY_REL], 'collision must not emit any other file');
    assert.equal(readFileSync(policyPath, 'utf8'), before, 'existing policy bytes must be unchanged');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

void test('ACH-C-03 init --force restores the seeded policy bytes', () => {
  const tmpDir = makeTmpDir('ai-catapult-init-policy-force-');
  try {
    writeSentinelPolicy(tmpDir);
    const result = runFixedInit(tmpDir, ['--force']);
    assert.equal(result.status, 0, `init --force failed\nstderr: ${result.stderr}`);
    const emitted = readFileSync(join(tmpDir, POLICY_REL), 'utf8');
    assert.equal(emitted, renderedPolicyTemplate(), '--force must restore the vendored template render');
    assert.ok(!emitted.includes('sentinel'), 'sentinel policy must be overwritten');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
