#!/usr/bin/env node
// snapshot-dist.ts — copy dist/ to dist-snapshot/ for stable test isolation.
//
// The install command respects AI_CATAPULT_DIST_ROOT; npm test sets it to
// dist-snapshot/ so install tests (and the finish-prompt drift-guard) always
// read from a stable snapshot rather than the live dist/ that claude-plugin
// tests wipe and rebuild concurrently.
//
// Run by: npm run pretest (before node --test)
import { cpSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleDir, packageRoot } from '../src/paths.ts';

const REPO_ROOT = packageRoot(moduleDir(import.meta.url));
const SRC = join(REPO_ROOT, 'dist');
const DEST = join(REPO_ROOT, 'dist-snapshot');

export function run(): void {
  if (!existsSync(SRC)) {
    process.stderr.write(`ERROR: dist/ not found at ${SRC} — run build scripts first\n`);
    process.exit(1);
  }
  rmSync(DEST, { recursive: true, force: true });
  cpSync(SRC, DEST, { recursive: true });
  console.log('OK: dist-snapshot/ created from dist/');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run();