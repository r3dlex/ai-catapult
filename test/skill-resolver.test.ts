import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVendorSkill } from '../src/skill-resolver.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const canonicalSkill = resolveVendorSkill(join(root, 'vendor/skills'));

function fixture({ catalog = true, sourcePath = '03-configure-generate/ai-catapult-init' }: { catalog?: boolean; sourcePath?: string } = {}) {
  const vendorSkills = mkdtempSync(join(tmpdir(), 'ai-catapult-skills-'));
  const skillDir = join(vendorSkills, sourcePath);
  mkdirSync(dirname(skillDir), { recursive: true });
  cpSync(canonicalSkill, skillDir, { recursive: true });
  // Model the real skills root: the vendored Archgate validator lives at the
  // root (scripts/validate-rules.sh) and init refuses to scaffold without it.
  mkdirSync(join(vendorSkills, 'scripts'), { recursive: true });
  cpSync(join(canonicalSkill, '..', '..', 'scripts', 'validate-rules.sh'), join(vendorSkills, 'scripts', 'validate-rules.sh'));
  if (catalog) {
    writeFileSync(join(vendorSkills, 'catalog.json'), JSON.stringify({
      schema_version: '1.0',
      skills: [{ name: 'ai-catapult-init', source_path: sourcePath }],
    }), 'utf8');
  }
  return vendorSkills;
}

function cleanup(path: string) {
  rmSync(path, { recursive: true, force: true });
}

void test('resolver uses the future workflow-stage source_path', () => {
  const vendorSkills = fixture();
  try {
    assert.equal(resolveVendorSkill(vendorSkills), realpathSync(join(vendorSkills, '03-configure-generate/ai-catapult-init')));
  } finally { cleanup(vendorSkills); }
});

void test('resolver fails actionably when catalog.json is absent, even if the legacy path exists', () => {
  const vendorSkills = fixture({ catalog: false, sourcePath: 'ai-catapult-init' });
  try {
    assert.throws(
      () => resolveVendorSkill(vendorSkills),
      /catalog\.json is missing.*refresh the vendored skills checkout from skills\.lock\.json/,
    );
  } finally { cleanup(vendorSkills); }
});

void test('present malformed catalog fails closed instead of using a valid legacy path', () => {
  const vendorSkills = fixture({ catalog: false, sourcePath: 'ai-catapult-init' });
  try {
    writeFileSync(join(vendorSkills, 'catalog.json'), '{bad json', 'utf8');
    assert.throws(() => resolveVendorSkill(vendorSkills), /catalog\.json is malformed/);
  } finally { cleanup(vendorSkills); }
});

void test('catalog rejects duplicate canonical entries', () => {
  const vendorSkills = fixture();
  try {
    const catalogPath = join(vendorSkills, 'catalog.json');
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as { skills: Array<{ name: string; source_path: string }> };
    const first = catalog.skills[0];
    assert.ok(first, 'fixture catalog must have at least one entry');
    catalog.skills.push({ ...first });
    writeFileSync(catalogPath, JSON.stringify(catalog), 'utf8');
    assert.throws(() => resolveVendorSkill(vendorSkills), /exactly one canonical/);
  } finally { cleanup(vendorSkills); }
});

for (const sourcePath of ['/tmp/ai-catapult-init', '../ai-catapult-init', 'phase/../../ai-catapult-init']) {
  void test(`catalog rejects unsafe source_path: ${sourcePath}`, () => {
    const vendorSkills = fixture();
    try {
      writeFileSync(join(vendorSkills, 'catalog.json'), JSON.stringify({
        skills: [{ name: 'ai-catapult-init', source_path: sourcePath }],
      }), 'utf8');
      assert.throws(() => resolveVendorSkill(vendorSkills), /repository-relative|traversal/);
    } finally { cleanup(vendorSkills); }
  });
}

void test('resolver rejects SKILL.md frontmatter-name mismatch', () => {
  const vendorSkills = fixture();
  try {
    const skillMd = join(vendorSkills, '03-configure-generate/ai-catapult-init/SKILL.md');
    writeFileSync(skillMd, readFileSync(skillMd, 'utf8').replace(/^name:\s*ai-catapult-init$/m, 'name: wrong-name'), 'utf8');
    assert.throws(() => resolveVendorSkill(vendorSkills), /frontmatter name does not match/);
  } finally { cleanup(vendorSkills); }
});

