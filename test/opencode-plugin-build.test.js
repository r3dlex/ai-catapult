/**
 * Goal A2 (opencode-omo-harness-convergence) — OpenCode payload builder.
 *
 * Pins scripts/build-opencode-plugin.sh:
 *   - deterministic wipe-and-rebuild of dist/opencode-plugin/ (idempotent)
 *   - skills/<name>/SKILL.md for every vendored skill supporting opencode
 *   - command/<name>.md rendered from the shared command schema definitions
 *   - .opencode-plugin/plugin.json manifest marker (install.js ensureBuilt seam)
 *   - fail-closed when vendor/skills is absent
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendorSkills = join(root, 'vendor/skills');

function runBuild(env = {}) {
  return spawnSync('bash', [join(root, 'scripts', 'build-opencode-plugin.sh')], {
    encoding: 'utf8',
    cwd: root,
    env: { ...process.env, ...env },
    timeout: 60000,
  });
}

function listFilesRecursive(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

test('build-opencode-plugin assembles skills, commands, and manifest deterministically', () => {
  const distRoot = mkdtempSync(join(tmpdir(), 'ai-catapult-oc-dist-'));
  try {
    const first = runBuild({ DIST_ROOT: distRoot });
    assert.equal(first.status, 0, `build failed: ${first.stderr}`);

    const distDir = join(distRoot, 'opencode-plugin');
    const manifestPath = join(distDir, '.opencode-plugin', 'plugin.json');
    assert.ok(existsSync(manifestPath), '.opencode-plugin/plugin.json manifest missing');

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.name, 'ai-catapult');
    assert.ok(manifest.version, 'manifest.version missing');
    assert.ok(Array.isArray(manifest.skills) && manifest.skills.length > 1, 'manifest.skills must list the bundled set');
    assert.ok(Array.isArray(manifest.commands) && manifest.commands.length >= 2, 'manifest.commands must list northstar+autobahn');

    for (const name of manifest.skills) {
      assert.ok(existsSync(join(distDir, 'skills', name, 'SKILL.md')), `skills/${name}/SKILL.md missing`);
    }
    for (const name of manifest.commands) {
      const cmdFile = join(distDir, 'command', `${name}.md`);
      assert.ok(existsSync(cmdFile), `command/${name}.md missing`);
      const text = readFileSync(cmdFile, 'utf8');
      assert.match(text, /^---\n/, `${name}.md must open with YAML frontmatter`);
      assert.match(text, /description:/, `${name}.md frontmatter must carry a description`);
      assert.match(text, /\$ARGUMENTS/, `${name}.md body must interpolate $ARGUMENTS`);
    }

    // Idempotence: second run yields byte-identical tree.
    const snapshotFirst = listFilesRecursive(distDir).map((p) => [p, readFileSync(p, 'utf8')]);
    const second = runBuild({ DIST_ROOT: distRoot });
    assert.equal(second.status, 0, `rebuild failed: ${second.stderr}`);
    const snapshotSecond = listFilesRecursive(distDir).map((p) => [p, readFileSync(p, 'utf8')]);
    assert.deepEqual(snapshotSecond, snapshotFirst, 'rebuild was not byte-identical');
  } finally {
    rmSync(distRoot, { recursive: true, force: true });
  }
});

test('build-opencode-plugin fails closed without vendor/skills', () => {
  const emptyVendor = mkdtempSync(join(tmpdir(), 'ai-catapult-oc-vendor-'));
  const distRoot = mkdtempSync(join(tmpdir(), 'ai-catapult-oc-dist2-'));
  try {
    const result = runBuild({ VENDOR_ROOT: emptyVendor, DIST_ROOT: distRoot });
    assert.notEqual(result.status, 0, 'missing vendor must abort the build');
    assert.match(result.stderr ?? '', /vendor/i);
    assert.ok(!existsSync(join(distRoot, 'opencode-plugin')), 'no payload may be produced on failure');
  } finally {
    rmSync(emptyVendor, { recursive: true, force: true });
    rmSync(distRoot, { recursive: true, force: true });
  }
});
