/**
 * The scoped mirror (@r3dlex/ai-catapult) is staged into a temp dir containing
 * ONLY package.json's `files` entries, and `prepack` then runs there. So any
 * script prepack invokes that is absent from `files` breaks the scoped publish
 * while the unscoped publish — which runs from the repo root, where every script
 * exists — succeeds.
 *
 * That is exactly what happened on v0.2.0:
 *
 *   bash: scripts/stage-readme-contract.sh: No such file or directory
 *   npm error code 127
 *
 * `ai-catapult@0.2.0` published; `@r3dlex/ai-catapult@0.2.0` did not. The script
 * was added 2026-07-14, two days after v0.1.3 was tagged, so v0.2.0 was the
 * first release that could have hit it — the bug sat latent and untestable for
 * a month because nothing compared `prepack` against `files`.
 *
 * The staging loop in scripts/publish-both.ts swallows copy failures in a bare
 * `catch {}`, which is why no warning ever surfaced. These tests are the
 * warning.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  files?: string[];
  scripts?: Record<string, string>;
};

/** Every `scripts/*` path that a lifecycle script shells out to. */
function invokedScripts(script?: string): string[] {
  const matches = [...(script ?? '').matchAll(/scripts\/[\w.-]+\.(?:sh|js|ts)/g)].map((m) => m[0]);
  return matches.filter((m): m is string => m !== undefined);
}

void test('every script prepack invokes is listed in package.json files', () => {
  const invoked = invokedScripts(pkg.scripts?.prepack);
  assert.ok(invoked.length > 0, 'prepack should invoke at least one script');

  const declared = new Set(pkg.files ?? []);
  const missing = invoked.filter((s) => !declared.has(s));

  assert.deepEqual(
    missing, [],
    `prepack invokes scripts absent from files[], so the scoped mirror cannot build:\n  ${missing.join('\n  ')}`,
  );
});

void test('the scoped staging set contains every script prepack needs', () => {
  // Model publish-both.sh: the scoped package sees only `files`. A prepack
  // dependency reachable at the repo root but not in that set is invisible there.
  const staged = new Set(pkg.files ?? []);
  for (const script of invokedScripts(pkg.scripts?.prepack)) {
    assert.ok(
      staged.has(script),
      `${script} is not staged for the scoped mirror — publish would exit 127`,
    );
    assert.ok(
      existsSync(join(root, script)),
      `${script} is declared but does not exist in the repo`,
    );
  }
});

void test('every declared files entry exists', () => {
  // publish-both.sh skips missing entries silently, so a stale path in files[]
  // never surfaces — it just quietly does not ship.
  const missing = (pkg.files ?? []).filter((rel) => !existsSync(join(root, rel)));
  assert.deepEqual(missing, [], `files[] names paths that do not exist:\n  ${missing.join('\n  ')}`);
});
