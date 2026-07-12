import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const workflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');

test('release workflow pins the Node 20-compatible trusted-publishing npm version', () => {
  assert.match(workflow, /npm install -g npm@11\.5\.1/);
  assert.doesNotMatch(workflow, /npm@latest/);
});
