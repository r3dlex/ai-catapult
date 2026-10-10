#!/usr/bin/env node
// stage-matrix-runtime.ts — stage the vendored matrix contract runtime into
// dist/matrix-runtime.py. (Replaces scripts/stage-matrix-runtime.sh; the
// runtime itself is vendored Python, pinned by skills.lock.json.)
import { chmodSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleDir, packageRoot } from '../src/paths.ts';

const ROOT = packageRoot(moduleDir(import.meta.url));

export function run(): void {
  const vendorSkills = process.env.AI_CATAPULT_VENDOR_SKILLS || join(ROOT, 'vendor/skills');
  const src = join(vendorSkills, 'scripts/matrix-contract.py');
  const dest = join(ROOT, 'dist/matrix-runtime.py');
  if (!existsSync(src)) {
    process.stderr.write(`ERROR: missing ${src}; run node scripts/setup.ts\n`);
    process.exit(1);
  }
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
  chmodSync(dest, 0o755);
  console.log('OK: staged matrix runtime');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run();