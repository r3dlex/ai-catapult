/**
 * TDD tests for Slice 7 — npm pack readiness.
 *
 * Verifies the tarball file list produced by `npm pack --dry-run`:
 *   - MUST include: bin/ai-catapult.js, src/scaffold.js, src/install.js,
 *                   setup.sh, skills.lock.json
 *   - MUST NOT include: anything under test/, vendor/, or dist/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function getPackFileList() {
  const r = spawnSync('npm', ['pack', '--dry-run'], {
    encoding: 'utf8',
    cwd: root,
  });

  assert.equal(r.status, 0, `npm pack --dry-run failed:\n${r.stderr}`);

  // npm notice lines go to stderr; extract "npm notice NNNkB <path>" lines
  const output = r.stderr + r.stdout;
  const files = [];
  for (const line of output.split('\n')) {
    const m = line.match(/npm notice\s+[\d.]+\w+\s+(.+)/);
    if (m) {
      files.push(m[1].trim());
    }
  }
  return files;
}

test('npm pack: includes bin/ai-catapult.js', () => {
  const files = getPackFileList();
  assert.ok(
    files.some((f) => f === 'bin/ai-catapult.js'),
    `Expected bin/ai-catapult.js in pack list\nActual: ${files.join(', ')}`,
  );
});

test('npm pack: includes src/scaffold.js', () => {
  const files = getPackFileList();
  assert.ok(
    files.some((f) => f === 'src/scaffold.js'),
    `Expected src/scaffold.js in pack list\nActual: ${files.join(', ')}`,
  );
});

test('npm pack: includes src/install.js', () => {
  const files = getPackFileList();
  assert.ok(
    files.some((f) => f === 'src/install.js'),
    `Expected src/install.js in pack list\nActual: ${files.join(', ')}`,
  );
});

test('npm pack: includes setup.sh', () => {
  const files = getPackFileList();
  assert.ok(
    files.some((f) => f === 'setup.sh'),
    `Expected setup.sh in pack list\nActual: ${files.join(', ')}`,
  );
});

test('npm pack: includes skills.lock.json', () => {
  const files = getPackFileList();
  assert.ok(
    files.some((f) => f === 'skills.lock.json'),
    `Expected skills.lock.json in pack list\nActual: ${files.join(', ')}`,
  );
});

test('npm pack: does NOT include anything under test/', () => {
  const files = getPackFileList();
  const testFiles = files.filter((f) => f.startsWith('test/'));
  assert.equal(
    testFiles.length, 0,
    `Pack must not include test/ files\nFound: ${testFiles.join(', ')}`,
  );
});

test('npm pack: does NOT include anything under vendor/', () => {
  const files = getPackFileList();
  const vendorFiles = files.filter((f) => f.startsWith('vendor/'));
  assert.equal(
    vendorFiles.length, 0,
    `Pack must not include vendor/ files\nFound: ${vendorFiles.join(', ')}`,
  );
});

test('npm pack: does NOT include anything under dist/', () => {
  const files = getPackFileList();
  const distFiles = files.filter((f) => f.startsWith('dist/'));
  assert.equal(
    distFiles.length, 0,
    `Pack must not include dist/ files\nFound: ${distFiles.join(', ')}`,
  );
});
