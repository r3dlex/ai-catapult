#!/usr/bin/env node
// Stage the pinned README generator and template for the published CLI.
// (Replaces the former scripts/stage-readme-contract.sh; the generator itself
// is vendored content and stays a byte-pinned .sh.)
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  const dest = join(REPO_ROOT, 'dist/readme-contract');
  const generator = join(skillSrc, 'scripts/readme-generate.sh');
  const template = join(skillSrc, 'assets/readme/template.md');

  if (!existsSync(generator) || !existsSync(template)) {
    process.stderr.write('ERROR: pinned canonical README contract is incomplete\n');
    process.stderr.write(`       expected ${generator}\n`);
    process.stderr.write(`       expected ${template}\n`);
    process.exit(1);
  }

  rmSync(dest, { recursive: true, force: true });
  mkdirSync(join(dest, 'scripts'), { recursive: true });
  mkdirSync(join(dest, 'assets/readme'), { recursive: true });
  cpSync(generator, join(dest, 'scripts/readme-generate.sh'));
  cpSync(template, join(dest, 'assets/readme/template.md'));
  chmodSync(join(dest, 'scripts/readme-generate.sh'), 0o755);

  console.log('OK: dist/readme-contract/ staged from the pinned ai-catapult-init skill');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run();