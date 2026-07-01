/**
 * TDD tests for Slice 5 — Claude Code plugin build-time assembly.
 *
 * Tests:
 *  1. Build script exists and has no syntax errors.
 *  2. Build produces dist/claude-plugin/.claude-plugin/plugin.json.
 *  3. plugin.json has name "ai-catapult" and version matching package.json.
 *  4. plugin.json has required fields: description, author, skills array.
 *  5. Bundled skill SKILL.md exists inside dist.
 *  6. Bundled skill has modules/ directory.
 *  7. marketplace.json has $schema, plugins array referencing ai-catapult.
 *  8. Idempotence: second build produces byte-identical output (diff -r exits 0).
 *  9. No-committed-mirrors (decision 7): git ls-files tracks nothing under dist/.
 * 10. No-committed-mirrors: vendor/ is untracked (gitignored), not committed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const buildScript = join(root, 'scripts/build-claude-plugin.sh');
const distPlugin = join(root, 'dist/claude-plugin');
const pluginManifest = join(distPlugin, '.claude-plugin/plugin.json');
const marketplaceManifest = join(distPlugin, '.claude-plugin/marketplace.json');
const bundledSkillDir = join(distPlugin, 'skills/ai-catapult-init');
const bundledSkillMd = join(bundledSkillDir, 'SKILL.md');
const badNestedSkillDir = join(distPlugin, '.claude-plugin/skills');

function runBuild() {
  return spawnSync('bash', [buildScript], {
    encoding: 'utf8',
    cwd: root,
  });
}

test('build script exists and has no bash syntax errors', () => {
  assert.ok(existsSync(buildScript), `build script not found at ${buildScript}`);
  const result = spawnSync('bash', ['-n', buildScript], { encoding: 'utf8' });
  assert.equal(result.status, 0, `build script has syntax errors:\n${result.stderr}`);
});

test('build produces dist/claude-plugin/.claude-plugin/plugin.json', () => {
  const result = runBuild();
  assert.equal(
    result.status, 0,
    `build script failed (exit ${result.status}):\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  assert.ok(existsSync(pluginManifest), `plugin.json not found at ${pluginManifest}`);
});

test('plugin.json has name "ai-catapult" and version matching package.json', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const plugin = JSON.parse(readFileSync(pluginManifest, 'utf8'));

  assert.equal(plugin.name, 'ai-catapult', `plugin.json name should be "ai-catapult", got "${plugin.name}"`);
  assert.equal(plugin.version, pkg.version, `plugin.json version should be "${pkg.version}", got "${plugin.version}"`);
});

test('plugin.json has required fields: description, author, skills array', () => {
  const plugin = JSON.parse(readFileSync(pluginManifest, 'utf8'));

  assert.ok(typeof plugin.description === 'string' && plugin.description.length > 0, 'plugin.json must have description');
  assert.ok(plugin.author && typeof plugin.author === 'object', 'plugin.json must have author object');
  assert.ok(Array.isArray(plugin.skills) && plugin.skills.length > 0, 'plugin.json must have non-empty skills array');
});

test('bundled skill SKILL.md exists inside dist/claude-plugin', () => {
  assert.ok(existsSync(bundledSkillMd), `bundled SKILL.md not found at ${bundledSkillMd}`);
});

test('bundled skill has modules/ directory inside dist/claude-plugin', () => {
  const modulesDir = join(bundledSkillDir, 'modules');
  assert.ok(existsSync(modulesDir), `bundled skill modules/ not found at ${modulesDir}`);
});

test('skills/ must NOT be nested inside .claude-plugin/ (regression guard)', () => {
  assert.ok(
    !existsSync(badNestedSkillDir),
    `.claude-plugin/skills/ must not exist — skills belong at the plugin root, not nested inside .claude-plugin/. Found: ${badNestedSkillDir}`,
  );
});

test('marketplace.json exists with $schema, plugins array referencing ai-catapult', () => {
  assert.ok(existsSync(marketplaceManifest), `marketplace.json not found at ${marketplaceManifest}`);

  const mp = JSON.parse(readFileSync(marketplaceManifest, 'utf8'));
  assert.ok(typeof mp.$schema === 'string' && mp.$schema.length > 0, 'marketplace.json must have $schema');
  assert.ok(Array.isArray(mp.plugins) && mp.plugins.length > 0, 'marketplace.json must have non-empty plugins array');

  const entry = mp.plugins.find(p => p.name === 'ai-catapult');
  assert.ok(entry, 'marketplace.json plugins array must contain entry with name "ai-catapult"');
});

test('build is idempotent: diff -r between two consecutive builds exits 0', () => {
  // Snapshot the current dist after the first build (already ran above)
  const snapshot = mkdtempSync(join(tmpdir(), 'catapult-plugin-snap-'));
  try {
    cpSync(distPlugin, snapshot, { recursive: true });

    // Rebuild
    const result = runBuild();
    assert.equal(result.status, 0, `rebuild failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);

    // diff -r exits 0 only when directories are byte-identical
    const diff = spawnSync('diff', ['-r', snapshot, distPlugin], { encoding: 'utf8' });
    assert.equal(
      diff.status, 0,
      `build is not idempotent — diff found changes:\n${diff.stdout}`,
    );
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
});

test('no-committed-mirrors (decision 7): git ls-files tracks nothing under dist/', () => {
  const lsFiles = spawnSync('git', ['ls-files', '--', 'dist/'], {
    encoding: 'utf8',
    cwd: root,
  });
  assert.equal(lsFiles.status, 0, `git ls-files failed: ${lsFiles.stderr}`);

  const tracked = lsFiles.stdout.trim();
  assert.equal(
    tracked, '',
    `Assembled plugin payload must not be committed. Found tracked files:\n${tracked}`,
  );
});

test('no-committed-mirrors: vendor/ is untracked (gitignored), not committed', () => {
  const lsVendor = spawnSync('git', ['ls-files', '--', 'vendor/'], {
    encoding: 'utf8',
    cwd: root,
  });
  assert.equal(lsVendor.status, 0, `git ls-files failed: ${lsVendor.stderr}`);

  const tracked = lsVendor.stdout.trim();
  assert.equal(
    tracked, '',
    `vendor/ must not be committed (it is gitignored source). Found tracked:\n${tracked}`,
  );
});
