import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const bin = join(root, 'bin/ai-catapult.js');

test('--version prints the version from package.json', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const stdout = execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).trim();
  assert.equal(stdout, pkg.version);
});

test('-v shorthand also prints the version', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const stdout = execFileSync(process.execPath, [bin, '-v'], { encoding: 'utf8' }).trim();
  assert.equal(stdout, pkg.version);
});

test('unknown argument exits with code 1', () => {
  const result = spawnSync(process.execPath, [bin, 'bogus'], { encoding: 'utf8' });
  assert.equal(result.status, 1, 'expected exit code 1 for unknown argument');
  assert.match(result.stderr, /Unknown argument: bogus/);
});

test('no arguments prints help and exits 0', () => {
  const stdout = execFileSync(process.execPath, [bin], { encoding: 'utf8' });
  assert.match(stdout, /Usage: ai-catapult/);
});
