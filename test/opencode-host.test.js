/**
 * Goal A1 (opencode-omo-harness-convergence) — OpenCode is a first-class host.
 *
 * The bundled set is derived from vendor/skills/catalog.json. These tests pin
 * the opencode derivation: every non-deprecated skill that declares both
 * claude-code and codex support also ships to opencode, so the assembled
 * OpenCode payload carries the full parity set with SKILL.md present.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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

test('opencode bundled set is the full parity set with claude-code+codex', () => {
  const bundled = resolveBundledSkills(vendorSkills, { host: 'opencode' });
  const names = bundled.map((s) => s.name);

  const expected = catalogNames('claude-code').filter((n) => catalogNames('codex').includes(n));
  assert.deepEqual(names.sort(), expected.sort());
  assert.ok(names.length > 1, `expected the full parity set, got ${names.length} skill(s)`);
});

test('opencode resolution includes ai-catapult-init and valid skill dirs', () => {
  const bundled = resolveBundledSkills(vendorSkills, { host: 'opencode' });
  const names = bundled.map((s) => s.name);

  assert.ok(names.includes('ai-catapult-init'), 'ai-catapult-init must always be bundled');
  for (const skill of bundled) {
    assert.ok(existsSync(join(skill.dir, 'SKILL.md')), `${skill.name} resolved to a dir without SKILL.md`);
  }
});
