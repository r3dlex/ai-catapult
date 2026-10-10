#!/usr/bin/env node
// verify-vendor.ts — non-mutating gate that checks vendor/skills integrity.
// Exits non-zero (fail closed) if:
//   - vendor/skills directory is absent
//   - vendor/skills/HEAD_SHA does not match the SHA in skills.lock.json
//
// Accepts VENDOR_ROOT env override (used by tests to avoid touching real vendor/).
// Never modifies any files. (Replaces the former scripts/verify-vendor.sh.)
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleDir, packageRoot } from '../src/paths.ts';

const REPO_ROOT = packageRoot(moduleDir(import.meta.url));

// Reads the locked SHA from skills.lock.json. This file trusts the HEAD_SHA
// sentinel written by setup.ts — it stays non-mutating and offline rather than
// re-deriving the SHA via git.
function lockedSha(): string {
  const lockFile = join(REPO_ROOT, 'skills.lock.json');
  if (!existsSync(lockFile)) {
    process.stderr.write(`ERROR: lockfile not found: ${lockFile}\n`);
    process.exit(1);
  }
  const lock = JSON.parse(readFileSync(lockFile, 'utf8')) as { sha?: unknown };
  const sha = typeof lock.sha === 'string' ? lock.sha : '';
  if (sha.length === 0) {
    process.stderr.write(`ERROR: could not read .sha from ${lockFile}\n`);
    process.exit(1);
  }
  return sha;
}

function run(): void {
  const sha = lockedSha();
  const vendorRoot = process.env.VENDOR_ROOT || join(REPO_ROOT, 'vendor');
  const vendorDir = join(vendorRoot, 'skills');

  if (!existsSync(vendorDir)) {
    process.stderr.write(`ERROR: vendor/skills directory not found at ${vendorDir}\n`);
    process.stderr.write(`       Run node scripts/setup.ts to vendor skills at SHA ${sha}\n`);
    process.exit(1);
  }

  const headShaFile = join(vendorDir, 'HEAD_SHA');
  if (!existsSync(headShaFile)) {
    process.stderr.write(`ERROR: ${headShaFile} not found — vendor may be corrupt or from a different setup\n`);
    process.stderr.write(`       Run node scripts/setup.ts to re-vendor skills at SHA ${sha}\n`);
    process.exit(1);
  }

  const actualSha = readFileSync(headShaFile, 'utf8').replace(/\s+/g, '');
  if (actualSha !== sha) {
    process.stderr.write('ERROR: vendor/skills SHA mismatch\n');
    process.stderr.write(`       locked: ${sha}\n`);
    process.stderr.write(`       actual: ${actualSha}\n`);
    process.stderr.write('       Run node scripts/setup.ts to re-vendor skills at the locked SHA\n');
    process.exit(1);
  }

  console.log(`OK: vendor/skills is present and matches locked SHA ${sha}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run();