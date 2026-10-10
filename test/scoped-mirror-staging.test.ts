/**
 * The scoped mirror (@r3dlex/ai-catapult) is staged into a temp dir containing
 * ONLY package.json's `files` entries. Historically `prepack` ran there, so any
 * script prepack invoked that was absent from `files` broke the scoped publish
 * while the unscoped publish — which runs from the repo root, where every
 * script exists — succeeded.
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
 * Deleting `prepack` from the staged package.json (the 127 closure) shifted the
 * invariant: the staged tree must be a complete built artifact that packs with
 * zero lifecycle scripts. The TS rename wave reopened a sibling hole through
 * `"prepack": "node scripts/setup.ts && npm run build"` — the static
 * prepack-vs-files checks only see literal scripts/* invocations, while the
 * build half (tsc, tsconfig.build.json, scripts/prepare-dist.ts) was never
 * staged — so the staged package.json must carry no lifecycle scripts at all,
 * and packing there must execute none.
 *
 * The staging loop in scripts/publish-both.ts swallows copy failures in a bare
 * `catch {}`, which is why no warning ever surfaced. These tests are the
 * warning.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stageScopedPackage } from '../scripts/publish-both.ts';

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

void test('the staged scoped artifact packs on its own — no lifecycle prerequisites', () => {
  // Real scoped-pack regression (review round 1, F3): the static prepack checks
  // above only see literal scripts/* invocations, so "prepack": "node
  // scripts/setup.ts && npm run build" passed them while the build half (tsc,
  // tsconfig.build.json, scripts/prepare-dist.ts) was not staged — npm pack in
  // the staged directory died in prepack (v0.2.0's 127 through a new hole), or
  // worse, silently rebuilt from a half-staged tree. The staged mirror must be
  // a complete built artifact: its package.json carries NO lifecycle scripts,
  // and npm pack there needs nothing but the staged bytes.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ai-catapult-scoped-pack-')));
  try {
    stageScopedPackage(root, dir);
    const stagedPkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const stagedLifecycle = Object.keys(stagedPkg.scripts ?? {}).filter((name) =>
      /^(pre|post)?(pack|publish|install|test).*$/.test(name),
    );
    assert.deepEqual(
      stagedLifecycle,
      [],
      `staged scoped package.json still carries lifecycle scripts ${stagedLifecycle.join(', ')} — ` +
        'the staged tree must pack as a complete artifact without rebuilding',
    );

    // Real pack WITHOUT --ignore-scripts: any surviving lifecycle executes here.
    const packed = spawnSync('npm', ['pack', '--json', '--foreground-scripts=false'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(
      packed.status,
      0,
      `npm pack inside the staged scoped package failed (status ${packed.status}):\n${packed.stderr || packed.stdout}`,
    );
    const entries = JSON.parse(packed.stdout) as Array<{ filename: string }>;
    assert.equal(entries.length, 1, `expected one tarball from the staged scope, got ${entries.length}`);
    const listing = spawnSync('tar', ['-tf', join(dir, entries[0]!.filename)], { encoding: 'utf8' });
    assert.equal(listing.status, 0, `tar listing failed: ${listing.stderr}`);
    const files = listing.stdout.split('\n');
    assert.ok(
      files.some((f) => f.endsWith('dist/bin/ai-catapult.js')),
      'staged scoped tarball does not ship the compiled bin dist/bin/ai-catapult.js',
    );
    assert.ok(
      files.some((f) => f.endsWith('skills.lock.json')),
      'staged scoped tarball does not ship skills.lock.json',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
