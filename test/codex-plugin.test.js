/**
 * TDD tests for Slice 6 — Codex plugin build-time assembly.
 *
 * RED phase: all tests below will fail until scripts/build-codex-plugin.sh
 * and dist/codex-plugin/ are implemented.
 *
 * Covers:
 *   - plugin.json exists post-build with correct fields
 *   - name matches package.json name, version matches package.json version
 *   - skills dir + bundled ai-catapult-init/SKILL.md present
 *   - rebuild is idempotent (byte-identical)
 *   - no dist/ or .codex-plugin/ payload tracked by git
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const buildScript = join(root, 'scripts/build-codex-plugin.sh');
const distPlugin = join(root, 'dist/codex-plugin');
const pluginJson = join(distPlugin, '.codex-plugin/plugin.json');
const skillsDir = join(distPlugin, 'skills');

function runBuild(env = {}) {
  return spawnSync('bash', [buildScript], {
    encoding: 'utf8',
    cwd: root,
    env: { ...process.env, ...env },
  });
}

// ---------------------------------------------------------------------------
// Negative test: no dist/ or .codex-plugin/ payload tracked by git
// ---------------------------------------------------------------------------

test('git ls-files has nothing under dist/ (no committed plugin payload)', () => {
  const result = spawnSync('git', ['ls-files', 'dist/'], {
    encoding: 'utf8',
    cwd: root,
  });
  assert.equal(result.status, 0, `git ls-files failed: ${result.stderr}`);
  // dist/ must be entirely untracked — no committed files
  const tracked = result.stdout.trim();
  assert.equal(tracked, '', `Unexpected files tracked under dist/:\n${tracked}`);
});

test('git ls-files has no .codex-plugin/ payload at repo root', () => {
  const result = spawnSync('git', ['ls-files', '.codex-plugin/'], {
    encoding: 'utf8',
    cwd: root,
  });
  assert.equal(result.status, 0, `git ls-files failed: ${result.stderr}`);
  const tracked = result.stdout.trim();
  assert.equal(tracked, '', `Unexpected .codex-plugin/ files tracked at repo root:\n${tracked}`);
});

// Vendored source (gitignored vendor/) is allowed — verify it is NOT tracked either
test('git ls-files has no vendor/ files tracked (vendor is gitignored source, not payload)', () => {
  const result = spawnSync('git', ['ls-files', 'vendor/'], {
    encoding: 'utf8',
    cwd: root,
  });
  assert.equal(result.status, 0, `git ls-files failed: ${result.stderr}`);
  const tracked = result.stdout.trim();
  assert.equal(tracked, '', `Unexpected vendor/ files tracked (should be gitignored):\n${tracked}`);
});

// ---------------------------------------------------------------------------
// Assembly tests (require build script to exist and succeed)
// ---------------------------------------------------------------------------

test('build-codex-plugin.sh exists and is executable', () => {
  assert.ok(existsSync(buildScript), `build script not found at ${buildScript}`);
  // Check execute bit
  const stat = spawnSync('bash', ['-c', `test -x "${buildScript}"`], { encoding: 'utf8' });
  assert.equal(stat.status, 0, 'build script is not executable');
});

test('build-codex-plugin.sh succeeds and exits 0', () => {
  const result = runBuild();
  assert.equal(
    result.status, 0,
    `build script exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
});

test('dist/codex-plugin/.codex-plugin/plugin.json exists after build', () => {
  runBuild();
  assert.ok(existsSync(pluginJson), `plugin.json not found at ${pluginJson}`);
});

test('plugin.json parses as valid JSON', () => {
  runBuild();
  const raw = readFileSync(pluginJson, 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw), 'plugin.json is not valid JSON');
});

test('plugin.json name is "ai-catapult"', () => {
  runBuild();
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const plugin = JSON.parse(readFileSync(pluginJson, 'utf8'));
  assert.equal(plugin.name, 'ai-catapult', `plugin.json name mismatch: got ${plugin.name}`);
  // name must also match package.json name
  assert.equal(plugin.name, pkg.name, `plugin.json name must match package.json name`);
});

test('plugin.json version matches package.json version', () => {
  runBuild();
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const plugin = JSON.parse(readFileSync(pluginJson, 'utf8'));
  assert.equal(
    plugin.version, pkg.version,
    `plugin.json version ${plugin.version} !== package.json version ${pkg.version}`,
  );
});

test('plugin.json has skills field pointing at "./skills/"', () => {
  runBuild();
  const plugin = JSON.parse(readFileSync(pluginJson, 'utf8'));
  assert.ok('skills' in plugin, 'plugin.json missing skills field');
  assert.equal(plugin.skills, './skills/', `plugin.json skills must be "./skills/", got: ${plugin.skills}`);
});

test('plugin.json has description field', () => {
  runBuild();
  const plugin = JSON.parse(readFileSync(pluginJson, 'utf8'));
  assert.ok(typeof plugin.description === 'string' && plugin.description.length > 0,
    'plugin.json missing or empty description');
});

test('plugin.json has interface block with displayName', () => {
  runBuild();
  const plugin = JSON.parse(readFileSync(pluginJson, 'utf8'));
  assert.ok(plugin.interface && typeof plugin.interface === 'object', 'plugin.json missing interface block');
  assert.ok(typeof plugin.interface.displayName === 'string' && plugin.interface.displayName.length > 0,
    'plugin.json interface.displayName missing or empty');
});

test('dist/codex-plugin/skills/ai-catapult-init/ directory exists', () => {
  runBuild();
  const skillDir = join(skillsDir, 'ai-catapult-init');
  assert.ok(existsSync(skillDir), `bundled skill dir not found at ${skillDir}`);
});

test('dist/codex-plugin/skills/ai-catapult-init/SKILL.md exists', () => {
  runBuild();
  const skillMd = join(skillsDir, 'ai-catapult-init', 'SKILL.md');
  assert.ok(existsSync(skillMd), `bundled SKILL.md not found at ${skillMd}`);
});

test('build is idempotent: rebuilding produces byte-identical plugin.json', () => {
  // First build
  runBuild();
  const first = readFileSync(pluginJson, 'utf8');

  // Second build
  runBuild();
  const second = readFileSync(pluginJson, 'utf8');

  assert.equal(second, first, 'plugin.json differs between first and second build (not idempotent)');
});

test('build fails closed when vendor/skills is absent', () => {
  // Point to a nonexistent vendor root via env override
  const result = spawnSync('bash', [buildScript], {
    encoding: 'utf8',
    cwd: root,
    env: {
      ...process.env,
      VENDOR_ROOT: join(root, '.tmp-no-vendor-' + Date.now()),
    },
  });
  assert.notEqual(result.status, 0, 'build should fail when vendor/skills is absent');
});
