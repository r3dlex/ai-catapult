/**
 * Publisher preflight verifies an existing exact immutable artifact whose
 * npmjs package/version/payload independently matches the locally packed bytes.
 * Stubbed npm commands exercise both package names without network or writes.
 */
import { test } from 'node:test';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, writeFileSync, mkdirSync, chmodSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const script = join(root, 'scripts', 'publish-both.ts');

const CANNOT_PUBLISH =
  JSON.stringify({ error: { code: 'EPUBLISHCONFLICT', summary: 'You cannot publish over the previously published versions: 9.9.9.' } });
const ENEEDAUTH =
  'npm error code ENEEDAUTH\nnpm error need auth This command requires you to be logged in.';

const NPM_STUB = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const pkg = require(process.cwd() + '/package.json');
const args = process.argv.slice(2);
const integrityFile = '.test-integrity';
if (args[0] === 'pack') {
  const dest = args[args.indexOf('--pack-destination') + 1];
  fs.mkdirSync(path.join(dest, 'package'));
  fs.writeFileSync(path.join(dest, 'package/package.json'), JSON.stringify({...pkg, name:process.env.PB_ARCHIVE_NAME || pkg.name}));
  require('node:child_process').execFileSync('tar', ['-czf', path.join(dest, 'package.tgz'), '-C', dest, 'package']);
  const integrity = 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(path.join(dest, 'package.tgz'))).digest('base64');
  fs.writeFileSync(integrityFile, integrity);
  console.log(JSON.stringify([{name:pkg.name, version:pkg.version, filename:'package.tgz', integrity}]));
} else if (args[0] === 'view') {
  if (process.env.PB_VIEW_MALFORMED) { console.log('not json'); process.exit(0); }
  if (process.env.PB_VIEW_ERROR) { console.log(JSON.stringify({error:{code:process.env.PB_VIEW_ERROR}})); process.exit(1); }
  if (process.env.PB_EXISTING === pkg.name) console.log(JSON.stringify({name:process.env.PB_NAME || pkg.name, version:process.env.PB_VERSION || pkg.version, 'dist.integrity':process.env.PB_INTEGRITY || fs.readFileSync(integrityFile, 'utf8')}));
  else { console.log(JSON.stringify({error:{code:'E404'}})); process.exit(1); }
} else if (args[0] === 'publish') {
  if (!args.includes('--@r3dlex:registry=https://registry.npmjs.org') || !args.includes('--registry=https://registry.npmjs.org') || 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(args[1])).digest('base64') !== fs.readFileSync(integrityFile, 'utf8')) process.exit(42);
  const file = process.env.PB_CALLS_FILE;
  const n = (fs.existsSync(file) ? Number(fs.readFileSync(file)) : 0) + 1;
  fs.writeFileSync(file, String(n));
  const error = path.join(process.env.PB_ERROR_DIR, 'error-' + n);
  if (fs.existsSync(error)) { console.log(fs.readFileSync(error, 'utf8')); process.exit(Number(process.env.PB_EXIT || 1)); }
  console.log(pkg.name + ' published (stub)');
} else process.exit(43);
`;

type SandboxOptions = { call1?: string; call2?: string };

/** Build a sandbox tree and configure per-call npm stub failures. */
function sandbox({ call1, call2 }: SandboxOptions = {}): string {
  // realpathSync: the sandboxed publish-both.ts guards its entry with
  // `process.argv[1] === fileURLToPath(import.meta.url)`, which requires the
  // path we spawn with to match the module URL verbatim. macOS tmpdir()
  // (/var/folders → /private/var/folders) would otherwise silently skip run().
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'publish-both-test-')));
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'err'));
  mkdirSync(join(dir, 'dist', 'claude-plugin', '.claude-plugin'), { recursive: true });
  mkdirSync(join(dir, 'dist', 'codex-plugin', '.codex-plugin'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'claude-plugin', '.claude-plugin', 'plugin.json'), '{}');
  writeFileSync(join(dir, 'dist', 'codex-plugin', '.codex-plugin', 'plugin.json'), '{}');
  cpSync(script, join(dir, 'scripts', 'publish-both.ts'));
  // publish-both.ts imports the shared path helpers; ship them in the staged tree.
  cpSync(join(root, 'src', 'paths.ts'), join(dir, 'src', 'paths.ts'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'ai-catapult',
    version: '9.9.9',
    files: [],
    scripts: {},
  }));
  if (call1 !== undefined) writeFileSync(join(dir, 'err', 'error-1'), call1);
  if (call2 !== undefined) writeFileSync(join(dir, 'err', 'error-2'), call2);
  writeFileSync(join(dir, 'bin', 'npm'), NPM_STUB);
  chmodSync(join(dir, 'bin', 'npm'), 0o755);
  writeFileSync(join(dir, 'bin', 'node'), `#!/usr/bin/env bash
