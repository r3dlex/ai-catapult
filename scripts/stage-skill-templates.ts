#!/usr/bin/env node
// stage-skill-templates.ts — copy vendored ai-catapult-init templates into
// dist/skill-templates/ (plus the vendored scripts/validate-rules.sh validator
// the emitted prek.toml hook references) so they ship in the npm tarball.
//
// This is a packaged copy of the catalog-resolved SSOT templates for `ai-catapult init` when vendor/ is absent
// (i.e. when the package is installed via npx rather than cloned from source).
//
// Resolution order in bin/ai-catapult.ts:
//   1. catalog-resolved vendored templates          (dev checkout)
//   2. dist/skill-templates/                        (published package — this dir)
//
// Run by: npm run build (via scripts/prepare-dist.ts)
// Snapshot for tests: npm run pretest → node scripts/snapshot-dist.ts copies dist/
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countFilesRecursive } from './build-plugin-lib.ts';
import { moduleDir, packageRoot } from '../src/paths.ts';
import { resolveVendorSkill } from '../src/skill-resolver.ts';

const REPO_ROOT = packageRoot(moduleDir(import.meta.url));

export function run(): void {
  const vendorRoot = process.env.VENDOR_ROOT || join(REPO_ROOT, 'vendor');
  let skillSrc: string;
  try {
    skillSrc = resolveVendorSkill(join(vendorRoot, 'skills'), 'ai-catapult-init');
  } catch (error) {
    process.stderr.write(`ERROR: ${(error as Error).message}\n`);
    process.exit(1);
  }
  const src = join(skillSrc, 'templates');
  const dest = join(REPO_ROOT, 'dist/skill-templates');

  if (!existsSync(src)) {
    process.stderr.write(`ERROR: resolved ai-catapult-init templates not found at ${src}\n`);
    process.stderr.write('       Run node scripts/setup.ts to populate vendor/ first.\n');
    process.exit(1);
  }

  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });

  // Also ship the vendored Archgate validator alongside the templates: the
  // emitted prek.toml hook references scripts/validate-rules.sh, and the
  // packaged CLI (no vendor/) must still be able to scaffold a tree whose
  // hook is live. Byte-exact copy from the same skills root the templates
  // stage from (skillSrc is <skillsRoot>/<category>/ai-catapult-init, so the
  // script sits two levels above it).
  const validatorSrc = join(skillSrc, '..', '..', 'scripts', 'validate-rules.sh');
  if (!existsSync(validatorSrc)) {
    process.stderr.write(`ERROR: vendored validator script not found at ${validatorSrc}\n`);
    process.stderr.write('       vendor/ is missing or stale — run node scripts/setup.ts first.\n');
    process.exit(1);
  }
  mkdirSync(join(dest, 'scripts'), { recursive: true });
  cpSync(validatorSrc, join(dest, 'scripts', 'validate-rules.sh'));

  console.log('OK: dist/skill-templates/ staged from resolved ai-catapult-init/templates/');
  console.log('OK: dist/skill-templates/scripts/validate-rules.sh staged from the vendored skills root');
  console.log(`    ${countFilesRecursive(dest)} files`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run();