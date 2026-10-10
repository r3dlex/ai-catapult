#!/usr/bin/env node
// build-codex-plugin.ts — assembles the Codex plugin into dist/codex-plugin/.
//
// Output layout:
//   dist/codex-plugin/
//     .codex-plugin/plugin.json   — plugin manifest
//     skills/<name>/              — one dir per bundled skill copied from vendor/
//
// The bundled set is every skill in the vendored catalog that supports Codex —
// derived, not listed here. See resolveBundledSkills in src/skill-resolver.ts.
//
// Deterministic: always wipes and rebuilds dist/codex-plugin/ for idempotence.
// Fail-closed: exits non-zero if vendor/skills is absent or incomplete.
//
// Accepts VENDOR_ROOT env override (for tests) — defaults to <repo>/vendor.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  copyBundledSkills,
  copyPythonRuntimes,
  pruneSkillArtifacts,
  readBundledEntries,
  readPackageVersion,
} from './build-plugin-lib.ts';
import { moduleDir, packageRoot } from '../src/paths.ts';

const REPO_ROOT = packageRoot(moduleDir(import.meta.url));

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

export function run(): void {
  const VENDOR_ROOT = process.env.VENDOR_ROOT || join(REPO_ROOT, 'vendor');
  const VENDOR_SKILLS = join(VENDOR_ROOT, 'skills');
  const DIST_ROOT = process.env.DIST_ROOT || join(REPO_ROOT, 'dist');
  const DIST_DIR = join(DIST_ROOT, 'codex-plugin');
  const PLUGIN_JSON_DIR = join(DIST_DIR, '.codex-plugin');
  const SKILLS_DEST = join(DIST_DIR, 'skills');

  // --- Fail closed if vendor missing ---
  if (!existsSync(VENDOR_SKILLS)) {
    process.stderr.write(`ERROR: vendor/skills directory not found at ${VENDOR_SKILLS}\n`);
    fail('       Run node scripts/setup.ts first to vendor skills.');
  }

  // Fail-closed: a failing resolver aborts the build rather than shipping a
  // plugin with a silently truncated skill set.
  const bundled = readBundledEntries(VENDOR_SKILLS, 'codex');
  if (bundled.length === 0) {
    fail(`ERROR: no bundled skills resolved from ${VENDOR_SKILLS}`);
  }

  // --- Read version from package.json ---
  const version = readPackageVersion(join(REPO_ROOT, 'package.json'), 'ERROR: could not read version from package.json');

  console.log(`Building Codex plugin ai-catapult@${version}...`);

  // --- Wipe + recreate output dirs for determinism ---
  rmSync(DIST_DIR, { recursive: true, force: true });
  mkdirSync(PLUGIN_JSON_DIR, { recursive: true });
  mkdirSync(SKILLS_DEST, { recursive: true });

  // --- Write plugin.json ---
  writeFileSync(
    join(PLUGIN_JSON_DIR, 'plugin.json'),
    `{
  "name": "ai-catapult",
  "version": "${version}",
  "description": "CLI + Claude Code and Codex plugins for init-ai-repo v3 AI-SDLC governance scaffolding",
  "skills": "./skills/",
  "interface": {
    "displayName": "ai-catapult",
    "shortDescription": "Scaffold init-ai-repo v3 AI-SDLC governance structure in any repo.",
    "category": "Developer Tools"
  }
}\n`,
    'utf8',
  );

  // --- Copy vendored skills (strip .git + HEAD_SHA per copied dir) ---
  copyBundledSkills(bundled, SKILLS_DEST);
  for (const entry of bundled) {
    pruneSkillArtifacts(join(SKILLS_DEST, entry.name));
  }
  copyPythonRuntimes(VENDOR_SKILLS, DIST_DIR);

  // --- Validate output ---
  const manifestPath = join(PLUGIN_JSON_DIR, 'plugin.json');
  if (!existsSync(manifestPath)) fail('ERROR: plugin.json was not written');

  let manifest: CodexManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as CodexManifest;
  } catch {
    fail('ERROR: plugin.json is not valid JSON');
  }
  validateCodexManifest(manifest);

  for (const entry of bundled) {
    if (!existsSync(join(SKILLS_DEST, entry.name, 'SKILL.md'))) {
      fail(`ERROR: skills/${entry.name}/SKILL.md not present in output`);
    }
  }

  console.log('OK: dist/codex-plugin assembled');
  console.log('  .codex-plugin/plugin.json');
  console.log(`  skills/ (${bundled.length} skills)`);
}

type CodexManifest = {
  name?: string;
  version?: string;
  description?: string;
  skills?: string;
  interface?: { displayName?: string };
};

function validateCodexManifest(manifest: CodexManifest): void {
  const required = ['name', 'version', 'description', 'skills', 'interface'] as const;
  for (const field of required) {
    if (!manifest[field]) fail(`ERROR: plugin.json missing required field: ${field}`);
  }
  if (!manifest.interface?.displayName) fail('ERROR: plugin.json interface.displayName missing');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run();