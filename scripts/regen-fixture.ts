#!/usr/bin/env node
// regen-fixture.ts — regenerate test/fixtures/init-standalone/ from the
// vendored templates using the canonical fixed inputs.
//
// Run this whenever a template changes (e.g. after a vendor bump) and commit
// the updated fixture together with the lockfile/template change in the same PR.
// The parity test in test/init.test.ts will then byte-diff `ai-catapult init`
// output against this regenerated fixture.
//
// Fixed canonical inputs (must match FIXED_ARGS in test/init.test.ts):
//   --repo-id       example-repo
//   --date          2026-01-01
//   --upstream-url  https://github.com/example-org/example-repo.git
//   --upstream-ref  main
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleDir, packageRoot } from '../src/paths.ts';

const REPO_ROOT = packageRoot(moduleDir(import.meta.url));
const FIXTURE_DIR = join(REPO_ROOT, 'test/fixtures/init-standalone');
const CLI = join(REPO_ROOT, 'bin/ai-catapult.ts');

export function run(): void {
  console.log(`Regenerating fixture at ${FIXTURE_DIR} ...`);

  // Wipe and recreate so stale files from previous runs don't linger
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURE_DIR, { recursive: true });

  const result = spawnSync(
    process.execPath,
    [
      CLI,
      'init',
      FIXTURE_DIR,
      '--repo-id',
      'example-repo',
      '--date',
      '2026-01-01',
      '--upstream-url',
      'https://github.com/example-org/example-repo.git',
      '--upstream-ref',
      'main',
    ],
    { stdio: 'inherit' },
  );
  if (result.error ?? result.status !== 0) process.exit(result.status ?? 1);

  console.log('OK: fixture regenerated. Commit test/fixtures/init-standalone/ together');
  console.log('    with any lockfile/template changes in the same PR.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run();