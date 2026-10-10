#!/usr/bin/env node
// stage-ci-adapters-runtime.ts — stage the vendored CI-adapter renderer and
// canonical ci templates into dist/. (Replaces scripts/stage-ci-adapters-runtime.sh;
// the renderer is vendored Python, pinned by skills.lock.json.)
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleDir, packageRoot } from '../src/paths.ts';

const ROOT = packageRoot(moduleDir(import.meta.url));

export function run(): void {
  const vendorSkills = process.env.AI_CATAPULT_VENDOR_SKILLS || join(ROOT, 'vendor/skills');
  const runtimeSrc = join(vendorSkills, 'scripts/render-ci-adapters.py');
  const templatesSrc = join(vendorSkills, '03-configure-generate/ai-catapult-init/templates/ci');
  const runtimeDest = join(ROOT, 'dist/scripts/render-ci-adapters.py');
  const templatesDest = join(ROOT, 'dist/03-configure-generate/ai-catapult-init/templates/ci');

  if (!existsSync(runtimeSrc)) {
    process.stderr.write(`ERROR: missing ${runtimeSrc}; run node scripts/setup.ts\n`);
    process.exit(1);
  }
  if (!existsSync(templatesSrc)) {
    process.stderr.write(`ERROR: missing ${templatesSrc}; run node scripts/setup.ts\n`);
    process.exit(1);
  }

  mkdirSync(dirname(runtimeDest), { recursive: true });
  mkdirSync(dirname(templatesDest), { recursive: true });
  rmSync(templatesDest, { recursive: true, force: true });
  cpSync(runtimeSrc, runtimeDest);
  cpSync(templatesSrc, templatesDest, { recursive: true });
  chmodSync(runtimeDest, 0o755);
  console.log('OK: staged CI adapter runtime and canonical templates');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run();