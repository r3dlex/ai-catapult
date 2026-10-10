/**
 * TDD tests for Slice 7 — npm pack readiness.
 *
 * Verifies what the npm tarball will contain without racing against other tests.
 *
 * Strategy: verify directly via package.json `files` + file-existence checks
 * against dist-snapshot/ (populated by pretest, stable throughout the test run).
 * We do NOT call `npm pack --dry-run` here because:
 *   - codex-plugin.test.ts calls runBuild() per test, wiping+rebuilding dist/
 *   - npm pack walks the live dist/ directory during execution
 *   - these two operations race under node --test (parallel execution)
 *
 * The dist-snapshot/ directory (created by pretest via scripts/prepare-dist.ts
 * → scripts/snapshot-dist.ts) is never modified during the test run and
 * provides a stable reference.
 *
 * Invariants checked:
 *   - MUST include: bin/ai-catapult.ts, src/scaffold.ts, src/install.ts,
 *                   scripts/setup.ts, skills.lock.json, dist/ (pre-built plugins)
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

// dist-snapshot/ is populated by pretest (npm run build → scripts/prepare-dist.ts)
// and is stable throughout the test run (codex-plugin tests do NOT touch it).
const DIST_SNAPSHOT = process.env.AI_CATAPULT_DIST_ROOT ?? join(root, 'dist-snapshot');

type PackageJson = { files?: string[]; scripts?: Record<string, string> };

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJson;
}

function getPackageFiles(): string[] {
  return readPackageJson().files ?? [];
}

// ---------------------------------------------------------------------------
// package.json files whitelist checks
// ---------------------------------------------------------------------------

void test('npm pack: package.json files includes bin/', () => {
  const files = getPackageFiles();
  assert.ok(
    files.includes('bin/'),
    `package.json "files" must include "bin/"\nActual files: ${JSON.stringify(files)}`,
  );
});

void test('npm pack: package.json files includes src/', () => {
  const files = getPackageFiles();
  assert.ok(
    files.includes('src/'),
    `package.json "files" must include "src/"\nActual files: ${JSON.stringify(files)}`,
  );
});

void test('npm pack: package.json files includes scripts/setup.ts', () => {
  const files = getPackageFiles();
  assert.ok(
    files.includes('scripts/setup.ts'),
    `package.json "files" must include "scripts/setup.ts" (the TypeScript bootstrap, replacing the former setup.sh)\nActual files: ${JSON.stringify(files)}`,
  );
});

void test('npm pack: package.json files includes skills.lock.json', () => {
  const files = getPackageFiles();
  assert.ok(
    files.includes('skills.lock.json'),
    `package.json "files" must include "skills.lock.json"\nActual files: ${JSON.stringify(files)}`,
  );
});

void test('npm pack: package.json files includes dist/ (pre-built plugins shipped with package)', () => {
  const files = getPackageFiles();
  assert.ok(
    files.includes('dist/'),
    `package.json "files" must include "dist/" so pre-built plugins ship in the tarball\nActual files: ${JSON.stringify(files)}`,
  );
});

void test('npm pack: package.json files does NOT include test/', () => {
  const files = getPackageFiles();
  assert.ok(
    !files.some((f) => f === 'test/' || f.startsWith('test/')),
    `package.json "files" must not include test/\nActual files: ${JSON.stringify(files)}`,
  );
});

void test('npm pack: package.json files does NOT include vendor/', () => {
  const files = getPackageFiles();
  assert.ok(
    !files.some((f) => f === 'vendor/' || f.startsWith('vendor/')),
    `package.json "files" must not include vendor/\nActual files: ${JSON.stringify(files)}`,
  );
});

// ---------------------------------------------------------------------------
// Actual file existence checks against dist-snapshot (stable reference)
// ---------------------------------------------------------------------------

void test('npm pack: bin/ai-catapult.ts exists', () => {
  assert.ok(
    existsSync(join(root, 'bin/ai-catapult.ts')),
    `bin/ai-catapult.ts must exist`,
  );
});

void test('npm pack: src/scaffold.ts exists', () => {
  assert.ok(
    existsSync(join(root, 'src/scaffold.ts')),
    `src/scaffold.ts must exist`,
  );
});

void test('npm pack: src/install.ts exists', () => {
  assert.ok(
    existsSync(join(root, 'src/install.ts')),
    `src/install.ts must exist`,
  );
});

void test('npm pack: dist/claude-plugin is present in dist-snapshot (shipped with package)', () => {
  const claudeManifest = join(DIST_SNAPSHOT, 'claude-plugin', '.claude-plugin', 'plugin.json');
  assert.ok(
    existsSync(claudeManifest),
    `dist-snapshot/claude-plugin/.claude-plugin/plugin.json must exist — pretest must build the claude plugin\nChecked: ${claudeManifest}`,
  );
});

void test('npm pack: dist/codex-plugin is present in dist-snapshot (shipped with package)', () => {
  const codexManifest = join(DIST_SNAPSHOT, 'codex-plugin', '.codex-plugin', 'plugin.json');
  assert.ok(
    existsSync(codexManifest),
    `dist-snapshot/codex-plugin/.codex-plugin/plugin.json must exist — pretest must build the codex plugin\nChecked: ${codexManifest}`,
  );
});

void test('npm pack: prepack script bootstraps the vendor and runs the build chain', () => {
  const pkg = readPackageJson();
  const prepack = pkg.scripts?.prepack ?? '';
  assert.ok(
    prepack.includes('scripts/setup.ts') && prepack.includes('npm run build'),
    `package.json prepack script must bootstrap vendor via scripts/setup.ts and run the build chain so "npm publish" always embeds fresh payloads\nActual prepack: ${prepack}`,
  );
});

void test('npm pack: build chain goes through scripts/prepare-dist.ts', () => {
  const pkg = readPackageJson();
  const build = pkg.scripts?.build ?? '';
  assert.ok(
    build.includes('scripts/prepare-dist.ts'),
    `package.json build script must invoke scripts/prepare-dist.ts so every payload is staged before packing\nActual build: ${build}`,
  );
});

void test('npm pack: prepare-dist.ts stages both plugin payloads, skill templates and the README contract', () => {
  const prepareDist = readFileSync(join(root, 'scripts', 'prepare-dist.ts'), 'utf8');
  assert.ok(
    prepareDist.includes('build-claude-plugin.ts'),
    `scripts/prepare-dist.ts must stage the Claude plugin build so dist/claude-plugin/ ships\nContent: ${prepareDist}`,
  );
  assert.ok(
    prepareDist.includes('build-codex-plugin.ts'),
    `scripts/prepare-dist.ts must stage the Codex plugin build so dist/codex-plugin/ ships\nContent: ${prepareDist}`,
  );
  assert.ok(
    prepareDist.includes('stage-skill-templates.ts'),
    `scripts/prepare-dist.ts must stage skill templates so dist/skill-templates/ ships in the tarball\nContent: ${prepareDist}`,
  );
  assert.ok(
    prepareDist.includes('stage-readme-contract.ts'),
    `scripts/prepare-dist.ts must stage the canonical README contract so dist/readme-contract/ ships\nContent: ${prepareDist}`,
  );
});

void test('npm pack: dist/skill-templates/ is present in dist-snapshot (init fallback for published package)', () => {
  const skillTemplatesDir = join(DIST_SNAPSHOT, 'skill-templates');
  assert.ok(
    existsSync(skillTemplatesDir),
    `dist-snapshot/skill-templates/ must exist — pretest must stage skill templates\nChecked: ${skillTemplatesDir}`,
  );
});

void test('npm pack: dist/skill-templates/boundary-manifest.json exists (scaffold engine requires it)', () => {
  const manifest = join(DIST_SNAPSHOT, 'skill-templates', 'boundary-manifest.json');
  assert.ok(
    existsSync(manifest),
    `dist-snapshot/skill-templates/boundary-manifest.json must exist\nChecked: ${manifest}`,
  );
});

void test('npm pack: dist/readme-contract contains the canonical generator and template', () => {
  assert.ok(existsSync(join(DIST_SNAPSHOT, 'readme-contract', 'scripts', 'readme-generate.sh')));
  assert.ok(existsSync(join(DIST_SNAPSHOT, 'readme-contract', 'assets', 'readme', 'template.md')));
});