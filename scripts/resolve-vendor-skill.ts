#!/usr/bin/env node
import { resolveVendorSkill } from '../src/skill-resolver.ts';

try {
  process.stdout.write(resolveVendorSkill(process.argv[2] as string, process.argv[3] ?? 'ai-catapult-init'));
} catch (error) {
  process.stderr.write(`ERROR: ${(error as Error).message}\n`);
  process.exit(1);
}