/**
 * Goal A7 (opencode-omo-harness-convergence) — end-to-end OpenCode chain.
 *
 * Proves the full pipeline on one path:
 *   vendored catalog (host=opencode) → build-opencode-plugin.sh payload
 *   → `ai-catapult install --harness opencode` → on-disk tree parity,
 * with additive-merge guarantees (foreign content survives) and idempotence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendorSkills = join(root, 'vendor/skills');

function bundledNames(host) {
  const out = spawnSync(
    'node',
    [join(root, 'scripts', 'list-bundled-skills.js'), vendorSkills, host],
    { encoding: 'utf8', cwd: root, timeout: 60000 },
  );
  assert.equal(out.status, 0, `list-bundled-skills failed: ${out.stderr}`);
  return out.stdout.trim().split('\n').filter(Boolean).map((line) => line.split('\t')[0]).sort();
}

function installCli({ xdg, home, distRoot }) {
  return spawnSync(
    process.execPath,
    [join(root, 'bin/ai-catapult.js'), 'install', '--harness', 'opencode'],
    {
      encoding: 'utf8',
      cwd: root,
      timeout: 60000,
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: '/nonexistent-no-codex',
        XDG_CONFIG_HOME: xdg,
        AI_CATAPULT_DIST_ROOT: distRoot,
      },
    },
  );
}

test('opencode e2e: catalog → payload → install tree parity with additive merge', () => {
  const expectedSkills = bundledNames('opencode');
  assert.ok(expectedSkills.length > 1, 'expected the full opencode parity set from the catalog');

  const distRoot = mkdtempSync(join(tmpdir(), 'ai-catapult-e2e-dist-'));
  const home = mkdtempSync(join(tmpdir(), 'ai-catapult-e2e-home-'));
  const xdg = mkdtempSync(join(tmpdir(), 'ai-catapult-e2e-xdg-'));
  try {
    const build = spawnSync('bash', [join(root, 'scripts', 'build-opencode-plugin.sh')], {
      encoding: 'utf8',
      cwd: root,
      timeout: 60000,
      env: { ...process.env, DIST_ROOT: distRoot },
    });
    assert.equal(build.status, 0, `payload build failed: ${build.stderr}`);

    const manifest = JSON.parse(
      readFileSync(join(distRoot, 'opencode-plugin', '.opencode-plugin', 'plugin.json'), 'utf8'),
    );
    assert.deepEqual([...manifest.skills].sort(), expectedSkills, 'payload skills must equal the catalog derivation');
    assert.deepEqual(manifest.commands, ['autobahn', 'northstar']);
    const pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
    assert.equal(manifest.version, pkgVersion, 'payload version must track package.json');

    // Foreign marker proves additive semantics through the whole chain.
    const ocDir = join(xdg, 'opencode');
    mkdirSync(join(ocDir, 'skills', 'foreign'), { recursive: true });
    writeFileSync(join(ocDir, 'skills', 'foreign', 'SKILL.md'), '# foreign\n');

    const first = installCli({ xdg, home, distRoot });
    assert.equal(first.status, 0, `install failed: ${first.stderr}`);

    const installedSkills = readdirSync(join(ocDir, 'skills')).sort();
    assert.deepEqual(installedSkills, [...expectedSkills, 'foreign'].sort());
    for (const name of expectedSkills) {
      assert.ok(existsSync(join(ocDir, 'skills', name, 'SKILL.md')), `${name}/SKILL.md missing`);
    }
    assert.deepEqual(readdirSync(join(ocDir, 'command')).sort(), ['autobahn.md', 'northstar.md']);
    assert.equal(readFileSync(join(ocDir, 'skills', 'foreign', 'SKILL.md'), 'utf8'), '# foreign\n');

    // Idempotent re-install: identical final state, foreign still intact.
    const second = installCli({ xdg, home, distRoot });
    assert.equal(second.status, 0, `re-install failed: ${second.stderr}`);
    assert.deepEqual(readdirSync(join(ocDir, 'skills')).sort(), [...expectedSkills, 'foreign'].sort());
    assert.deepEqual(readdirSync(join(ocDir, 'command')).sort(), ['autobahn.md', 'northstar.md']);
    assert.ok(!existsSync(join(ocDir, 'opencode.jsonc')), 'installer must never create opencode.jsonc');
  } finally {
    rmSync(distRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(xdg, { recursive: true, force: true });
  }
});
