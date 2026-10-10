import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path: string): unknown => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const version = (read('package.json') as { version: string }).version;

void test('startup repair is delivered under a version newer than published 0.4.2', () => {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
  assert.ok(major > 0 || minor > 4 || (minor === 4 && patch >= 3),
    `startup repair must not reuse published 0.4.2; got ${version}`);
});

for (const root of ['dist', 'dist-snapshot']) {
  for (const host of ['claude', 'codex', 'opencode']) {
    void test(`${root} ${host} manifest matches package version`, () => {
      assert.equal((read(`${root}/${host}-plugin/.${host}-plugin/plugin.json`) as { version: string }).version, version);
    });
  }
  void test(`${root} Claude marketplace versions match package version`, () => {
    const marketplace = read(`${root}/claude-plugin/.claude-plugin/marketplace.json`) as {
      version: string;
      plugins: Array<{ name: string; version: string }>;
    };
    assert.equal(marketplace.version, version);
    assert.equal(marketplace.plugins.find((plugin) => plugin.name === 'ai-catapult')?.version, version);
  });
}
