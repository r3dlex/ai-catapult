import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const canonicalHead = '362676687ac6cf266b145f459d4dee91d4fc8e45';
const canonicalGeneratorSha256 = 'f760d841149b729889211ac6946a803c331664f98b4840d4dbfed77768e27382';
const canonicalTemplateSha256 = '449a0d74f7150e8558a3884d5bd09c031f00dd4885d8690fef53c00a2ae9a358';
const stableDist = process.env.AI_CATAPULT_DIST_ROOT || join(root, 'dist');
let pluginDist;

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function assertCanonicalContract(generatorPath, templatePath, surface) {
  assert.ok(existsSync(generatorPath), `${surface} is missing the canonical README generator: ${generatorPath}`);
  assert.ok(existsSync(templatePath), `${surface} is missing the canonical README template: ${templatePath}`);
  assert.equal(sha256(generatorPath), canonicalGeneratorSha256, `${surface} has a stale or modified README generator`);
  assert.equal(sha256(templatePath), canonicalTemplateSha256, `${surface} has a stale or modified README template`);
}

before(() => {
  pluginDist = mkdtempSync(join(tmpdir(), 'ai-catapult-readme-plugin-dist-'));
  for (const script of ['build-claude-plugin.sh', 'build-codex-plugin.sh']) {
    const result = spawnSync('bash', [join(root, 'scripts', script)], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, DIST_ROOT: pluginDist },
    });
    assert.equal(result.status, 0, `${script} failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
});

after(() => {
  rmSync(pluginDist, { recursive: true, force: true });
});

test('skills lock pins the exact canonical README contract head from r3dlex/skills PR #45', () => {
  const lock = JSON.parse(readFileSync(join(root, 'skills.lock.json'), 'utf8'));
  assert.equal(lock.repo, 'https://github.com/r3dlex/skills.git');
  assert.equal(lock.sha, canonicalHead);
});

test('Claude and Codex plugin builds contain byte-identical canonical README contracts', () => {
  for (const plugin of ['claude-plugin', 'codex-plugin']) {
    const skill = join(pluginDist, plugin, 'skills', 'ai-catapult-init');
    assertCanonicalContract(
      join(skill, 'scripts', 'readme-generate.sh'),
      join(skill, 'assets', 'readme', 'template.md'),
      plugin,
    );
  }
});

test('packaged CLI payload contains the byte-identical canonical README contract', () => {
  assertCanonicalContract(
    join(stableDist, 'readme-contract', 'scripts', 'readme-generate.sh'),
    join(stableDist, 'readme-contract', 'assets', 'readme', 'template.md'),
    'CLI payload',
  );
});

test('CLI scaffold preserves the first-success command containing && byte-for-byte', () => {
  const target = mkdtempSync(join(tmpdir(), 'ai-catapult-readme-contract-'));
  try {
    const result = spawnSync(process.execPath, [
      join(root, 'bin', 'ai-catapult.js'),
      'init', target,
      '--repo-id', 'contract-test-repo',
      '--date', '2026-01-01',
    ], { cwd: root, encoding: 'utf8' });

    assert.equal(result.status, 0, `init failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    const readmePath = join(target, 'README.md');
    assert.ok(existsSync(readmePath), 'scaffold must emit README.md through the canonical generator');

    const readme = readFileSync(readmePath, 'utf8');
    assert.match(readme, /^# contract-test-repo$/m);
    assert.match(readme, /^## Quick Start$/m);
    const firstSuccessCommand = 'test -f .ai/matrix.json && test -f .ai/handoff/NEXT-STEPS.md';
    const quickStartBlock = readme.match(/## Quick Start\n\n```sh\n([^`]+)```/);
    assert.ok(quickStartBlock, 'generated README must contain a shell quick-start command block');
    assert.equal(
      quickStartBlock[1],
      `npx ai-catapult install\n${firstSuccessCommand}\n`,
      'quick-start commands must preserve the first-success command and && byte-for-byte',
    );
    assert.match(readme, /\.ai\/matrix\.json` identifies `contract-test-repo`/);
    assert.doesNotMatch(readme, /@@[A-Z_]+@@|\{\{[^}]+\}\}/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

for (const repoId of ['downloads', 'TODO']) {
  test(`CLI scaffold treats guard-like repository id ${repoId} as data`, () => {
    const target = mkdtempSync(join(tmpdir(), 'ai-catapult-readme-repo-id-'));
    try {
      const result = spawnSync(process.execPath, [
        join(root, 'bin', 'ai-catapult.js'),
        'init', target,
        '--repo-id', repoId,
        '--date', '2026-01-01',
      ], { cwd: root, encoding: 'utf8' });

      assert.equal(result.status, 0, `init failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
      const readme = readFileSync(join(target, 'README.md'), 'utf8');
      assert.match(readme, new RegExp(`^# ${repoId}$`, 'm'));
      assert.ok(readme.includes(`identifies \`${repoId}\``));
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
}

test('CLI leaves no partial scaffold when canonical README preflight fails', () => {
  const target = mkdtempSync(join(tmpdir(), 'ai-catapult-readme-failure-target-'));
  const vendorSkills = mkdtempSync(join(tmpdir(), 'ai-catapult-readme-failure-vendor-'));
  try {
    cpSync(join(root, 'vendor', 'skills'), vendorSkills, { recursive: true });
    const generator = join(
      vendorSkills,
      '03-configure-generate',
      'ai-catapult-init',
      'scripts',
      'readme-generate.sh',
    );
    writeFileSync(generator, '#!/bin/bash\necho forced generator failure >&2\nexit 47\n', 'utf8');

    const result = spawnSync(process.execPath, [
      join(root, 'bin', 'ai-catapult.js'),
      'init', target,
      '--repo-id', 'preflight-failure',
      '--date', '2026-01-01',
    ], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, AI_CATAPULT_VENDOR_SKILLS: vendorSkills },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /canonical README generator failed \(exit 47\)/);
    assert.deepEqual(readdirSync(target), [], 'README failure must occur before the first scaffold write');
  } finally {
    rmSync(target, { recursive: true, force: true });
    rmSync(vendorSkills, { recursive: true, force: true });
  }
});

test('CLI refuses an existing README before writing any scaffold files', () => {
  const target = mkdtempSync(join(tmpdir(), 'ai-catapult-readme-collision-'));
  const original = '# Keep me\n';
  try {
    writeFileSync(join(target, 'README.md'), original, 'utf8');
    const result = spawnSync(process.execPath, [
      join(root, 'bin', 'ai-catapult.js'), 'init', target, '--date', '2026-01-01',
    ], { cwd: root, encoding: 'utf8' });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /pass --force to overwrite/);
    assert.equal(readFileSync(join(target, 'README.md'), 'utf8'), original);
    assert.deepEqual(readdirSync(target), ['README.md']);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('CLI --force SHA-checks and backs up an existing README before replacement', () => {
  const target = mkdtempSync(join(tmpdir(), 'ai-catapult-readme-force-'));
  const original = '# Existing project\n\nProject-specific content that must be backed up.\n';
  try {
    writeFileSync(join(target, 'README.md'), original, 'utf8');
    const result = spawnSync(process.execPath, [
      join(root, 'bin', 'ai-catapult.js'),
      'init', target,
      '--repo-id', 'forced-repo',
      '--date', '2026-01-01',
      '--force',
    ], { cwd: root, encoding: 'utf8' });

    assert.equal(result.status, 0, `init failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(readFileSync(join(target, 'README.md'), 'utf8'), /^# forced-repo$/m);

    const backupDir = join(target, '.ai', 'drift', 'readme-backups');
    const files = readdirSync(backupDir);
    const backup = files.find((file) => /^README-.*\.bak$/.test(file));
    const audit = files.find((file) => /^audit-.*\.json$/.test(file));
    assert.ok(backup, 'forced replacement must create a README backup');
    assert.ok(audit, 'forced replacement must create an audit manifest');
    assert.equal(readFileSync(join(backupDir, backup), 'utf8'), original);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});
