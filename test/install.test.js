/**
 * TDD tests for Slice 7 — `ai-catapult install` subcommand.
 *
 * All filesystem writes are isolated to mkdtempSync dirs via HOME and
 * CODEX_HOME env overrides — the real ~/.claude and ~/.codex are NEVER touched.
 *
 * Coverage:
 *   (a) harness detection (claude/codex/both via env)
 *   (b) --dry-run: no writes, clear output
 *   (c) fresh install: payload lands, plugin.json name correct
 *   (d) idempotent re-install: wipe+recopy, no duplicates
 *   (e) foreign-dir refusal without --force
 *   (f) --force allows overwrite of foreign dir
 *   (g) --harness selection (claude only, codex only, all)
 *   (h) missing harness dir is skipped gracefully (no crash)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const bin = join(root, 'bin/ai-catapult.js');

function makeTmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Run `ai-catapult install` with HOME/CODEX_HOME pointed at tmp dirs so
 * no real harness dirs are touched.
 *
 * AI_CATAPULT_DIST_ROOT is inherited from the parent process env, which
 * `npm test` sets to `dist-snapshot/` (a stable pre-built copy populated
 * by pretest). This prevents install tests from racing with claude-plugin
 * tests that wipe+rebuild dist/ concurrently.
 */
function runInstall(args, { home, codexHome } = {}) {
  const env = {
    ...process.env,
    // Always override these two — callers pass synthetic dirs or 'MISSING'
    // (a path that doesn't exist) to control detection.
    HOME: home ?? '/nonexistent-no-home',
    CODEX_HOME: codexHome ?? '/nonexistent-no-codex',
  };

  return spawnSync(process.execPath, [bin, 'install', ...args], {
    encoding: 'utf8',
    env,
  });
}

// ---------------------------------------------------------------------------
// (a) Detection: no harness dirs found → informational exit 0 with message
// ---------------------------------------------------------------------------

test('install: no harnesses detected → exits 0 with informational message', () => {
  const r = runInstall([], {
    home: '/nonexistent-no-home',
    codexHome: '/nonexistent-no-codex',
  });

  assert.equal(
    r.status, 0,
    `Expected exit 0 when no harnesses detected\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
  );

  // Should tell the user nothing was found
  assert.match(
    r.stdout + r.stderr,
    /no harness|nothing to install|not detected|no supported/i,
    `Expected informational "nothing to install" message\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
  );
});

// ---------------------------------------------------------------------------
// (b) --dry-run: no writes at all, but output describes what would happen
// ---------------------------------------------------------------------------

