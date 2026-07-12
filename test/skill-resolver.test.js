import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVendorSkill } from '../src/skill-resolver.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const canonicalSkill = resolveVendorSkill(join(root, 'vendor/skills'));

function fixture({ catalog = true, sourcePath = '03-configure-generate/ai-catapult-init' } = {}) {
  const vendorSkills = mkdtempSync(join(tmpdir(), 'ai-catapult-skills-'));
  const skillDir = join(vendorSkills, sourcePath);
  mkdirSync(dirname(skillDir), { recursive: true });
  cpSync(canonicalSkill, skillDir, { recursive: true });
  if (catalog) {
    writeFileSync(join(vendorSkills, 'catalog.json'), JSON.stringify({
      schema_version: '1.0',
      skills: [{ name: 'ai-catapult-init', source_path: sourcePath }],
    }), 'utf8');
  }
  return vendorSkills;
}

function cleanup(path) {
  rmSync(path, { recursive: true, force: true });
}

test('resolver uses the future workflow-stage source_path', () => {
  const vendorSkills = fixture();
  try {
    assert.equal(resolveVendorSkill(vendorSkills), realpathSync(join(vendorSkills, '03-configure-generate/ai-catapult-init')));
  } finally { cleanup(vendorSkills); }
});

test('resolver fails actionably when catalog.json is absent, even if the legacy path exists', () => {
  const vendorSkills = fixture({ catalog: false, sourcePath: 'ai-catapult-init' });
  try {
    assert.throws(
      () => resolveVendorSkill(vendorSkills),
      /catalog\.json is missing.*refresh the vendored skills checkout from skills\.lock\.json/,
    );
  } finally { cleanup(vendorSkills); }
});

test('present malformed catalog fails closed instead of using a valid legacy path', () => {
  const vendorSkills = fixture({ catalog: false, sourcePath: 'ai-catapult-init' });
  try {
    writeFileSync(join(vendorSkills, 'catalog.json'), '{bad json', 'utf8');
    assert.throws(() => resolveVendorSkill(vendorSkills), /catalog\.json is malformed/);
  } finally { cleanup(vendorSkills); }
});

test('catalog rejects duplicate canonical entries', () => {
  const vendorSkills = fixture();
  try {
    const catalogPath = join(vendorSkills, 'catalog.json');
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    catalog.skills.push({ ...catalog.skills[0] });
    writeFileSync(catalogPath, JSON.stringify(catalog), 'utf8');
    assert.throws(() => resolveVendorSkill(vendorSkills), /exactly one canonical/);
  } finally { cleanup(vendorSkills); }
});

for (const sourcePath of ['/tmp/ai-catapult-init', '../ai-catapult-init', 'phase/../../ai-catapult-init']) {
  test(`catalog rejects unsafe source_path: ${sourcePath}`, () => {
    const vendorSkills = fixture();
    try {
      writeFileSync(join(vendorSkills, 'catalog.json'), JSON.stringify({
        skills: [{ name: 'ai-catapult-init', source_path: sourcePath }],
      }), 'utf8');
      assert.throws(() => resolveVendorSkill(vendorSkills), /repository-relative|traversal/);
    } finally { cleanup(vendorSkills); }
  });
}

test('resolver rejects SKILL.md frontmatter-name mismatch', () => {
  const vendorSkills = fixture();
  try {
    const skillMd = join(vendorSkills, '03-configure-generate/ai-catapult-init/SKILL.md');
    writeFileSync(skillMd, readFileSync(skillMd, 'utf8').replace(/^name:\s*ai-catapult-init$/m, 'name: wrong-name'), 'utf8');
    assert.throws(() => resolveVendorSkill(vendorSkills), /frontmatter name does not match/);
  } finally { cleanup(vendorSkills); }
});

test('resolver rejects a missing SKILL.md', () => {
  const vendorSkills = fixture();
  try {
    unlinkSync(join(vendorSkills, '03-configure-generate/ai-catapult-init/SKILL.md'));
    assert.throws(() => resolveVendorSkill(vendorSkills), /SKILL\.md is missing/);
  } finally { cleanup(vendorSkills); }
});

test('resolver rejects a missing required template', () => {
  const vendorSkills = fixture();
  try {
    unlinkSync(join(vendorSkills, '03-configure-generate/ai-catapult-init/templates/dot-ai/matrix.json'));
    assert.throws(() => resolveVendorSkill(vendorSkills), /required template is missing/);
  } finally { cleanup(vendorSkills); }
});

test('future-path fixture supports CLI template lookup and flat Claude/Codex plugin output', () => {
  const vendorSkills = fixture();
  const target = mkdtempSync(join(tmpdir(), 'ai-catapult-init-target-'));
  const vendorRoot = mkdtempSync(join(tmpdir(), 'ai-catapult-vendor-'));
  const distRoot = mkdtempSync(join(tmpdir(), 'ai-catapult-dist-'));
  // Build scripts accept a VENDOR_ROOT containing a skills/ child.
  const expectedSkills = join(vendorRoot, 'skills');
  try {
    // mkdtemp creates an arbitrary basename, so expose it under the expected name.
    cpSync(vendorSkills, expectedSkills, { recursive: true });
    const cli = spawnSync(process.execPath, [join(root, 'bin/ai-catapult.js'), 'init', target], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, AI_CATAPULT_VENDOR_SKILLS: vendorSkills },
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.ok(existsSync(join(target, '.ai/matrix.json')), 'CLI did not resolve future-path templates');

    for (const script of ['build-claude-plugin.sh', 'build-codex-plugin.sh']) {
      const result = spawnSync('bash', [join(root, 'scripts', script)], {
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
