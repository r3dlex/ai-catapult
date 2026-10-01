import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, process.env.AI_CATAPULT_DIST_ROOT || 'dist-snapshot');
const source = join(root, 'vendor/skills/04-validate-handoff/autobahn/engine-pick.sh');

for (const host of ['claude', 'codex', 'opencode']) {
  const helper = join(dist, `${host}-plugin/skills/autobahn/engine-pick.sh`);
  const run = (...args) => spawnSync('bash', [helper, ...args], {
    encoding: 'utf8', timeout: 2000,
  });
  function rejected(...args) {
    const result = run(...args);
    assert.equal(result.error, undefined, 'input validation must terminate without a timeout');
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '', 'invalid input must not select an engine');
    assert.ok(result.stderr.trim(), 'invalid input must explain rejection');
  }

  test(`${host}: shipped engine picker matches canonical source`, () => {
    assert.deepEqual(readFileSync(helper), readFileSync(source));
  });

  test(`${host}: missing option values fail promptly without selecting an engine`, () => {
    for (const option of ['--goal', '--engine', '--qa-heavy', '--parallelizable', '--needs-persistence', '--kind']) {
      rejected(option);
      rejected(option, '');
      rejected(option, '--engine', 'team');
    }
  });

  test(`${host}: invalid supplied goals cannot be rescued by an engine override`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'autobahn-startup-'));
    const goal = join(directory, 'goal.json');
    try {
      for (const content of ['[]', 'null', 'true', '42', '"qa"', '{', Buffer.from([0xff])]) {
        writeFileSync(goal, content);
        rejected('--goal', goal);
        rejected('--goal', goal, '--engine', 'team');
      }
      rmSync(goal);
      rejected('--goal', goal, '--engine', 'team');
      rejected('--goal', directory, '--engine', 'team');
      writeFileSync(goal, JSON.stringify({ qa_heavy: true }));
      const automatic = run('--goal', goal);
      assert.equal(automatic.status, 0, automatic.stderr);
      assert.equal(automatic.stdout, 'ultraqa\n');
      const override = run('--goal', goal, '--engine', 'team');
      assert.equal(override.status, 0, override.stderr);
      assert.equal(override.stdout, 'team\n');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