void test('resolver rejects a missing SKILL.md', () => {
  const vendorSkills = fixture();
  try {
    unlinkSync(join(vendorSkills, '03-configure-generate/ai-catapult-init/SKILL.md'));
    assert.throws(() => resolveVendorSkill(vendorSkills), /SKILL\.md is missing/);
  } finally { cleanup(vendorSkills); }
});

void test('resolver rejects a missing required template', () => {
  const vendorSkills = fixture();
  try {
    unlinkSync(join(vendorSkills, '03-configure-generate/ai-catapult-init/templates/dot-ai/matrix.json'));
    assert.throws(() => resolveVendorSkill(vendorSkills), /required template is missing/);
  } finally { cleanup(vendorSkills); }
});

void test('future-path fixture supports CLI template lookup and flat Claude/Codex plugin output', () => {
  const vendorSkills = fixture();
  const target = mkdtempSync(join(tmpdir(), 'ai-catapult-init-target-'));
  const vendorRoot = mkdtempSync(join(tmpdir(), 'ai-catapult-vendor-'));
  const distRoot = mkdtempSync(join(tmpdir(), 'ai-catapult-dist-'));
  // Build scripts accept a VENDOR_ROOT containing a skills/ child.
  const expectedSkills = join(vendorRoot, 'skills');
  try {
    // mkdtemp creates an arbitrary basename, so expose it under the expected name.
    cpSync(vendorSkills, expectedSkills, { recursive: true });
    const cli = spawnSync(process.execPath, [join(root, 'bin/ai-catapult.ts'), 'init', target], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, AI_CATAPULT_VENDOR_SKILLS: vendorSkills },
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.ok(existsSync(join(target, '.ai/matrix.json')), 'CLI did not resolve future-path templates');

    for (const script of ['build-claude-plugin.ts', 'build-codex-plugin.ts']) {
      const result = spawnSync(process.execPath, [join(root, 'scripts', script)], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, VENDOR_ROOT: vendorRoot, DIST_ROOT: distRoot },
      });
      assert.equal(result.status, 0, `${script} failed:\n${result.stderr}`);
    }
    assert.ok(existsSync(join(distRoot, 'claude-plugin/skills/ai-catapult-init/SKILL.md')));
    assert.ok(existsSync(join(distRoot, 'codex-plugin/skills/ai-catapult-init/SKILL.md')));
    assert.ok(!existsSync(join(distRoot, 'claude-plugin/skills/03-configure-generate')));
    assert.ok(!existsSync(join(distRoot, 'codex-plugin/skills/03-configure-generate')));
  } finally {
    cleanup(target);
    cleanup(vendorSkills);
    cleanup(vendorRoot);
    cleanup(distRoot);
  }
});

void test('init refuses without writing when the vendored validator is absent', () => {
  const vendorSkills = fixture();
  rmSync(join(vendorSkills, 'scripts'), { recursive: true, force: true });
  const target = mkdtempSync(join(tmpdir(), 'ai-catapult-init-target-'));
  try {
    const cli = spawnSync(process.execPath, [join(root, 'bin/ai-catapult.ts'), 'init', target], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, AI_CATAPULT_VENDOR_SKILLS: vendorSkills },
    });
    assert.equal(cli.status, 1, `expected refusal, got status ${cli.status}`);
    assert.match(String(cli.stderr), /validate-rules/);
    assert.deepEqual(readdirSync(target), [], 'refusal must leave the target untouched');
  } finally {
    cleanup(vendorSkills);
    cleanup(target);
  }
});

void test('init refuses a validator that is a directory, not a regular file', () => {
  const vendorSkills = fixture();
  rmSync(join(vendorSkills, 'scripts/validate-rules.sh'), { force: true });
  mkdirSync(join(vendorSkills, 'scripts/validate-rules.sh'));
  const target = mkdtempSync(join(tmpdir(), 'ai-catapult-init-target-'));
  try {
    const cli = spawnSync(process.execPath, [join(root, 'bin/ai-catapult.ts'), 'init', target], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, AI_CATAPULT_VENDOR_SKILLS: vendorSkills },
    });
    assert.equal(cli.status, 1, `expected refusal, got status ${cli.status}`);
    assert.match(String(cli.stderr), /validate-rules/);
    assert.deepEqual(readdirSync(target), [], 'refusal must leave the target untouched');
  } finally {
    cleanup(vendorSkills);
    cleanup(target);
  }
});
