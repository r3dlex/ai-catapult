#!/usr/bin/env node
// build-claude-plugin.ts — assemble the ai-catapult Claude Code plugin into dist/claude-plugin/.
//
// Output layout (per Claude Code plugin contract):
//   dist/claude-plugin/            ← PLUGIN ROOT (paths in plugin.json resolve from here)
//     .claude-plugin/
//       plugin.json        (manifest: name, version, description, author, skills)
//       marketplace.json   (marketplace entry with $schema)
//     skills/
//       <name>/            (one flat copy per catalog-resolved vendored skill)
//
// The bundled set is every skill in the vendored catalog that supports Claude
// Code — derived, not listed here, so upstream additions ship on the next lock
// bump. See resolveBundledSkills in src/skill-resolver.ts.
//
// .claude-plugin/ holds ONLY manifests. All skill paths in plugin.json are
// relative to the plugin root (dist/claude-plugin/), NOT to .claude-plugin/.
// So "./skills/ai-catapult-init/" resolves to dist/claude-plugin/skills/ai-catapult-init/.
//
// Nothing assembled here is committed (dist/ is gitignored, decision 7).
// Deterministic: version is read from package.json, no timestamps embedded.
// Fail-closed: exits non-zero if vendor/ is missing (run node scripts/setup.ts first).
//
// Usage:
//   node scripts/build-claude-plugin.ts
//
// npm script: build:plugin:claude
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  copyBundledSkills,
  copyPythonRuntimes,
  countFilesRecursive,
  pruneSkillArtifacts,
  readBundledEntries,
  readPackageVersion,
} from './build-plugin-lib.ts';
import { moduleDir, packageRoot } from '../src/paths.ts';

const REPO_ROOT = packageRoot(moduleDir(import.meta.url));

export function run(): void {
  const PACKAGE_JSON = join(REPO_ROOT, 'package.json');
  const VENDOR_ROOT = process.env.VENDOR_ROOT || join(REPO_ROOT, 'vendor');
  const VENDOR_SKILLS = join(VENDOR_ROOT, 'skills');
  const DIST_ROOT = process.env.DIST_ROOT || join(REPO_ROOT, 'dist');
  const DIST_DIR = join(DIST_ROOT, 'claude-plugin');
  const PLUGIN_DIR = join(DIST_DIR, '.claude-plugin');
  const SKILLS_OUT = join(DIST_DIR, 'skills');

  // --- Fail closed if vendor/ is missing ---
  if (!existsSync(VENDOR_SKILLS)) {
    process.stderr.write(`ERROR: vendor/skills not found at ${VENDOR_SKILLS}\n`);
    process.stderr.write('       Run node scripts/setup.ts to populate vendor/ first.\n');
    process.exit(1);
  }

  // Fail-closed: a failing resolver aborts the build rather than shipping a
  // plugin with a silently truncated skill set.
  const bundled = readBundledEntries(VENDOR_SKILLS, 'claude-code');
  if (bundled.length === 0) {
    process.stderr.write(`ERROR: no bundled skills resolved from ${VENDOR_SKILLS}\n`);
    process.exit(1);
  }

  // --- Read version from package.json ---
  const version = readPackageVersion(PACKAGE_JSON, `ERROR: could not read version from ${PACKAGE_JSON}`);
  console.log(`Building Claude Code plugin ai-catapult@${version}...`);

  // --- Clean and recreate output dirs ---
  rmSync(DIST_DIR, { recursive: true, force: true });
  mkdirSync(PLUGIN_DIR, { recursive: true });
  mkdirSync(SKILLS_OUT, { recursive: true });

  // --- Copy vendored skills (deterministic: strip .git and the HEAD_SHA sentinel) ---
  copyBundledSkills(bundled, SKILLS_OUT);
  copyPythonRuntimes(VENDOR_SKILLS, DIST_DIR);
  for (const entry of bundled) {
    pruneSkillArtifacts(join(SKILLS_OUT, entry.name));
  }

  // --- Write plugin.json (skills array rendered from the bundled set) ---
  const skillsJson = bundled.map((e) => `    "./skills/${e.name}/"`).join(',\n');
  writeFileSync(
    join(PLUGIN_DIR, 'plugin.json'),
    `{
  "name": "ai-catapult",
  "version": "${version}",
  "description": "Scaffold init-ai-repo v3 AI-SDLC governance into any repository — no LLM required, one command. Ships the ai-catapult skill catalog for Claude Code.",
  "author": {
    "name": "r3dlex"
  },
  "repository": "https://github.com/r3dlex/ai-catapult",
  "homepage": "https://github.com/r3dlex/ai-catapult",
  "license": "MIT",
  "keywords": [
    "ai-sdlc",
    "governance",
    "scaffold",
    "init-ai-repo",
    "claude-code"
  ],
  "skills": [
${skillsJson}
  ]
}\n`,
    'utf8',
  );

  // --- Write marketplace.json ---
  writeFileSync(
    join(PLUGIN_DIR, 'marketplace.json'),
    `{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "ai-catapult",
  "description": "Scaffold init-ai-repo v3 AI-SDLC governance — deterministic, no LLM required",
  "owner": {
    "name": "r3dlex"
  },
  "plugins": [
    {
      "name": "ai-catapult",
      "description": "Scaffold init-ai-repo v3 AI-SDLC governance into any repository. One command, zero config, no LLM required. Ships the ai-catapult skill catalog for Claude Code.",
      "version": "${version}",
      "author": {
        "name": "r3dlex"
      },
      "source": "./",
      "category": "productivity",
      "homepage": "https://github.com/r3dlex/ai-catapult",
      "tags": [
        "ai-sdlc",
        "governance",
        "scaffold",
        "init-ai-repo"
      ]
    }
  ],
  "version": "${version}"
}\n`,
    'utf8',
  );

  // --- Validate the assembled output ---
  console.log('Validating assembled plugin...');
  validatePluginJson(join(PLUGIN_DIR, 'plugin.json'));
  validateMarketplaceJson(join(PLUGIN_DIR, 'marketplace.json'));

  // 3. Regression guard: skills must NOT be nested inside .claude-plugin/
  if (existsSync(join(PLUGIN_DIR, 'skills'))) {
    process.stderr.write(`ERROR: skills/ must NOT be nested inside .claude-plugin/ — found ${join(PLUGIN_DIR, 'skills')}\n`);
    process.stderr.write(`       Skills must live at the plugin root: ${SKILLS_OUT}\n`);
    process.exit(1);
  }

  // 4. Referenced skill dirs exist and contain SKILL.md
  //    Paths in plugin.json are relative to the plugin root (DIST_DIR), not PLUGIN_DIR.
  validateReferencedSkills(DIST_DIR, readPluginSkills(join(PLUGIN_DIR, 'plugin.json')));

  console.log(`OK: dist/claude-plugin assembled and validated (ai-catapult@${version})`);
  console.log(`    ${PLUGIN_DIR}/plugin.json`);
  console.log(`    ${PLUGIN_DIR}/marketplace.json`);
  console.log(`    ${SKILLS_OUT}/ (${bundled.length} skills, ${countFilesRecursive(SKILLS_OUT)} files)`);
}

