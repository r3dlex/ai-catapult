import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = '0.4.4';
const SURFACES = [
  'dist/claude-plugin/.claude-plugin/plugin.json',
  'dist/codex-plugin/.codex-plugin/plugin.json',
  'dist/opencode-plugin/.opencode-plugin/plugin.json',
];
const HOSTS = ['claude-plugin', 'codex-plugin'];
const PEERS = {
  autobahn: '04-validate-handoff/autobahn',
  northstar: '02-govern-plan/northstar',
};

type Versioned = { version?: string };
type Marketplace = { version?: string; plugins?: Array<{ name?: string; version?: string }> };
type Baseline = { packages?: Record<string, string> };
type LockedManifest = { schema?: string; files?: Record<string, string> };
type PackReport = { filename?: string };

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function packageVersion(): string {
  return (readJson(join(repo, 'package.json')) as Versioned).version ?? '';
}

function compareSemver(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function assertVersion(path: string, version: string, label: string): void {
  assert.equal((readJson(path) as Versioned).version, version, label);
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function stageForPack(stage: string): void {
  mkdirSync(stage);
  const pkg = readJson(join(repo, 'package.json')) as { files?: string[] };
  for (const path of ['package.json', ...(pkg.files ?? [])]) {
    const source = join(repo, path);
    if (existsSync(source)) cpSync(source, join(stage, path), { recursive: true });
  }
  const manifest = readJson(join(stage, 'package.json')) as { scripts?: Record<string, string> };
  if (manifest.scripts) {
    delete manifest.scripts.prepack;
    delete manifest.scripts.prepare;
  }
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

function lockedBytes(pathInLock: string): Buffer {
  const lock = readJson(join(repo, 'skills.lock.json')) as { sha?: string };
  const result = spawnSync('git', ['-C', join(repo, 'vendor/skills'), 'cat-file', 'blob', `${lock.sha}:${pathInLock}`], {
    maxBuffer: 10 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `locked source ${pathInLock} unreadable: ${result.stderr.toString()}`);
  return result.stdout;
}

function flatSkill(key: string): string {
  return key.startsWith('northstar/')
    ? join('skills', 'northstar', key.slice('northstar/'.length))
    : join('skills', 'autobahn', key);
}

function lockPath(key: string): string {
  return key.startsWith('northstar/')
    ? `${PEERS.northstar}/${key.slice('northstar/'.length)}`
    : `${PEERS.autobahn}/${key}`;
}

function assertPinnedV2(extracted: string): void {
  const manifestPath = join(repo, 'vendor/skills', PEERS.autobahn, 'readiness-dependency-v2.json');
  const manifest = readJson(manifestPath) as LockedManifest;
  const files = manifest.files ?? {};
  assert.equal(manifest.schema, 'readiness-contract/2');
  assert.ok(files['northstar/approve.sh'], 'v2 manifest must pin northstar/approve.sh');
  for (const harness of HOSTS) {
    const packedManifest = join(extracted, 'dist', harness, 'skills/autobahn/readiness-dependency-v2.json');
    assert.deepEqual(readFileSync(packedManifest), readFileSync(manifestPath), `${harness} v2 manifest`);
    for (const key of Object.keys(files)) {
      assert.deepEqual(readFileSync(join(extracted, 'dist', harness, flatSkill(key))), lockedBytes(lockPath(key)), `${harness} ${key}`);
    }
  }
}

function assertPackedVersion(extracted: string, version: string): void {
  assertVersion(join(extracted, 'package.json'), version, 'tarball package.json');
  for (const surface of SURFACES) assertVersion(join(extracted, surface), version, `tarball ${surface}`);
  const marketplace = readJson(join(extracted, 'dist/claude-plugin/.claude-plugin/marketplace.json')) as Marketplace;
  assert.equal(marketplace.version, version, 'tarball marketplace.json');
  assert.equal(marketplace.plugins?.find((plugin) => plugin.name === 'ai-catapult')?.version, version, 'tarball marketplace plugin');
}

void test('package version is 0.4.4 and newer than both recorded npm latest baselines', () => {
  const version = packageVersion();
  const baseline = readJson(join(repo, '.ai/evidence/release-0.4.4.json')) as Baseline;
  assert.equal(version, RELEASE, `package.json must be the unpublished ${RELEASE}`);
  for (const name of ['ai-catapult', '@r3dlex/ai-catapult']) {
    const latest = baseline.packages?.[name];
    assert.equal(typeof latest, 'string', `recorded npm latest missing for ${name}`);
    assert.ok(compareSemver(version, latest ?? '') > 0, `${version} must be greater than recorded ${name}@${latest}`);
  }
});

void test('generated claude, codex and opencode manifests agree on the package version', () => {
  const version = packageVersion();
  for (const surface of SURFACES) assertVersion(join(repo, surface), version, surface);
  const marketplace = readJson(join(repo, 'dist/claude-plugin/.claude-plugin/marketplace.json')) as Marketplace;
  assert.equal(marketplace.version, version, 'marketplace.json');
  assert.equal(marketplace.plugins?.find((plugin) => plugin.name === 'ai-catapult')?.version, version, 'marketplace plugin');
});

void test('packed tarball agrees on the package version and carries the pinned v2 contract files', () => {
  const version = packageVersion();
  const temp = mkdtempSync(join(tmpdir(), 'release-044-pack-'));
  try {
    const stage = join(temp, 'stage');
    stageForPack(stage);
    const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], stage)) as PackReport[];
    const tarballName = packed[0]?.filename;
    assert.ok(tarballName, 'npm pack must report a tarball filename');
    assert.equal(tarballName, `ai-catapult-${version}.tgz`);
    run('tar', ['-xzf', join(temp, tarballName), '-C', temp], temp);
    const extracted = join(temp, 'package');
    assertPackedVersion(extracted, version);
    assertPinnedV2(extracted);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
