import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function fixture(callback) {
  const dir = mkdtempSync(join(tmpdir(), 'publish-recovery-'));
  try {
    for (const rel of ['scripts', 'bin', 'dist/claude-plugin/.claude-plugin', 'dist/codex-plugin/.codex-plugin']) mkdirSync(join(dir, rel), { recursive: true });
    copyFileSync(join(root, 'scripts/publish-both.sh'), join(dir, 'scripts/publish-both.sh'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'ai-catapult', version: '1.2.3', files: ['dist/'] }));
    for (const host of ['claude', 'codex']) writeFileSync(join(dir, `dist/${host}-plugin/.${host}-plugin/plugin.json`), '{}');
    const log = join(dir, 'calls.jsonl');
    writeFileSync(log, '');
    const npm = join(dir, 'bin/npm');
    writeFileSync(npm, `#!${process.execPath}\nconst fs = require('node:fs');\nconst pkg = JSON.parse(fs.readFileSync('package.json'));\nif (process.argv[2] === 'pack') { const path = require('node:path'); const dest = process.argv[process.argv.indexOf('--pack-destination') + 1]; fs.mkdirSync(path.join(dest, 'package')); fs.writeFileSync(path.join(dest, 'package/package.json'), JSON.stringify(pkg)); require('node:child_process').execFileSync('tar', ['-czf', path.join(dest, 'package.tgz'), '-C', dest, 'package']); const integrity = 'sha512-' + require('node:crypto').createHash('sha512').update(fs.readFileSync(path.join(dest, 'package.tgz'))).digest('base64'); console.log(JSON.stringify([{name:pkg.name, version:pkg.version, filename:'package.tgz', integrity}])); process.exit(0); }\nif (process.argv[2] === 'view') { console.log(JSON.stringify({error:{code:'E404'}})); process.exit(1); }\nfs.appendFileSync(process.env.PUBLISH_TEST_LOG, JSON.stringify({ name: pkg.name, args: process.argv.slice(2) }) + '\\n');\nif (process.env.PUBLISH_TEST_FAIL === pkg.name) { console.error('ENEEDAUTH'); process.exit(1); }\n`);
    chmodSync(npm, 0o755);
    const run = (args = [], extra = {}) => spawnSync('bash', ['scripts/publish-both.sh', ...args], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, AI_CATAPULT_PUBLISH: '', CI: '', NPM_PROVENANCE: '', PUBLISH_TEST_LOG: log, ...extra },
    });
    const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    callback({ run, calls });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('partial scoped failure can retry only that exact package without republishing primary', () => fixture(({ run, calls }) => {
  const failed = run(['--yes'], { AI_CATAPULT_PUBLISH: '1', CI: 'true', PUBLISH_TEST_FAIL: '@r3dlex/ai-catapult' });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /ENEEDAUTH/);
  assert.deepEqual(calls().map((c) => c.name), ['ai-catapult', '@r3dlex/ai-catapult']);
  const recovered = run(['--yes', '--package', '@r3dlex/ai-catapult'], { AI_CATAPULT_PUBLISH: '1', CI: 'true' });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.deepEqual(calls().map((c) => c.name), ['ai-catapult', '@r3dlex/ai-catapult', '@r3dlex/ai-catapult']);
  assert.ok(calls().every((c) => c.args.includes('--provenance')));
  assert.match(recovered.stdout, /Publication complete: @r3dlex\/ai-catapult@1\.2\.3/);
  assert.doesNotMatch(recovered.stdout, /Publication complete: ai-catapult@/);
}));

test('package selection stays dry-run by default and preserves both default', () => fixture(({ run, calls }) => {
  assert.equal(run().status, 0);
  assert.deepEqual(calls().map((c) => c.name), ['ai-catapult', '@r3dlex/ai-catapult']);
  assert.equal(run(['--package', 'ai-catapult'], { AI_CATAPULT_PUBLISH: '1' }).status, 0);
  assert.deepEqual(calls().map((c) => c.name), ['ai-catapult', '@r3dlex/ai-catapult', 'ai-catapult']);
  assert.ok(calls().every((c) => c.args.includes('--dry-run')));
}));

test('recovery cannot bypass authorization, invalid selectors or publisher failures', () => fixture(({ run, calls }) => {
  for (const args of [['--yes', '--package', '@r3dlex/ai-catapult'], ['--package'], ['--package', 'foreign'], ['--package', 'ai-catapult', '--package', '@r3dlex/ai-catapult'], ['--yes', '--yes'], ['--package', 'ai-catapult', 'extra']]) {
    const rejected = run(args);
    assert.notEqual(rejected.status, 0, args.join(' '));
    assert.doesNotMatch(rejected.stdout, /Building|Version:|Publishing|staged/);
  }
  assert.deepEqual(calls(), []);
  const failed = run(['--yes', '--package', '@r3dlex/ai-catapult'], { AI_CATAPULT_PUBLISH: '1', CI: 'true', PUBLISH_TEST_FAIL: '@r3dlex/ai-catapult' });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /ENEEDAUTH/);
  assert.doesNotMatch(failed.stdout, /Publication complete/);
}));
