/**
 * Port slice 6 — the plugin ships the whole vendored catalog, not one skill.
 *
 * The bundled set is derived from vendor/skills/catalog.json rather than
 * declared here, so adding a skill upstream reaches plugin users on the next
 * lock bump with no edit to this repo. These tests pin that derivation and
 * assert the assembled Claude and Codex plugins actually contain every skill
 * the derivation selects.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBundledSkills } from '../src/skill-resolver.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendorSkills = join(root, 'vendor/skills');

function catalogNames(host) {
  const catalog = JSON.parse(readFileSync(join(vendorSkills, 'catalog.json'), 'utf8'));
  return catalog.skills
    .filter((s) => s.lifecycle !== 'deprecated')
    .filter((s) => !Array.isArray(s.supported_hosts) || s.supported_hosts.includes(host))
    .map((s) => s.name)
    .sort();
}

function cleanup(path) {
  rmSync(path, { recursive: true, force: true });
}

/** A vendored-skills fixture whose catalog is rewritten to `skills`. */
function fixture(skills) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-catapult-bundle-'));
  cpSync(vendorSkills, dir, { recursive: true });
  const catalog = JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8'));
  const byName = new Map(catalog.skills.map((s) => [s.name, s]));
  catalog.skills = skills.map((s) => ({ ...byName.get(s.name), ...s }));
  writeFileSync(join(dir, 'catalog.json'), JSON.stringify(catalog), 'utf8');
  return dir;
}

test('bundled set is the whole vendored catalog, not just ai-catapult-init', () => {
  const bundled = resolveBundledSkills(vendorSkills, { host: 'claude-code' });
  const names = bundled.map((s) => s.name);

  assert.deepEqual(names, catalogNames('claude-code'));
  assert.ok(names.length > 1, `expected the full catalog, got ${names.length} skill(s)`);
  assert.ok(names.includes('ai-catapult-init'), 'ai-catapult-init must always be bundled');
  for (const skill of bundled) {
    assert.ok(existsSync(join(skill.dir, 'SKILL.md')), `${skill.name} resolved to a dir without SKILL.md`);
  }
});

test('deprecated skills and skills not supporting the host are excluded', () => {
  const dir = fixture([
    { name: 'ai-catapult-init' },
    { name: 'autobahn', lifecycle: 'deprecated' },
    { name: 'northstar', supported_hosts: ['codex'] },
    { name: 'triage' },
  ]);
  try {
    const names = resolveBundledSkills(dir, { host: 'claude-code' }).map((s) => s.name);
    assert.deepEqual(names, ['ai-catapult-init', 'triage']);
    assert.deepEqual(
      resolveBundledSkills(dir, { host: 'codex' }).map((s) => s.name),
      ['ai-catapult-init', 'northstar', 'triage'],
    );
  } finally { cleanup(dir); }
});

test('a catalog without ai-catapult-init fails closed', () => {
  const dir = fixture([{ name: 'triage' }]);
  try {
    assert.throws(() => resolveBundledSkills(dir, { host: 'claude-code' }), /ai-catapult-init/);
  } finally { cleanup(dir); }
});

test('assembled plugins contain every bundled skill', () => {
  const distRoot = mkdtempSync(join(tmpdir(), 'ai-catapult-bundle-dist-'));
  try {
    for (const script of ['build-claude-plugin.sh', 'build-codex-plugin.sh']) {
      const result = spawnSync('bash', [join(root, 'scripts', script)], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, DIST_ROOT: distRoot },
      });
      assert.equal(result.status, 0, `${script} failed:\n${result.stderr}`);
    }

    const claude = resolveBundledSkills(vendorSkills, { host: 'claude-code' }).map((s) => s.name);
    const codex = resolveBundledSkills(vendorSkills, { host: 'codex' }).map((s) => s.name);

    for (const name of claude) {
      assert.ok(
        existsSync(join(distRoot, 'claude-plugin/skills', name, 'SKILL.md')),
        `claude plugin is missing bundled skill ${name}`,
      );
    }
    for (const name of codex) {
      assert.ok(
        existsSync(join(distRoot, 'codex-plugin/skills', name, 'SKILL.md')),
        `codex plugin is missing bundled skill ${name}`,
      );
    }

    // plugin.json is the list Claude Code actually reads — a skill on disk that
    // the manifest omits is invisible to users.
    const manifest = JSON.parse(readFileSync(join(distRoot, 'claude-plugin/.claude-plugin/plugin.json'), 'utf8'));
    assert.deepEqual(manifest.skills, claude.map((name) => `./skills/${name}/`));
  } finally { cleanup(distRoot); }
});
