/**
 * contract-drift.test.js — ACH-C-02 TDD evidence for the six-surface readiness
 * contract drift sweep.
 *
 * src/contract-drift.js hashes every file named in the vendored
 * readiness-dependency.json (readiness-contract/1) and
 * readiness-dependency-v2.json (readiness-contract/2) manifests, mirroring the
 * pinned contract-run.sh / contract-run-v2.sh verification rule:
 *
 *   - path keys starting with "northstar/" resolve against the northstar peer
 *     dir (prefix stripped); every other key resolves against the autobahn dir;
 *   - the northstar manifest copies must be content-equal to the autobahn
 *     copies (producer/consumer fingerprint parity);
 *   - drift names path/expected/actual and the process exits non-zero.
 *
 * Surfaces (each probed against the vendored pinned bytes):
 *   1. vendor/skills            (skills-repo layout: 04-validate-handoff/autobahn
 *                                + 02-govern-plan/northstar)
 *   2. dist/<harness>-plugin    (flat payload layout: skills/autobahn +
 *                                skills/northstar)
 *   3. ~/.claude/plugins/ai-catapult marketplace payload (flat layout)
 *   4. loaded cache from ~/.claude/plugins/installed_plugins.json installPath
 *   5. Codex plugin cache $CODEX_HOME/plugins/cache/ai-catapult-local/ai-catapult/local
 *   6. OpenCode skills directory $XDG_CONFIG_HOME/opencode/skills
 *
 * Loaded-cache drift additionally carries the two refresh hints:
 *   claude plugin marketplace update
 *   claude plugin update
 *
 * Every fixture here lives in a mkdtemp tree with HOME, CODEX_HOME and
 * XDG_CONFIG_HOME overrides — the real home directories are never touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { sweepContractDrift } from '../src/contract-drift.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'vendor/skills');
const VENDOR_AUTOBAHN = join(vendor, '04-validate-handoff/autobahn');
const VENDOR_NORTHSTAR = join(vendor, '02-govern-plan/northstar');

// Mutation target that never collides with a manifest: shared pinned helper.
const PROBE_FILE = 'lib/readiness_contract.py';
// northstar-prefixed pinned path (resolved against the northstar peer dir).
const NORTHSTAR_PROBE_FILE = 'approve.sh';
// A v2 manifest copy, used to prove producer/consumer fingerprint parity.
const V2_MANIFEST = 'readiness-dependency-v2.json';

function requireVendoredV2() {
  assert.ok(
    existsSync(join(VENDOR_AUTOBAHN, V2_MANIFEST)),
    'vendored readiness-dependency-v2.json missing — run `bash setup.sh` at the O8 lock first',
  );
  assert.ok(
    existsSync(join(VENDOR_NORTHSTAR, V2_MANIFEST)),
    'vendored northstar readiness-dependency-v2.json missing — run `bash setup.sh` first',
  );
}

/** Skills-repo layout: <dest>/04-validate-handoff/autobahn + 02-govern-plan/northstar. */
function copySkillsRepoLayout(dest) {
  cpSync(VENDOR_AUTOBAHN, join(dest, '04-validate-handoff/autobahn'), { recursive: true });
  cpSync(VENDOR_NORTHSTAR, join(dest, '02-govern-plan/northstar'), { recursive: true });
}

/** Flat plugin-payload layout: <dest>/skills/autobahn + skills/northstar. */
function copyPayloadLayout(dest) {
  mkdirSync(join(dest, 'skills'), { recursive: true });
  cpSync(VENDOR_AUTOBAHN, join(dest, 'skills', 'autobahn'), { recursive: true });
  cpSync(VENDOR_NORTHSTAR, join(dest, 'skills', 'northstar'), { recursive: true });
}

/** OpenCode skills root layout: <dest>/autobahn + <dest>/northstar. */
function copyOpenCodeLayout(dest) {
  mkdirSync(dest, { recursive: true });
  cpSync(VENDOR_AUTOBAHN, join(dest, 'autobahn'), { recursive: true });
  cpSync(VENDOR_NORTHSTAR, join(dest, 'northstar'), { recursive: true });
}

