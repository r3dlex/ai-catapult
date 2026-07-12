#!/usr/bin/env node
import { resolveVendorSkill } from '../src/skill-resolver.js';

try {
  process.stdout.write(resolveVendorSkill(process.argv[2], process.argv[3] ?? 'ai-catapult-init'));
} catch (error) {
  process.stderr.write(`ERROR: ${error.message}\n`);
  process.exit(1);
}
