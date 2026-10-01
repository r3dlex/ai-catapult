/**
 * SSCM-09 commit 3: ai-catapult grep-gate half.
 *
 * The vendored dead_reference gate's allowlists are skills-root-relative, so
 * ai-catapult gets its own corpus gate (scripts/check-dead-refs.sh) over the
 * ai-catapult tree with vendor-snapshot exclusions. This test asserts the
 * gate passes and stays mutation-sensitive (a live injected reference fails).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const gate = join(root, 'scripts/check-dead-refs.sh');

function run() {
  return spawnSync('bash', [gate], { encoding: 'utf8' });
}

test('grep-gate passes on the clean tree (all matches excluded)', () => {
  const out = run();
  assert.equal(out.status, 0, `gate should pass: ${out.stdout}\n${out.stderr}`);
  assert.match(out.stdout, /check-dead-refs: PASSED/);
  assert.match(out.stdout, /all excluded/);
});

test('grep-gate is mutation-sensitive: injected live reference fails it', () => {
  const readme = join(root, 'README.md');
  const original = readFileSync(readme, 'utf8');
  try {
    appendFileSync(readme, '\nuse `ubiquitous-language` here\n');
    const out = run();
    assert.notEqual(out.status, 0, 'injected live reference must fail the gate');
    assert.match(out.stdout + out.stderr, /VIOLATION.*ubiquitous-language/);
  } finally {
    writeFileSync(readme, original);
  }
});
