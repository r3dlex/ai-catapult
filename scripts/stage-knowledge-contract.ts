#!/usr/bin/env node
// Stage the frozen knowledge contract pack (.ai/knowledge/contract) into dist/
// so the staged (dist/) and snapshot (dist-snapshot/) layouts resolve the pack
// the same way the source and npm layouts do: one level above the module dir.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleDir, packageRoot } from '../src/paths.ts';

const REPO_ROOT = packageRoot(moduleDir(import.meta.url));
const SRC = join(REPO_ROOT, '.ai/knowledge/contract');
const DEST = join(REPO_ROOT, 'dist/.ai/knowledge/contract');

export function run(): void {
  if (!existsSync(SRC)) {
    process.stderr.write('ERROR: .ai/knowledge/contract is missing from the repo\n');
    process.exit(1);
  }
  rmSync(DEST, { recursive: true, force: true });
  mkdirSync(DEST, { recursive: true });
  cpSync(SRC, DEST, { recursive: true });
  console.log('OK: dist/.ai/knowledge/contract/ staged from the frozen knowledge contract pack');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run();