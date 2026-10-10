#!/usr/bin/env node
// setup.ts — vendors r3dlex/skills at the SHA pinned in skills.lock.json.
// Idempotent: safe to re-run. Never commits vendor/ (it is gitignored).
// Does NOT use git submodules. (Replaces the former setup.sh.)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleDir, packageRoot } from '../src/paths.ts';

const REPO_ROOT = packageRoot(moduleDir(import.meta.url));
const LOCK_FILE = join(REPO_ROOT, 'skills.lock.json');
const VENDOR_DIR = join(REPO_ROOT, 'vendor/skills');

type SkillsLock = { repo: string; sha: string; ref: string };

function readLock(): SkillsLock {
  if (!existsSync(LOCK_FILE)) {
    process.stderr.write(`ERROR: ${LOCK_FILE} not found\n`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(LOCK_FILE, 'utf8')) as SkillsLock;
}

/** Run a git command; on failure abort with git's own status/stderr (set -e semantics). */
function gitOrExit(args: string[]): void {
  const result = spawnSync('git', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (result.error) {
    process.stderr.write(`ERROR: git failed to start: ${result.error.message}\n`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function currentVendorSha(): string {
  // tr -d '[:space:]' semantics: drop every whitespace character.
  return readFileSync(join(VENDOR_DIR, 'HEAD_SHA'), 'utf8').replace(/\s+/g, '');
}

function run(): void {
  const lock = readLock();
  const { repo: skillsRepo, sha: lockedSha, ref: lockedRef } = lock;

  console.log(`skills lock: ${skillsRepo}@${lockedRef} (${lockedSha})`);

  // --- Idempotency check ---
  if (existsSync(join(VENDOR_DIR, 'HEAD_SHA'))) {
    const currentSha = currentVendorSha();
    if (currentSha === lockedSha) {
      console.log(`vendor/skills already at ${lockedSha} — nothing to do.`);
      return;
    }
    console.log(`vendor/skills is at ${currentSha}, re-vendoring to ${lockedSha}...`);
    rmSync(VENDOR_DIR, { recursive: true, force: true });
  }
  // Clear any stale/partial vendor dir left by a previously interrupted run.
  // (The idempotency short-circuit above already returned for a healthy,
  // SHA-matched dir.)
  rmSync(VENDOR_DIR, { recursive: true, force: true });
  mkdirSync(join(VENDOR_DIR, '..'), { recursive: true });

  // --- Fetch and check out the exact immutable SHA ---
  // The informational ref may disappear after its PR merges, so never require it.
  console.log(`Fetching ${skillsRepo} at locked SHA ${lockedSha} (ref: ${lockedRef}, informational only)...`);
  gitOrExit(['init', '-q', VENDOR_DIR]);
  gitOrExit(['-C', VENDOR_DIR, 'remote', 'add', 'origin', skillsRepo]);
  gitOrExit(['-C', VENDOR_DIR, 'fetch', '--depth=1', 'origin', lockedSha]);
  gitOrExit(['-C', VENDOR_DIR, 'checkout', '-q', '--detach', 'FETCH_HEAD']);

  const actual = spawnSync('git', ['-C', VENDOR_DIR, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const actualSha = (actual.stdout ?? '').trim();
  if (actualSha !== lockedSha) {
    process.stderr.write(`ERROR: checked out SHA ${actualSha} does not match locked SHA ${lockedSha}\n`);
    process.exit(1);
  }

  // Write HEAD_SHA sentinel so verify-vendor.ts can check without running git
  writeFileSync(join(VENDOR_DIR, 'HEAD_SHA'), `${lockedSha}\n`);

  console.log(`OK: vendor/skills vendored at ${lockedSha}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run();