type PluginManifest = {
  name?: string;
  version?: string;
  description?: string;
  author?: { name?: string };
  skills?: string[];
};

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** 1. plugin.json parses as JSON and has required fields. */
function validatePluginJson(pluginJsonPath: string): PluginManifest {
  const plugin = JSON.parse(readFileSync(pluginJsonPath, 'utf8')) as PluginManifest;
  if (!plugin.name) fail('plugin.json missing name');
  if (!plugin.version) fail('plugin.json missing version');
  if (!plugin.description) fail('plugin.json missing description');
  if (!plugin.author) fail('plugin.json missing author');
  if (!Array.isArray(plugin.skills) || plugin.skills.length === 0) {
    fail('plugin.json skills must be a non-empty array');
  }
  return plugin;
}

/** 2. marketplace.json parses and has $schema + plugins array. */
function validateMarketplaceJson(marketplacePath: string): void {
  const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf8')) as { '$schema'?: string; plugins?: unknown[] };
  if (!marketplace.$schema) fail('marketplace.json missing $schema');
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length === 0) {
    fail('marketplace.json missing plugins array');
  }
}

function readPluginSkills(pluginJsonPath: string): string[] {
  return (JSON.parse(readFileSync(pluginJsonPath, 'utf8')) as PluginManifest).skills ?? [];
}

function validateReferencedSkills(distDir: string, skills: readonly string[]): void {
  for (const skillRel of skills) {
    // Keep the literal "./skills/<name>/" form in the message, as the shell did.
    const skillAbs = `${distDir}/${skillRel}`;
    if (!existsSync(skillAbs)) fail(`ERROR: skill directory referenced in plugin.json not found: ${skillAbs}`);
    if (!existsSync(join(skillAbs, 'SKILL.md'))) fail(`ERROR: SKILL.md missing in ${skillAbs}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run();