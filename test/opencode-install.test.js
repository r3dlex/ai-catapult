/**
 * Goal A3 (opencode-omo-harness-convergence) — `ai-catapult install --harness opencode`.
 *
 * Subprocess-style tests mirroring install.test.js conventions. All writes are
 * isolated to mkdtempSync dirs via HOME/XDG_CONFIG_HOME overrides; a private
 * dist root is built once per run via scripts/build-opencode-plugin.sh and
 * injected through AI_CATAPULT_DIST_ROOT (the module-level seam), so the real
 * ~/.config/opencode is NEVER touched.
 *
 * Coverage:
 *   (a) --harness opencode: payload skills+commands land under <xdg>/opencode/
 *       with version + restart note printed
 *   (b) additive merge: foreign skill dirs / command files / opencode.jsonc
 *       are preserved byte-for-byte
 *   (c) idempotent re-install: owned entries refreshed, foreign content intact
 *   (d) --dry-run: nothing is written
 *   (e) auto-detection: .config/opencode present without --harness → installs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const bin = join(root, 'bin/ai-catapult.js');

/** Build the opencode payload once into a private dist root. */
function buildPrivateDist() {
  const distRoot = mkdtempSync(join(tmpdir(), 'ai-catapult-oc-inst-dist-'));
  const result = spawnSync('bash', [join(root, 'scripts', 'build-opencode-plugin.sh')], {
    encoding: 'utf8',
    cwd: root,
    env: { ...process.env, DIST_ROOT: distRoot },
    timeout: 60000,
  });
  assert.equal(result.status, 0, `fixture build failed: ${result.stderr}`);
  return distRoot;
}

const privateDist = buildPrivateDist();
const payloadManifest = JSON.parse(
  readFileSync(join(privateDist, 'opencode-plugin', '.opencode-plugin', 'plugin.json'), 'utf8'),
);

function makeTmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function runInstallCli(args, { home, xdg, distRoot = privateDist } = {}) {
  return spawnSync(process.execPath, [bin, 'install', ...args], {
    encoding: 'utf8',
    cwd: root,
    timeout: 60000,
    env: {
      ...process.env,
      HOME: home ?? '/nonexistent-no-home',
      CODEX_HOME: '/nonexistent-no-codex',
      XDG_CONFIG_HOME: xdg ?? '/nonexistent-no-xdg',
      AI_CATAPULT_DIST_ROOT: distRoot,
    },
  });
}

test('opencode install lands owned skills and commands with restart note', () => {
  const home = makeTmpDir('ai-catapult-oc-home-');
  const xdg = makeTmpDir('ai-catapult-oc-xdg-');
  try {
    // Mirror install.test.js detection semantics: an explicitly selected
    // harness is installed only when its config root exists.
    mkdirSync(join(xdg, 'opencode'), { recursive: true });
    const result = runInstallCli(['--harness', 'opencode'], { home, xdg });
    assert.equal(result.status, 0, `install failed: ${result.stderr}`);
    assert.match(result.stdout, /OpenCode/);
    assert.match(result.stdout, new RegExp(payloadManifest.version));
    assert.match(result.stdout, /[Rr]estart/);

    const ocDir = join(xdg, 'opencode');
    for (const name of payloadManifest.skills.slice(0, 3)) {
      assert.ok(
        existsSync(join(ocDir, 'skills', name, 'SKILL.md')),
        `skills/${name}/SKILL.md missing after install`,
      );
    }
    for (const name of payloadManifest.commands) {
      assert.ok(existsSync(join(ocDir, 'command', `${name}.md`)), `command/${name}.md missing`);
    }
    assert.ok(!existsSync(join(ocDir, 'opencode.jsonc')), 'installer must not create opencode.jsonc');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(xdg, { recursive: true, force: true });
  }
});

test('opencode install is additive: foreign content and opencode.jsonc survive', () => {
  const home = makeTmpDir('ai-catapult-oc-home2-');
  const xdg = makeTmpDir('ai-catapult-oc-xdg2-');
  try {
    const ocDir = join(xdg, 'opencode');
    mkdirSync(join(ocDir, 'skills', 'foreign-skill'), { recursive: true });
    writeFileSync(join(ocDir, 'skills', 'foreign-skill', 'SKILL.md'), '# foreign\n');
    mkdirSync(join(ocDir, 'command'), { recursive: true });
    writeFileSync(join(ocDir, 'command', 'keep.md'), '# keep\n');
    const jsoncSentinel = '{\n  // user-owned\n  "model": "sentinel/one"\n}\n';
    writeFileSync(join(ocDir, 'opencode.jsonc'), jsoncSentinel);

    const result = runInstallCli(['--harness', 'opencode'], { home, xdg });
    assert.equal(result.status, 0, `install failed: ${result.stderr}`);

    assert.ok(existsSync(join(ocDir, 'skills', 'foreign-skill', 'SKILL.md')), 'foreign skill clobbered');
    assert.ok(existsSync(join(ocDir, 'command', 'keep.md')), 'foreign command clobbered');
    assert.equal(readFileSync(join(ocDir, 'opencode.jsonc'), 'utf8'), jsoncSentinel, 'opencode.jsonc mutated');

    // Idempotent re-install keeps the same guarantees.
    const second = runInstallCli(['--harness', 'opencode'], { home, xdg });
    assert.equal(second.status, 0, `re-install failed: ${second.stderr}`);
    assert.equal(readFileSync(join(ocDir, 'opencode.jsonc'), 'utf8'), jsoncSentinel);
    assert.ok(existsSync(join(ocDir, 'skills', 'foreign-skill', 'SKILL.md')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(xdg, { recursive: true, force: true });
  }
});

test('opencode dry-run writes nothing', () => {
  const home = makeTmpDir('ai-catapult-oc-home3-');
  const xdg = makeTmpDir('ai-catapult-oc-xdg3-');
  try {
    const result = runInstallCli(['--harness', 'opencode', '--dry-run'], { home, xdg });
    assert.equal(result.status, 0, `dry-run failed: ${result.stderr}`);
    assert.match(result.stdout, /dry-run/);
    assert.ok(!existsSync(join(xdg, 'opencode')), 'dry-run must not create <xdg>/opencode');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(xdg, { recursive: true, force: true });
  }
});

test('auto-detection installs into opencode when only <xdg>/opencode exists', () => {
  const home = makeTmpDir('ai-catapult-oc-home4-');
  const xdg = makeTmpDir('ai-catapult-oc-xdg4-');
  try {
    mkdirSync(join(xdg, 'opencode'), { recursive: true });
    const result = runInstallCli([], { home, xdg });
    assert.equal(result.status, 0, `auto-detect install failed: ${result.stderr}`);
    const ocDir = join(xdg, 'opencode');
    assert.ok(
      existsSync(join(ocDir, 'skills', payloadManifest.skills[0], 'SKILL.md')),
      'auto-detect did not install opencode payload',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(xdg, { recursive: true, force: true });
  }
});
