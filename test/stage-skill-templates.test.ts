import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageFrom } from '../scripts/stage-skill-templates.ts';
import { resolveVendorSkill } from '../src/skill-resolver.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const canonicalSkill = resolveVendorSkill(join(root, 'vendor/skills'));
// The canonical validator is anchored at the vendored skills ROOT — not derived
// from the canonical skill dir — because the catalog may place the skill at any
// depth (that exact assumption was the staging defect this suite pins).
const canonicalValidator = join(root, 'vendor/skills/scripts/validate-rules.sh');

function skillsFixture(sourcePath: string) {
  const vendorSkills = mkdtempSync(join(tmpdir(), 'ai-catapult-skills-'));
  const skillDir = join(vendorSkills, sourcePath);
  mkdirSync(dirname(skillDir), { recursive: true });
  cpSync(canonicalSkill, skillDir, { recursive: true });
  mkdirSync(join(vendorSkills, 'scripts'), { recursive: true });
  cpSync(canonicalValidator, join(vendorSkills, 'scripts', 'validate-rules.sh'));
  writeFileSync(join(vendorSkills, 'catalog.json'), JSON.stringify({
    schema_version: '1.0',
    skills: [{ name: 'ai-catapult-init', source_path: sourcePath }],
  }), 'utf8');
  return vendorSkills;
}

function cleanup(path: string) {
  rmSync(path, { recursive: true, force: true });
}

// The staging resolver must anchor the validator at the skills root for every
// catalog depth that resolveVendorSkill honors; deriving it from the resolved
// skill path only worked for two-component source_paths.
for (const sourcePath of ['ai-catapult-init', 'phase/ai-catapult-init', 'one/two/ai-catapult-init']) {
  void test(`staging ships templates + validator for the ${sourcePath.split('/').length}-component catalog path ${sourcePath}`, () => {
    const vendorSkills = skillsFixture(sourcePath);
    const dest = mkdtempSync(join(tmpdir(), 'ai-catapult-stage-'));
    try {
      stageFrom(vendorSkills, dest);
      // cpSync copies the CONTENT of <skill>/templates into dest (the staged
      // tree mirrors the emitted scaffold layout: manifest and template dirs at
      // the top level).
      assert.ok(existsSync(join(dest, 'boundary-manifest.json')), 'templates not staged');
      assert.ok(existsSync(join(dest, 'graph-automation/graph-refresh.sh')), 'required template not staged');
      const stagedValidator = join(dest, 'scripts/validate-rules.sh');
      assert.ok(existsSync(stagedValidator), `validator not staged at catalog path ${sourcePath}`);
      assert.equal(readFileSync(stagedValidator, 'utf8'), readFileSync(canonicalValidator, 'utf8'), 'staged validator is not byte-identical to the vendored source');
    } finally {
      cleanup(vendorSkills);
      cleanup(dest);
    }
  });
}

void test('staging refuses a skills root without the vendored validator and leaves the destination untouched', () => {
  const vendorSkills = skillsFixture('phase/ai-catapult-init');
  rmSync(join(vendorSkills, 'scripts'), { recursive: true, force: true });
  const dest = mkdtempSync(join(tmpdir(), 'ai-catapult-stage-'));
  writeFileSync(join(dest, 'sentinel'), 'keep\n', 'utf8');
  try {
    assert.throws(() => stageFrom(vendorSkills, dest), /vendored validator script not found/);
    assert.deepEqual(readdirSync(dest), ['sentinel'], 'refusal must not mutate the destination');
  } finally {
    cleanup(vendorSkills);
    cleanup(dest);
  }
});

void test('staging refuses a validator that is a directory, not a regular file', () => {
  const vendorSkills = skillsFixture('phase/ai-catapult-init');
  rmSync(join(vendorSkills, 'scripts/validate-rules.sh'), { force: true });
  mkdirSync(join(vendorSkills, 'scripts/validate-rules.sh'));
  const dest = mkdtempSync(join(tmpdir(), 'ai-catapult-stage-'));
  try {
    assert.throws(() => stageFrom(vendorSkills, dest), /vendored validator is not a regular file/);
    assert.deepEqual(readdirSync(dest), [], 'refusal must not mutate the destination');
  } finally {
    cleanup(vendorSkills);
    cleanup(dest);
  }
});