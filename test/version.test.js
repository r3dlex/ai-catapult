import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

test('--version prints the version from package.json', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const stdout = execSync(`node ${join(root, 'bin/ai-catapult.js')} --version`, {
    encoding: 'utf8',
  }).trim();
  assert.equal(stdout, pkg.version);
});

test('-v shorthand also prints the version', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const stdout = execSync(`node ${join(root, 'bin/ai-catapult.js')} -v`, {
    encoding: 'utf8',
  }).trim();
  assert.equal(stdout, pkg.version);
});
