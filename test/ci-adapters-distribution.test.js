import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = process.env.AI_CATAPULT_DIST_ROOT || join(root, 'dist-snapshot');
const sha = 'b67740f2bb9ffd509389f664104fce6de49e1a48';
const vendor = join(root, 'vendor/skills');
const canonicalRuntime = join(vendor, 'scripts/render-ci-adapters.py');
const canonicalTemplates = join(vendor, '03-configure-generate/ai-catapult-init/templates/ci');
const defaultProfile = join(vendor, '03-configure-generate/ai-catapult-init/templates/dot-ai/execution/profiles/execution/default.json');
const run = (command, args, options = {}) => spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });

function writeProfile(target, hosts, preference = 'self-hosted') {
  const profile = JSON.parse(readFileSync(defaultProfile, 'utf8'));
  profile.settings.host_selection = hosts;
  profile.settings.runner_preference = preference;
  writeFileSync(target, `${JSON.stringify(profile, null, 2)}\n`);
  return profile;
}

function initializeWorkspace(target) {
  mkdirSync(join(target, '.ai'), { recursive: true });
  writeFileSync(join(target, '.ai/matrix.json'), '{}\n');
}

test('distribution consumes the exact Skills PR #45 merge commit containing Goal 7', () => {
  assert.equal(JSON.parse(readFileSync(join(root, 'skills.lock.json'))).sha, sha);
  assert.equal(readFileSync(join(vendor, 'HEAD_SHA'), 'utf8').trim(), sha);
});

test('CLI and both plugins distribute byte-identical adapter runtime and templates', () => {
  const runtime = readFileSync(canonicalRuntime);
  const payloads = ['', 'claude-plugin', 'codex-plugin'];
  for (const payload of payloads) {
    const base = payload ? join(dist, payload) : dist;
    assert.deepEqual(readFileSync(join(base, 'scripts/render-ci-adapters.py')), runtime, `${payload || 'CLI'} runtime drifted`);
    for (const relative of [
      'github/dpua-validation.yml.template',
      'ado/azure-pipelines.yml.template',
      'gitlab/gitlab-ci.yml.template',
      'gitlab/dpua-child.yml.template',
    ]) {
      assert.deepEqual(
        readFileSync(join(base, '03-configure-generate/ai-catapult-init/templates/ci', relative)),
        readFileSync(join(canonicalTemplates, relative)),
        `${payload || 'CLI'} ${relative} drifted`,
      );
    }
  }
});

test('CLI renderer emits only matrix-selected hosts and rejects Lore', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'catapult-ci-selected-'));
  try {
    const profile = join(fixture, 'ado.json');
    const output = join(fixture, 'workspace');
    writeProfile(profile, ['ado']);
    initializeWorkspace(output);
    let result = run(process.execPath, ['bin/ai-catapult.js', 'ci-adapters', '--profile', profile, '--output', output]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(existsSync(join(output, 'azure-pipelines.yml')));
    assert.ok(!existsSync(join(output, '.github')));
    assert.ok(!existsSync(join(output, '.gitlab-ci.yml')));

    const lore = join(fixture, 'lore.json');
    writeProfile(lore, ['lore']);
    result = run(process.execPath, ['bin/ai-catapult.js', 'ci-adapters', '--profile', lore, '--output', join(fixture, 'lore')]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Lore is reserved/);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('both plugin runtimes render the canonical all-host golden and preserve experimental host status', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'catapult-ci-plugins-'));
  try {
    const profilePath = join(fixture, 'all.json');
    const profile = writeProfile(profilePath, ['github', 'ado', 'gitlab']);
    assert.equal(profile.settings.ado.adapter_status, 'experimental');
    assert.equal(profile.settings.gitlab.adapter_status, 'experimental');
    const golden = join(vendor, 'tests/fixtures/ci-adapters/goldens/github-ado-gitlab');
    for (const plugin of ['claude-plugin', 'codex-plugin']) {
      const output = join(fixture, plugin);
      const runtime = join(dist, plugin, 'scripts/render-ci-adapters.py');
      let result = run('python3', [runtime, '--profile', profilePath, '--output', output]);
      assert.equal(result.status, 0, `${plugin}: ${result.stderr}`);
      result = run('diff', ['-ru', golden, output]);
      assert.equal(result.status, 0, `${plugin} golden drift:\n${result.stdout}\n${result.stderr}`);
      result = run('python3', [runtime, '--profile', profilePath, '--output', output, '--check']);
      assert.equal(result.status, 0, `${plugin} check: ${result.stderr}`);
    }
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('distributed plugin runtime rolls back failure and recovers a crashed projection', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'catapult-ci-recovery-'));
  try {
    const ado = join(fixture, 'ado.json');
    const gitlab = join(fixture, 'gitlab.json');
    writeProfile(ado, ['ado']);
    writeProfile(gitlab, ['gitlab']);
    const output = join(fixture, 'workspace');
    initializeWorkspace(output);
    writeFileSync(join(output, 'KEEP.txt'), 'keep\n');
    const runtime = join(dist, 'codex-plugin/scripts/render-ci-adapters.py');
    let result = run('python3', [runtime, '--profile', gitlab, '--output', output]);
    assert.equal(result.status, 0, result.stderr);
    const before = join(fixture, 'before');
    cpSync(output, before, { recursive: true });

    result = run('python3', [runtime, '--profile', ado, '--output', output, '--fail-after-promote', '2']);
    assert.equal(result.status, 2);
    result = run('diff', ['-ru', before, output]);
    assert.equal(result.status, 0, `rollback drift:\n${result.stdout}`);

    result = run('python3', [runtime, '--profile', ado, '--output', output, '--crash-after-promote', '2']);
    assert.notEqual(result.status, 0);
    result = run('python3', [runtime, '--profile', ado, '--output', output]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(output, 'KEEP.txt'), 'utf8'), 'keep\n');
    assert.ok(existsSync(join(output, 'azure-pipelines.yml')));
    assert.ok(!existsSync(join(output, '.gitlab-ci.yml')));
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('pinned Skills contract proves golden, policy, transaction, and repeated recovery behavior', () => {
  const result = run('bash', [join(vendor, 'tests/ci-adapters-contract_test.sh')]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /selected-host-only files/);
  assert.match(result.stdout, /mid-promotion rollback restores exact files/);
  assert.match(result.stdout, /repeated rollback recovery restores exact files/);
  assert.match(result.stdout, /57 passed; 0 failed/);
});
