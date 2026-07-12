import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = process.env.AI_CATAPULT_DIST_ROOT || join(root, 'dist-snapshot');
const sha = 'a6d9b1315e50c1465987b36afd37240b66413aa4';
const run = (command, args, options = {}) => spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });

test('distribution is pinned to exact merged Skills Goal 1 SHA', () => {
  assert.equal(JSON.parse(readFileSync(join(root, 'skills.lock.json'))).sha, sha);
  assert.equal(readFileSync(join(root, 'vendor/skills/HEAD_SHA'), 'utf8').trim(), sha);
});

test('schemas are present in the catalog-resolved templates', () => {
  for (const name of ['matrix-v1.1.schema.json', 'execution-profile.schema.json', 'child-binding.schema.json']) {
    assert.ok(existsSync(join(root, 'vendor/skills/03-configure-generate/ai-catapult-init/templates/dot-ai/execution', name)));
  }
});

test('CLI and both plugins distribute byte-identical canonical runtime', () => {
  const canonical = readFileSync(join(root, 'vendor/skills/scripts/matrix-contract.py'));
  for (const path of ['matrix-runtime.py', 'claude-plugin/scripts/matrix-contract.py', 'codex-plugin/scripts/matrix-contract.py']) {
    assert.deepEqual(readFileSync(join(dist, path)), canonical, `${path} drifted from pinned Skills runtime`);
  }
});

test('scaffold honors manifest schema destinations instead of template source paths', () => {
  const target = mkdtempSync(join(tmpdir(), 'catapult-schema-path-'));
  try {
    const result = run(process.execPath, ['bin/ai-catapult.js', 'init', target, '--repo-id', 'schema-path', '--date', '2026-01-01']);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(target, '.ai/execution/schemas/matrix-v1.1.schema.json')));
    assert.ok(!existsSync(join(target, '.ai/execution/matrix-v1.1.schema.json')), 'template source path leaked into scaffold destination');
  } finally { rmSync(target, { recursive: true, force: true }); }
});

test('documented plugin scripts execute validate and child-safe project commands', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'catapult-plugin-matrix-'));
  try {
    for (const kind of ['checkout', 'execution', 'toolchain', 'cas']) mkdirSync(join(fixture, 'profiles', kind), { recursive: true });
    const profiles = {
      checkout: { history: 'full', disposable: false },
      execution: { runner_preference: 'self-hosted', host_selection: ['github'], hosted_fallback: true },
      toolchain: { tier: 'managed' }, cas: { mode: 'pull-only' },
    };
    for (const [kind, settings] of Object.entries(profiles)) writeFileSync(join(fixture, 'profiles', kind, 'default.json'), JSON.stringify({ schema_version: '1.0', profile_type: kind, profile_id: 'default', version: '1.0', settings }));
    const refs = Object.fromEntries(Object.keys(profiles).map((kind) => [kind, { type: kind, id: 'default', version: '1.0' }]));
    const matrix = { schema_version: '1.1', repository_id: 'parent', topology_type: 'umbrella', max_allowed_depth: 3, current_depth: 1, sync_strategy: 'physical-copy', upstream_authority: { type: 'git', url: 'https://github.com/acme/root.git', ref: 'main' }, managed_repositories: [{ repo_id: 'child', path: 'child', depth: 1, inherits_assets_from: '.', canonical_origin: 'https://github.com/acme/child.git', canonical_upstream: null, default_ref: 'main', disposable: false, moon_project_id: 'child', dependencies: [], profile_refs: refs }], inherited_assets: [], sync_status: {} };
    writeFileSync(join(fixture, 'matrix.json'), JSON.stringify(matrix));mkdirSync(join(fixture, 'overrides'));
    for (const plugin of ['claude-plugin', 'codex-plugin']) {
      const script = join(dist, plugin, 'scripts/matrix-contract.py');
      let result = run(script, ['validate', '--matrix', join(fixture, 'matrix.json'), '--profiles', join(fixture, 'profiles')]);
      assert.equal(result.status, 0, `${plugin} validate failed: ${result.stderr}`);
      result = run(script, ['project', '--matrix', join(fixture, 'matrix.json'), '--profiles', join(fixture, 'profiles'), '--overrides', join(fixture, 'overrides'), '--output', join(fixture, `${plugin}-out`)]);
      assert.equal(result.status, 0, `${plugin} project failed: ${result.stderr}`);
      const projection = readFileSync(join(fixture, `${plugin}-out/child.json`), 'utf8');
      assert.ok(!projection.includes('hosted_fallback'));
    }
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('CLI preserves v1.0 reader behavior', () => {
  const result = run(process.execPath, ['bin/ai-catapult.js', 'matrix', 'validate', '--matrix', '.ai/matrix.json', '--profiles', '.ai/execution/profiles']);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('pinned runtime proves v1.1 projection safety, skew, transaction, concurrency, and crash recovery', () => {
  const result = run('bash', ['vendor/skills/tests/matrix-v11-contract_test.sh']);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /sanitized child projection contract/);
  assert.match(result.stdout, /profile body version skew rejects/);
  assert.match(result.stdout, /post-intent crash recovered/);
  assert.match(result.stdout, /stale ABA contender cannot move new live lock/);
  assert.match(result.stdout, /48 passed; 0 failed/);
});