/** Real installed_plugins.json shape (read from this repo's own machine docs): version+plugins map. */
function writeInstalledPlugins(home, installPath) {
  const plugins = join(home, '.claude/plugins');
  mkdirSync(plugins, { recursive: true });
  writeFileSync(
    join(plugins, 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'ai-catapult@ai-catapult': [
          {
            scope: 'user',
            installPath,
            version: '0.4.3',
            installedAt: '2026-01-01T00:00:00.000Z',
            lastUpdated: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    }),
  );
}

/** Build a full six-surface fixture set from the current vendored pinned bytes. */
function buildFixtures(base, { withInstalledPlugins = true } = {}) {
  const home = join(base, 'home');
  const codexHome = join(home, '.codex');
  const xdgConfig = join(home, '.config');
  const fixtures = {
    base,
    home,
    codexHome,
    xdgConfig,
    vendorRoot: join(base, 'skills-repo'),
    dist: join(base, 'dist'),
    marketplace: join(home, '.claude/plugins/ai-catapult'),
    loadedCache: join(home, 'loaded-cache-payload'),
    codexCache: join(codexHome, 'plugins/cache/ai-catapult-local/ai-catapult/local'),
    opencodeSkills: join(xdgConfig, 'opencode/skills'),
  };
  copySkillsRepoLayout(fixtures.vendorRoot);
  for (const harness of ['claude-plugin', 'codex-plugin', 'opencode-plugin']) {
    copyPayloadLayout(join(fixtures.dist, harness));
  }
  copyPayloadLayout(fixtures.marketplace);
  copyPayloadLayout(fixtures.loadedCache);
  copyPayloadLayout(fixtures.codexCache);
  copyOpenCodeLayout(fixtures.opencodeSkills);
  if (withInstalledPlugins) writeInstalledPlugins(home, fixtures.loadedCache);
  return fixtures;
}

function sweep(fixtures) {
  return sweepContractDrift({
    env: {
      HOME: fixtures.home,
      CODEX_HOME: fixtures.codexHome,
      XDG_CONFIG_HOME: fixtures.xdgConfig,
    },
    vendorRoot: fixtures.vendorRoot,
    distRoot: fixtures.dist,
  });
}

/** One-byte mutation of a pinned file (append a drift marker line). */
function mutate(fixtureFile) {
  assert.ok(existsSync(fixtureFile), `mutation target missing: ${fixtureFile}`);
  writeFileSync(fixtureFile, readFileSync(fixtureFile, 'utf8') + '\n# drift\n');
}

const SHA256 = /^[0-9a-f]{64}$/;

function assertDriftOn(result, surfaceLabel) {
  assert.equal(result.ok, false, `${surfaceLabel}: mutated payload must flip ok`);
  assert.equal(result.exitCode !== 0, true, `${surfaceLabel}: exit must be non-zero on hard drift`);
  const surface = result.surfaces.find((s) => s.label === surfaceLabel);
  assert.ok(surface, `surface ${surfaceLabel} must be reported`);
  assert.equal(surface.status, 'drift', `${surfaceLabel}: status must be drift`);
  const finding = surface.findings.find((f) => f.path.endsWith(PROBE_FILE) || f.path.endsWith(NORTHSTAR_PROBE_FILE) || f.path.endsWith(V2_MANIFEST));
  assert.ok(finding, `${surfaceLabel}: a drift finding naming the mutated path must be present`);
  assert.match(finding.expected, SHA256, `${surfaceLabel}: expected hash must be a sha256 hex string`);
  assert.match(finding.actual, SHA256, `${surfaceLabel}: actual hash must be a sha256 hex string`);
  assert.notEqual(finding.expected, finding.actual, `${surfaceLabel}: expected != actual`);
  assert.ok(!finding.path.includes(join(root, 'vendor').slice(1)), `${surfaceLabel}: finding path must stay in the fixture tree`);
}

function assertFreshOk(result, { expectLoadedCache = true } = {}) {
  assert.equal(result.ok, true, `all-match sweep must be ok: ${JSON.stringify(result.surfaces.filter((s) => s.status !== 'ok'))}`);
  assert.equal(result.exitCode, 0, 'all-match sweep must exit 0');
  const labels = result.surfaces.map((s) => s.label);
  for (const label of [
    'vendor/skills',
    'dist/claude-plugin',
    'dist/codex-plugin',
    'dist/opencode-plugin',
    'marketplace ~/.claude/plugins/ai-catapult',
    'codex cache',
    'opencode skills',
  ]) {
    assert.ok(labels.includes(label), `surface ${label} must be reported; got ${JSON.stringify(labels)}`);
    const surface = result.surfaces.find((s) => s.label === label);
    assert.equal(surface.status, 'ok', `surface ${label} must be ok`);
  }
  const loaded = result.surfaces.find((s) => s.label === 'loaded cache');
  assert.ok(loaded, 'loaded cache surface must be reported');
  assert.equal(loaded.status, expectLoadedCache ? 'ok' : 'absent', `loaded cache expected ${expectLoadedCache ? 'ok' : 'absent'}`);
  assert.ok(loaded.findings.length === 0, 'loaded cache must carry no findings when fresh');
}

test('contract drift: all six surfaces byte-fresh from the same vendored pinned bytes are ok', () => {
  requireVendoredV2();
  const base = mkdtempSync(join(tmpdir(), 'contract-drift-ok-'));
  try {
    assertFreshOk(sweep(buildFixtures(base)));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('contract drift: loaded cache surface is absent (skipped) when installed_plugins.json carries no ai-catapult entry', () => {
  requireVendoredV2();
  const base = mkdtempSync(join(tmpdir(), 'contract-drift-absent-'));
  try {
    const fixtures = buildFixtures(base, { withInstalledPlugins: false });
    const result = sweep(fixtures);
    assertFreshOk(result, { expectLoadedCache: false });
    const loaded = result.surfaces.find((s) => s.label === 'loaded cache');
    assert.equal(loaded.status, 'absent');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('contract drift: one-byte mutation on the vendored surface fails naming path/expected/actual', () => {
  requireVendoredV2();
  const base = mkdtempSync(join(tmpdir(), 'contract-drift-vendor-'));
  try {
    const fixtures = buildFixtures(base);
    mutate(join(fixtures.vendorRoot, '04-validate-handoff/autobahn', PROBE_FILE));
    assertDriftOn(sweep(fixtures), 'vendor/skills');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('contract drift: one-byte mutation on a dist harness payload fails', () => {
  requireVendoredV2();
  const base = mkdtempSync(join(tmpdir(), 'contract-drift-dist-'));
  try {
    const fixtures = buildFixtures(base);
    mutate(join(fixtures.dist, 'claude-plugin', 'skills', 'autobahn', PROBE_FILE));
    assertDriftOn(sweep(fixtures), 'dist/claude-plugin');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('contract drift: one-byte mutation on the marketplace payload fails', () => {
  requireVendoredV2();
  const base = mkdtempSync(join(tmpdir(), 'contract-drift-market-'));
  try {
    const fixtures = buildFixtures(base);
    mutate(join(fixtures.marketplace, 'skills', 'autobahn', PROBE_FILE));
    assertDriftOn(sweep(fixtures), 'marketplace ~/.claude/plugins/ai-catapult');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('contract drift: one-byte mutation at the loaded-cache installPath fails and carries both refresh hints', () => {
  requireVendoredV2();
  const base = mkdtempSync(join(tmpdir(), 'contract-drift-loaded-'));
  try {
    const fixtures = buildFixtures(base);
    mutate(join(fixtures.loadedCache, 'skills', 'autobahn', PROBE_FILE));
    const result = sweep(fixtures);
    assertDriftOn(result, 'loaded cache');
    const loaded = result.surfaces.find((s) => s.label === 'loaded cache');
    assert.ok(
      loaded.refreshHints.includes('claude plugin marketplace update') &&
      loaded.refreshHints.includes('claude plugin update'),
      `loaded cache drift must carry both refresh commands; got ${JSON.stringify(loaded.refreshHints)}`,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('contract drift: one-byte mutation on the codex plugin cache fails', () => {
  requireVendoredV2();
  const base = mkdtempSync(join(tmpdir(), 'contract-drift-codex-'));
  try {
    const fixtures = buildFixtures(base);
    mutate(join(fixtures.codexCache, 'skills', 'autobahn', PROBE_FILE));
    assertDriftOn(sweep(fixtures), 'codex cache');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('contract drift: one-byte mutation in the opencode skills directory fails', () => {
  requireVendoredV2();
  const base = mkdtempSync(join(tmpdir(), 'contract-drift-opencode-'));
  try {
    const fixtures = buildFixtures(base);
    mutate(join(fixtures.opencodeSkills, 'autobahn', PROBE_FILE));
    assertDriftOn(sweep(fixtures), 'opencode skills');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('contract drift: a northstar-prefixed pinned file resolves against the northstar peer dir', () => {
  requireVendoredV2();
  const base = mkdtempSync(join(tmpdir(), 'contract-drift-nslane-'));
  try {
    // Fresh fixtures: proves approve.sh (pinned as northstar/approve.sh) is
    // actually hashed — mutating it must fail, which cannot happen if the
    // sweep resolved it against the autobahn dir (file absent) or skipped it.
    const fixtures = buildFixtures(base);
    mutate(join(fixtures.marketplace, 'skills', 'northstar', NORTHSTAR_PROBE_FILE));
    assertDriftOn(sweep(fixtures), 'marketplace ~/.claude/plugins/ai-catapult');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('contract drift: tampered northstar v2 manifest copy fails producer/consumer fingerprint parity', () => {
  requireVendoredV2();
  const base = mkdtempSync(join(tmpdir(), 'contract-drift-manifest-'));
  try {
    const fixtures = buildFixtures(base);
    const manifestPath = join(fixtures.marketplace, 'skills', 'northstar', V2_MANIFEST);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.files['northstar/approve.sh'] = '0'.repeat(64);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    const result = sweep(fixtures);
    const surface = result.surfaces.find((s) => s.label === 'marketplace ~/.claude/plugins/ai-catapult');
    assert.equal(surface.status, 'drift');
    const parity = surface.findings.find((f) => f.kind === 'manifest-parity');
    assert.ok(parity, `manifest-parity finding must be named; got ${JSON.stringify(surface.findings)}`);
    assert.ok(parity.path.endsWith(join('skills', 'northstar', V2_MANIFEST)) || parity.path.endsWith(V2_MANIFEST), `parity finding must name the manifest path; got ${parity.path}`);
    assert.equal(result.ok, false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});