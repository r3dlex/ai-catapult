/**
 * TDD tests for Slice 7 — npm pack readiness.
 *
 * Verifies what the npm tarball will contain without racing against other tests.
 *
 * Strategy: verify directly via package.json `files` + file-existence checks
 * against dist-snapshot/ (populated by pretest, stable throughout the test run).
 * We do NOT call `npm pack --dry-run` here because:
 *   - codex-plugin.test.js calls runBuild() per test, wiping+rebuilding dist/
 *   - npm pack walks the live dist/ directory during execution
 *   - these two operations race under node --test (parallel execution)
 *
 * The dist-snapshot/ directory (created by pretest via snapshot-dist.sh) is
 * never modified during the test run and provides a stable reference.
 *
 * Invariants checked:
 *   - MUST include: bin/ai-catapult.js, src/scaffold.js, src/install.js,
 *                   setup.sh, skills.lock.json, dist/ (pre-built plugins)
 *   - MUST NOT include: anything under test/ or vendor/
 *
 * Note: dist/ is gitignored but intentionally included in the npm `files`
 * whitelist (gitignore and npm files are independent — npm includes files
 * entries even if gitignored). The prepack script ensures dist/ is populated
 * fresh before every `npm pack` / `npm publish`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// dist-snapshot/ is populated by pretest (bash scripts/snapshot-dist.sh) and
// is stable throughout the test run (codex-plugin tests do NOT touch it).
const DIST_SNAPSHOT = process.env.AI_CATAPULT_DIST_ROOT ?? join(root, 'dist-snapshot');

function getPackageFiles() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return pkg.files ?? [];
}

// ---------------------------------------------------------------------------
// package.json files whitelist checks
// ---------------------------------------------------------------------------

test('npm pack: package.json files includes bin/', () => {
  const files = getPackageFiles();
  assert.ok(
    files.includes('bin/'),
    `package.json "files" must include "bin/"\nActual files: ${JSON.stringify(files)}`,
  );
});

test('npm pack: package.json files includes src/', () => {
  const files = getPackageFiles();
  assert.ok(
    files.includes('src/'),
    `package.json "files" must include "src/"\nActual files: ${JSON.stringify(files)}`,
  );
});

test('npm pack: package.json files includes setup.sh', () => {
  const files = getPackageFiles();
  assert.ok(
    files.includes('setup.sh'),
    `package.json "files" must include "setup.sh"\nActual files: ${JSON.stringify(files)}`,
  );
});

test('npm pack: package.json files includes skills.lock.json', () => {
  const files = getPackageFiles();
  assert.ok(
    files.includes('skills.lock.json'),
    `package.json "files" must include "skills.lock.json"\nActual files: ${JSON.stringify(files)}`,
  );
});

test('npm pack: package.json files includes dist/ (pre-built plugins shipped with package)', () => {
  const files = getPackageFiles();
  assert.ok(
    files.includes('dist/'),
    `package.json "files" must include "dist/" so pre-built plugins ship in the tarball\nActual files: ${JSON.stringify(files)}`,
  );
});

test('npm pack: package.json files does NOT include test/', () => {
  const files = getPackageFiles();
  assert.ok(
    !files.some((f) => f === 'test/' || f.startsWith('test/')),
    `package.json "files" must not include test/\nActual files: ${JSON.stringify(files)}`,
  );
});

test('npm pack: package.json files does NOT include vendor/', () => {
  const files = getPackageFiles();
  assert.ok(
    !files.some((f) => f === 'vendor/' || f.startsWith('vendor/')),
    `package.json "files" must not include vendor/\nActual files: ${JSON.stringify(files)}`,
  );
});

// ---------------------------------------------------------------------------
// Actual file existence checks against dist-snapshot (stable reference)
// ---------------------------------------------------------------------------

test('npm pack: bin/ai-catapult.js exists', () => {
  assert.ok(
    existsSync(join(root, 'bin/ai-catapult.js')),
    `bin/ai-catapult.js must exist`,
  );
});

test('npm pack: src/scaffold.js exists', () => {
  assert.ok(
    existsSync(join(root, 'src/scaffold.js')),
    `src/scaffold.js must exist`,
  );
});

test('npm pack: src/install.js exists', () => {
  assert.ok(
    existsSync(join(root, 'src/install.js')),
    `src/install.js must exist`,
  );
});

test('npm pack: dist/claude-plugin is present in dist-snapshot (shipped with package)', () => {
  const claudeManifest = join(DIST_SNAPSHOT, 'claude-plugin', '.claude-plugin', 'plugin.json');
  assert.ok(
    existsSync(claudeManifest),
    `dist-snapshot/claude-plugin/.claude-plugin/plugin.json must exist — pretest must build the claude plugin\nChecked: ${claudeManifest}`,
  );
});

test('npm pack: dist/codex-plugin is present in dist-snapshot (shipped with package)', () => {
  const codexManifest = join(DIST_SNAPSHOT, 'codex-plugin', '.codex-plugin', 'plugin.json');
  assert.ok(
    existsSync(codexManifest),
    `dist-snapshot/codex-plugin/.codex-plugin/plugin.json must exist — pretest must build the codex plugin\nChecked: ${codexManifest}`,
  );
});

test('npm pack: prepack script builds both plugins (ensures fresh dist/ on publish)', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const prepack = pkg.scripts?.prepack ?? '';
  assert.ok(
    prepack.includes('build-claude-plugin.sh') && prepack.includes('build-codex-plugin.sh'),
    `package.json prepack script must invoke both build scripts so "npm publish" always embeds fresh payloads\nActual prepack: ${prepack}`,
  );
});

test('npm pack: prepack script stages skill-templates (ensures npx init works from published package)', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const prepack = pkg.scripts?.prepack ?? '';
  assert.ok(
    prepack.includes('stage-skill-templates.sh'),
    `package.json prepack script must invoke stage-skill-templates.sh so dist/skill-templates/ ships in the tarball\nActual prepack: ${prepack}`,
  );
});

test('npm pack: dist/skill-templates/ is present in dist-snapshot (init fallback for published package)', () => {
  const skillTemplatesDir = join(DIST_SNAPSHOT, 'skill-templates');
  assert.ok(
    existsSync(skillTemplatesDir),
    `dist-snapshot/skill-templates/ must exist — pretest must stage skill templates\nChecked: ${skillTemplatesDir}`,
  );
});

test('npm pack: dist/skill-templates/boundary-manifest.json exists (scaffold engine requires it)', () => {
  const manifest = join(DIST_SNAPSHOT, 'skill-templates', 'boundary-manifest.json');
  assert.ok(
    existsSync(manifest),
    `dist-snapshot/skill-templates/boundary-manifest.json must exist\nChecked: ${manifest}`,
  );
});
