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
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countFilesRecursive } from './build-plugin-lib.ts';
import { moduleDir, packageRoot } from '../src/paths.ts';
import { resolveVendorSkill } from '../src/skill-resolver.ts';

const REPO_ROOT = packageRoot(moduleDir(import.meta.url));

/**
 * Stage the vendored ai-catapult-init templates plus the vendored Archgate
 * validator from the skills root into dest.
 *
 * The validator resolves from the SKILLS ROOT — `scripts/validate-rules.sh`
 * next to catalog.json — not from arithmetic over the resolved skill dir: the
 * catalog may place the skill at any depth (the resolver tests pin one-,
 * two- and three-component source_paths), so the root is the only stable
 * anchor. Both sources are validated before dest is touched: staging replaces
 * dest wholesale, so a vendor whose validator is missing must fail BEFORE a
 * half-staged tree lands there.
 */
export function stageFrom(skillsRoot: string, dest: string): void {
  const skillSrc = resolveVendorSkill(skillsRoot, 'ai-catapult-init');
  const src = join(skillSrc, 'templates');
  if (!existsSync(src)) {
    throw new Error(`resolved ai-catapult-init templates not found at ${src} — run node scripts/setup.ts to populate vendor/ first`);
  }
  const validatorSrc = join(skillsRoot, 'scripts', 'validate-rules.sh');
  let validatorStat;
  try {
    validatorStat = statSync(validatorSrc);
  } catch {
    throw new Error(`vendored validator script not found at ${validatorSrc} — vendor/ is missing or stale, run node scripts/setup.ts first`);
  }
  if (!validatorStat.isFile()) {
    throw new Error(`vendored validator is not a regular file at ${validatorSrc} — vendor/ is missing or stale, run node scripts/setup.ts first`);
  }

  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });

  // Ship the vendored Archgate validator alongside the templates: the emitted
  // prek.toml hook references scripts/validate-rules.sh, and the packaged CLI
  // (no vendor/) must still be able to scaffold a tree whose hook is live.
  mkdirSync(join(dest, 'scripts'), { recursive: true });
  cpSync(validatorSrc, join(dest, 'scripts', 'validate-rules.sh'));
}

export function run(): void {
  const vendorRoot = process.env.VENDOR_ROOT || join(REPO_ROOT, 'vendor');
  const dest = join(REPO_ROOT, 'dist/skill-templates');
  try {
    stageFrom(join(vendorRoot, 'skills'), dest);
  } catch (error) {
    process.stderr.write(`ERROR: ${(error as Error).message}\n`);
    process.exit(1);
  }

  console.log('OK: dist/skill-templates/ staged from resolved ai-catapult-init/templates/');
  console.log('OK: dist/skill-templates/scripts/validate-rules.sh staged from the vendored skills root');
  console.log(`    ${countFilesRecursive(dest)} files`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run();