test('install --dry-run: no files written for claude harness', () => {
  const fakeHome = makeTmpDir('ai-catapult-home-');
  // Create ~/.claude so it gets "detected"
  mkdirSync(join(fakeHome, '.claude'), { recursive: true });

  try {
    const r = runInstall(['--dry-run'], { home: fakeHome });

    assert.equal(
      r.status, 0,
      `Expected exit 0 for --dry-run\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );

    // Plugin dir must NOT be created
    const pluginDir = join(fakeHome, '.claude', 'plugins', 'cache', 'ai-catapult-local', 'ai-catapult', 'local');
    assert.ok(
      !existsSync(pluginDir),
      `--dry-run must NOT create plugin dir at ${pluginDir}`,
    );

    // Must mention dry-run in output
    assert.match(
      r.stdout + r.stderr,
      /dry.?run|would install|no changes/i,
      `--dry-run output must describe what would happen\nstdout: ${r.stdout}`,
    );
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('install --dry-run: no files written for codex harness', () => {
  const fakeCodexHome = makeTmpDir('ai-catapult-codex-');
  // Create the codex home so it's detected
  mkdirSync(fakeCodexHome, { recursive: true });

  try {
    const r = runInstall(['--dry-run', '--harness', 'codex'], {
      home: '/nonexistent-no-home',
      codexHome: fakeCodexHome,
    });

    assert.equal(
      r.status, 0,
      `Expected exit 0 for --dry-run codex\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );

    // plugins/cache dir must NOT be created
    const cacheDir = join(fakeCodexHome, 'plugins', 'cache');
    assert.ok(
      !existsSync(cacheDir),
      `--dry-run must NOT create cache dir at ${cacheDir}`,
    );
  } finally {
    rmSync(fakeCodexHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (c) Fresh install: claude — payload lands correctly
// ---------------------------------------------------------------------------

test('install: fresh claude install places plugin.json with correct name', () => {
  const fakeHome = makeTmpDir('ai-catapult-home-fresh-');
  mkdirSync(join(fakeHome, '.claude'), { recursive: true });

  try {
    const r = runInstall(['--harness', 'claude'], { home: fakeHome });

    assert.equal(
      r.status, 0,
      `Expected exit 0 for fresh claude install\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );

    // Plugin must land at cache path
    const pluginRoot = join(fakeHome, '.claude', 'plugins', 'cache', 'ai-catapult-local', 'ai-catapult', 'local');
    const pluginJson = join(pluginRoot, '.claude-plugin', 'plugin.json');

    assert.ok(
      existsSync(pluginRoot),
      `Plugin dir must exist at ${pluginRoot}`,
    );
    assert.ok(
      existsSync(pluginJson),
      `plugin.json must exist at ${pluginJson}`,
    );

    const manifest = JSON.parse(readFileSync(pluginJson, 'utf8'));
    assert.equal(manifest.name, 'ai-catapult', `plugin.json name must be "ai-catapult", got: ${manifest.name}`);
    assert.ok(manifest.version, 'plugin.json must have a version field');

    // installed_plugins.json must be written/updated
    const installedPluginsPath = join(fakeHome, '.claude', 'plugins', 'installed_plugins.json');
    assert.ok(
      existsSync(installedPluginsPath),
      `installed_plugins.json must be written at ${installedPluginsPath}`,
    );

    const installedPlugins = JSON.parse(readFileSync(installedPluginsPath, 'utf8'));
    assert.ok(
      installedPlugins.plugins,
      'installed_plugins.json must have a plugins field',
    );
    const key = 'ai-catapult@ai-catapult-local';
    assert.ok(
      installedPlugins.plugins[key],
      `installed_plugins.json must have key "${key}"`,
    );
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (c) Fresh install: codex — payload lands correctly
// ---------------------------------------------------------------------------

test('install: fresh codex install places plugin.json with correct name', () => {
  const fakeCodexHome = makeTmpDir('ai-catapult-codex-fresh-');
  mkdirSync(fakeCodexHome, { recursive: true });

  try {
    const r = runInstall(['--harness', 'codex'], {
      home: '/nonexistent-no-home',
      codexHome: fakeCodexHome,
    });

    assert.equal(
      r.status, 0,
      `Expected exit 0 for fresh codex install\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );

    // Plugin must land at cache path: plugins/cache/{marketplace}/{plugin}/{version}
    const pluginRoot = join(fakeCodexHome, 'plugins', 'cache', 'ai-catapult-local', 'ai-catapult', 'local');
    const pluginJson = join(pluginRoot, '.codex-plugin', 'plugin.json');

    assert.ok(
      existsSync(pluginRoot),
      `Plugin dir must exist at ${pluginRoot}`,
    );
    assert.ok(
      existsSync(pluginJson),
      `plugin.json must exist at ${pluginJson}`,
    );

    const manifest = JSON.parse(readFileSync(pluginJson, 'utf8'));
    assert.equal(manifest.name, 'ai-catapult', `plugin.json name must be "ai-catapult", got: ${manifest.name}`);

    // Marketplace registration file must exist
    const marketplaceFile = join(fakeCodexHome, 'plugins', 'ai-catapult-local', 'marketplace.json');
    assert.ok(
      existsSync(marketplaceFile),
      `Codex marketplace file must exist at ${marketplaceFile}`,
    );

    const marketplace = JSON.parse(readFileSync(marketplaceFile, 'utf8'));
    assert.ok(
      Array.isArray(marketplace.plugins) && marketplace.plugins.length > 0,
      'marketplace.json must have a non-empty plugins array',
    );
    assert.equal(
      marketplace.plugins[0].name, 'ai-catapult',
      `marketplace plugins[0].name must be "ai-catapult"`,
    );
  } finally {
    rmSync(fakeCodexHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (d) Idempotent re-install: wipe+recopy, no duplicates
// ---------------------------------------------------------------------------

test('install: idempotent re-install for claude refreshes plugin without duplication', () => {
  const fakeHome = makeTmpDir('ai-catapult-home-idem-');
  mkdirSync(join(fakeHome, '.claude'), { recursive: true });

  try {
    // First install
    const r1 = runInstall(['--harness', 'claude'], { home: fakeHome });
    assert.equal(r1.status, 0, `First install failed: ${r1.stderr}`);

    // Second install (idempotent)
    const r2 = runInstall(['--harness', 'claude'], { home: fakeHome });
    assert.equal(r2.status, 0, `Second install failed: ${r2.stderr}`);

    // installed_plugins.json must not have duplicate entries
    const installedPluginsPath = join(fakeHome, '.claude', 'plugins', 'installed_plugins.json');
    const installedPlugins = JSON.parse(readFileSync(installedPluginsPath, 'utf8'));
    const entries = installedPlugins.plugins['ai-catapult@ai-catapult-local'];
    assert.ok(Array.isArray(entries), 'Expected entries array');
    assert.equal(entries.length, 1, `Expected exactly 1 install entry, got ${entries.length}`);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (e) Foreign-dir refusal: plugin dir exists but is not ours → exit 1
// ---------------------------------------------------------------------------

test('install: refuses to overwrite foreign plugin dir (not ai-catapult) without --force', () => {
  const fakeHome = makeTmpDir('ai-catapult-home-foreign-');
  mkdirSync(join(fakeHome, '.claude'), { recursive: true });

  // Create a "foreign" plugin dir at our target path (no plugin.json naming ours)
  const pluginRoot = join(fakeHome, '.claude', 'plugins', 'cache', 'ai-catapult-local', 'ai-catapult', 'local');
  mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true });
  // Write a foreign plugin.json (different name)
  writeFileSync(
    join(pluginRoot, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'some-other-plugin', version: '1.0.0' }),
  );

  try {
    const r = runInstall(['--harness', 'claude'], { home: fakeHome });

    assert.equal(
      r.status, 1,
      `Expected exit 1 when foreign plugin dir exists\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
    assert.match(
      r.stdout + r.stderr,
      /foreign|conflict|not.*ai-catapult|already exists.*--force|use --force/i,
      `Expected refusal message about foreign dir\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (f) --force: allows overwrite of foreign dir
// ---------------------------------------------------------------------------

test('install --force: overwrites foreign plugin dir and succeeds', () => {
  const fakeHome = makeTmpDir('ai-catapult-home-force-');
  mkdirSync(join(fakeHome, '.claude'), { recursive: true });

  const pluginRoot = join(fakeHome, '.claude', 'plugins', 'cache', 'ai-catapult-local', 'ai-catapult', 'local');
  mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(pluginRoot, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'some-other-plugin', version: '1.0.0' }),
  );

  try {
    const r = runInstall(['--harness', 'claude', '--force'], { home: fakeHome });

    assert.equal(
      r.status, 0,
      `Expected exit 0 with --force\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );

    // Our plugin.json must now be there
    const pluginJson = join(pluginRoot, '.claude-plugin', 'plugin.json');
    const manifest = JSON.parse(readFileSync(pluginJson, 'utf8'));
    assert.equal(manifest.name, 'ai-catapult', `Expected our plugin.json, got name: ${manifest.name}`);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (g) --harness selection
// ---------------------------------------------------------------------------

test('install --harness claude: only touches claude dir, not codex', () => {
  const fakeHome = makeTmpDir('ai-catapult-home-hselect-');
  const fakeCodexHome = makeTmpDir('ai-catapult-codex-hselect-');
  mkdirSync(join(fakeHome, '.claude'), { recursive: true });
  mkdirSync(fakeCodexHome, { recursive: true });

  try {
    const r = runInstall(['--harness', 'claude'], { home: fakeHome, codexHome: fakeCodexHome });
    assert.equal(r.status, 0, `Expected exit 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);

    // Claude plugin must exist
    const claudePlugin = join(fakeHome, '.claude', 'plugins', 'cache', 'ai-catapult-local', 'ai-catapult', 'local', '.claude-plugin', 'plugin.json');
    assert.ok(existsSync(claudePlugin), `Claude plugin.json must exist at ${claudePlugin}`);

    // Codex plugin must NOT exist
    const codexCache = join(fakeCodexHome, 'plugins', 'cache');
    assert.ok(!existsSync(codexCache), `Codex cache dir must NOT be created when --harness claude`);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(fakeCodexHome, { recursive: true, force: true });
  }
});

test('install --harness codex: only touches codex dir, not claude', () => {
  const fakeHome = makeTmpDir('ai-catapult-home-hcodex-');
  const fakeCodexHome = makeTmpDir('ai-catapult-codex-hcodex-');
  mkdirSync(join(fakeHome, '.claude'), { recursive: true });
  mkdirSync(fakeCodexHome, { recursive: true });

  try {
    const r = runInstall(['--harness', 'codex'], { home: fakeHome, codexHome: fakeCodexHome });
    assert.equal(r.status, 0, `Expected exit 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);

    // Claude plugin must NOT exist
    const claudeCache = join(fakeHome, '.claude', 'plugins', 'cache');
    assert.ok(!existsSync(claudeCache), `Claude cache dir must NOT be created when --harness codex`);

    // Codex plugin must exist
    const codexPlugin = join(fakeCodexHome, 'plugins', 'cache', 'ai-catapult-local', 'ai-catapult', 'local', '.codex-plugin', 'plugin.json');
    assert.ok(existsSync(codexPlugin), `Codex plugin.json must exist at ${codexPlugin}`);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(fakeCodexHome, { recursive: true, force: true });
  }
});

test('install --harness all: installs to both harnesses', () => {
  const fakeHome = makeTmpDir('ai-catapult-home-hall-');
  const fakeCodexHome = makeTmpDir('ai-catapult-codex-hall-');
  mkdirSync(join(fakeHome, '.claude'), { recursive: true });
  mkdirSync(fakeCodexHome, { recursive: true });

  try {
    const r = runInstall(['--harness', 'all'], { home: fakeHome, codexHome: fakeCodexHome });
    assert.equal(r.status, 0, `Expected exit 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);

    const claudePlugin = join(fakeHome, '.claude', 'plugins', 'cache', 'ai-catapult-local', 'ai-catapult', 'local', '.claude-plugin', 'plugin.json');
    assert.ok(existsSync(claudePlugin), `Claude plugin.json must exist`);

    const codexPlugin = join(fakeCodexHome, 'plugins', 'cache', 'ai-catapult-local', 'ai-catapult', 'local', '.codex-plugin', 'plugin.json');
    assert.ok(existsSync(codexPlugin), `Codex plugin.json must exist`);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(fakeCodexHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (h) Missing harness dir is skipped gracefully (auto-detected)
// ---------------------------------------------------------------------------

test('install: auto-detect skips harness when its dir does not exist', () => {
  const fakeHome = makeTmpDir('ai-catapult-home-skip-');
  // Only create .claude, not codex dir
  mkdirSync(join(fakeHome, '.claude'), { recursive: true });

  try {
    const r = runInstall([], {
      home: fakeHome,
      codexHome: '/nonexistent-no-codex',
    });

    assert.equal(
      r.status, 0,
      `Expected exit 0 when one harness is missing\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );

    // Claude plugin should be installed
    const claudePlugin = join(fakeHome, '.claude', 'plugins', 'cache', 'ai-catapult-local', 'ai-catapult', 'local', '.claude-plugin', 'plugin.json');
    assert.ok(existsSync(claudePlugin), `Claude plugin.json must exist when .claude/ detected`);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (i) --help shows install usage
// ---------------------------------------------------------------------------

test('install --help: exits 0 and shows install usage', () => {
  const r = spawnSync(process.execPath, [bin, 'install', '--help'], { encoding: 'utf8' });

  assert.equal(r.status, 0, `Expected exit 0 for --help\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(
    r.stdout,
    /install/i,
    `--help must mention install command\nstdout: ${r.stdout}`,
  );
  assert.match(
    r.stdout,
    /--dry-run|--harness|--force/i,
    `--help must mention key flags\nstdout: ${r.stdout}`,
  );
});
