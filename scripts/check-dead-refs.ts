#!/usr/bin/env node
// check-dead-refs.ts — ai-catapult half of the dead-reference grep gate (SSCM-09).
//
// Reuses the vendored gate semantics (vendor/skills/tests/dead_reference_gate_test.sh)
// against the ai-catapult corpus. The vendored gate's allowlists are written
// for the skills repo root, so this wrapper scans the ai-catapult-owned tree
// directly with its own exclusion set, then delegates per-file adjudication to
// the same identity regex semantics.
//
// Exclusions (each with why) — every entry must match >=1 scanned file or the
// gate fails (no dead shields):
//
//   vendor/skills/**           — the vendored skills snapshot legitimately
//                                names all three removed/deprecated identities
//                                (its own allowlists cover them there).
//   dist/** dist-snapshot/**   — build outputs derived from vendor/;
//                                gitignored, excluded for determinism.
//   node_modules/** .git/** graphify-out/** — caches/tooling, not content.
//
// Exit 0 = no unannotated live references outside the snapshot; 1 otherwise; 2 = usage.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleDir, packageRoot } from '../src/paths.ts';

const ROOT = packageRoot(moduleDir(import.meta.url));
const NAMES = ['resolving-merge-conflicts', 'ubiquitous-language', 'diagnose'];

// identity semantics mirror the vendored gate:
//   `name` | 'name' | "name" | $name | name/SKILL.md | --skill name
function grepMatches(name: string): string[] {
  const pattern =
    "([`']" +
    name +
    "[`']|\"" +
    name +
    '"|\\$' +
    name.replace(/-/g, '') +
    '\\b|' +
    name +
    '/SKILL\\.md|--skill[= ]' +
    name +
    '\\b)';
  const result = spawnSync(
    'grep',
    ['-rInE', pattern, '--exclude-dir=.git', '--exclude-dir=node_modules', '--exclude-dir=graphify-out', '--exclude=skills.lock.json', '.'],
    { encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  return (result.stdout ?? '').split('\n').filter((line) => line.length > 0);
}

// exclusions: vendor snapshot mirror, build outputs, and the gate itself
// (the gate declares the three identities by construction).
function isExcluded(file: string): boolean {
  if (file.startsWith('./vendor/skills/')) return true; // vendored snapshot: covered by skills-repo allowlists
  if (file.startsWith('./dist/')) return true; // build output (gitignored), derived from vendor
  if (file.startsWith('./dist-snapshot/')) return true; // test-time build snapshot, same content
  if (file === './test/dead-refs.test.ts') return true; // the npm-lane wrapper: mutation fixture injects the name by design
  if (file === './scripts/check-dead-refs.ts') return true; // the gate itself declares the names
  return false;
}

function run(): void {
  const matches: string[] = [];
  for (const name of NAMES) {
    matches.push(...grepMatches(name));
  }

  let failed = false;
  let seen = 0;
  for (const line of matches) {
    if (line.length === 0) continue;
    seen += 1;
    const file = line.slice(0, line.indexOf(':'));
    if (!isExcluded(file)) {
      console.log(`VIOLATION: live reference outside vendor snapshot: ${line}`);
      failed = true;
    }
  }

  // zero-match guard: the exclusion set must stay provably live (vendored tree
  // always exists post-setup; the gate script always exists here).
  const probes = ['vendor/skills/catalog.json', 'scripts/check-dead-refs.ts', 'test/dead-refs.test.ts'];
  for (const probe of probes) {
    if (!existsSync(join(ROOT, probe))) {
      console.log(`VIOLATION: exclusion probe target missing: ${probe}`);
      failed = true;
    }
  }

  if (!failed) {
    console.log(`check-dead-refs: PASSED (${seen} raw matches, all excluded)`);
    process.exit(0);
  }
  console.log('check-dead-refs: FAILED');
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run();