# PATH stub for the staged tree: delegate to the real interpreter. No
# publish-both code path needs a child node any longer, but the npm stub's
# environment keeps a usable node on PATH.
exec "${process.execPath}" "$@"
`);
  chmodSync(join(dir, 'bin', 'node'), 0o755);
  return dir;
}

/** Run the sandboxed publish-both.ts in real mode (--yes). */
function run(dir: string, extra: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [join(dir, 'scripts', 'publish-both.ts'), '--yes'], {
    encoding: 'utf8',
    cwd: dir,
    env: {
      ...process.env,
      AI_CATAPULT_PUBLISH: '1',
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      PB_CALLS_FILE: join(dir, 'calls'),
      PB_ERROR_DIR: join(dir, 'err'),
      ...extra,
    },
  });
}

void test('double gate: --yes without AI_CATAPULT_PUBLISH=1 refuses', () => {
  const dir = sandbox();
  const r = spawnSync(process.execPath, [join(dir, 'scripts', 'publish-both.ts'), '--yes'], {
    encoding: 'utf8',
    cwd: dir,
    env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--yes requires AI_CATAPULT_PUBLISH=1/);
});

void test('rerun tolerance: unscoped already-published continues to scoped attempt', () => {
  const dir = sandbox();
  const r = run(dir, { PB_EXISTING: 'ai-catapult' });
  assert.equal(readFileSync(join(dir, 'calls'), 'utf8'), '1');
  assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /--- \[1\/2\] Publishing ai-catapult \(unscoped\) ---/);
  assert.match(r.stdout, /ai-catapult@9\.9\.9 already published/);
  assert.match(r.stdout, /--- \[2\/2\] Publishing @r3dlex\/ai-catapult \(scoped mirror\) ---/);
  assert.match(r.stdout, /Publication complete: ai-catapult@9\.9\.9 and @r3dlex\/ai-catapult@9\.9\.9/);
});

void test('unscoped ENEEDAUTH still aborts', () => {
  const dir = sandbox({ call1: ENEEDAUTH });
  const r = run(dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ENEEDAUTH/);
});

void test('scoped already-published tolerated (exit 0)', () => {
  const dir = sandbox();
  const r = run(dir, { PB_EXISTING: '@r3dlex/ai-catapult' });
  assert.equal(readFileSync(join(dir, 'calls'), 'utf8'), '1');
  assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /@r3dlex\/ai-catapult@9\.9\.9 already published/);
  assert.match(r.stdout, /Publication complete: ai-catapult@9\.9\.9 and @r3dlex\/ai-catapult@9\.9\.9/);
});

void test('scoped ENEEDAUTH still aborts', () => {
  const dir = sandbox({ call2: ENEEDAUTH });
  const r = run(dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ENEEDAUTH/);
});

const RETRY_REJECTION_CASES: Array<[string, string, Record<string, string>]> = [
  ['mixed ENEEDAUTH notice', ENEEDAUTH + '\n' + CANNOT_PUBLISH, {}],
  ['structured auth with unrelated duplicate notice', JSON.stringify({ error: { code: 'ENEEDAUTH', summary: 'previously published versions' } }), {}],
  ['wrong registry package', CANNOT_PUBLISH, { PB_NAME: 'foreign' }],
  ['wrong registry version', CANNOT_PUBLISH, { PB_VERSION: '8.8.8' }],
  ['registry content mismatch', CANNOT_PUBLISH, { PB_INTEGRITY: 'sha512-OTHER' }],
];

for (const [label, failure, extra] of RETRY_REJECTION_CASES) {
  void test(`retry rejects ${label}`, () => {
    const r = run(sandbox({ call1: failure }), {
      ...(label.startsWith('wrong registry') || label === 'registry content mismatch' ? { PB_EXISTING: 'ai-catapult' } : {}),
      ...extra,
    });
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.stdout, /Publication complete: ai-catapult@/);
    assert.match(r.stderr, /previously published versions|registry identity or payload integrity mismatch/);
  });
}

for (const code of ['ENEEDAUTH', 'E403', 'E503']) {
  void test(`registry preflight rejects ${code}`, () => {
    const r = run(sandbox(), { PB_VIEW_ERROR: code });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, new RegExp(code));
    assert.doesNotMatch(r.stdout, /Publication complete/);
  });
}
void test('actual duplicate publish failure is never converted into success', () => {
  const r = run(sandbox({ call1: CANNOT_PUBLISH }));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /EPUBLISHCONFLICT/);
});

void test('packed archive identity cannot diverge from requested package', () => {
  const r = run(sandbox(), { PB_ARCHIVE_NAME: 'foreign' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /packed archive identity mismatch/);
});

void test('registry malformed metadata fails before publishing', () => {
  const dir = sandbox();
  const r = run(dir, { PB_VIEW_MALFORMED: '1' });
  assert.notEqual(r.status, 0);
  assert.equal(existsSync(join(dir, 'calls')), false);
});
void test('actual publisher failure preserves its exit status and diagnostics', () => {
  const r = run(sandbox({ call1: ENEEDAUTH }), { PB_EXIT: '42' });
  assert.equal(r.status, 42);
  assert.match(r.stderr, /ENEEDAUTH/);
});