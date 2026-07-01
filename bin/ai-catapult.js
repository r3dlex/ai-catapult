#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

const HELP = `Usage: ai-catapult <command> [options]

Commands:
  init      (coming soon) Scaffold v3 .ai/ governance into a repo
  install   (coming soon) Install Claude Code and Codex plugins

Options:
  -v, --version  Print version
  -h, --help     Show this help`;

// TODO(slice-3): replace flag-first parse with verb dispatch for init/install
const arg = process.argv[2];

if (arg === '--version' || arg === '-v') {
  console.log(pkg.version);
  process.exit(0);
}

if (arg === '--help' || arg === '-h' || arg === undefined) {
  console.log(HELP);
  process.exit(0);
}

process.stderr.write(`Unknown argument: ${arg}. Run ai-catapult --help for usage.\n`);
process.exit(1);
