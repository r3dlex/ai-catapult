#!/usr/bin/env node
// build-opencode-plugin.ts — assembles the OpenCode payload into dist/opencode-plugin/.
//
// Output layout:
//   dist/opencode-plugin/
//     .opencode-plugin/plugin.json — manifest marker (install.ts ensureBuilt seam)
//     skills/<name>/               — one dir per bundled skill copied from vendor/
//     command/<name>.md            — OpenCode slash commands rendered from the
//                                    shared schema definitions under
//                                    scripts/opencode-commands/
//
// The bundled set is every skill in the vendored catalog that supports
// opencode — derived, not listed here. See resolveBundledSkills in
// src/skill-resolver.ts.
//
// Deterministic: always wipes and rebuilds dist/opencode-plugin/ for
// idempotence. Fail-closed: exits non-zero if vendor/skills is absent or the
// bundled set resolves empty, before touching dist.
//
// Accepts VENDOR_ROOT and DIST_ROOT env overrides (for tests) — default to
// <repo>/vendor and <repo>/dist.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyBundledSkills, readBundledEntries, readPackageVersion } from './build-plugin-lib.ts';
import { moduleDir, packageRoot } from '../src/paths.ts';

const REPO_ROOT = packageRoot(moduleDir(import.meta.url));

type CommandDef = { name: string; description: string; skill: string };

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** Load and validate the shared-schema command definitions. */
function readCommandDefs(commandDefsDir: string): CommandDef[] {
  const defs = readdirSync(commandDefsDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(commandDefsDir, f), 'utf8')) as CommandDef);
  if (defs.length === 0) fail(`ERROR: no command definitions found in ${commandDefsDir}`);
  return defs;
}

/** Render one OpenCode command markdown file, byte-identical to the shell version. */
function renderCommand(commandDest: string, def: CommandDef): void {
  const md = [
    '---',
    'description: ' + def.description,
    '---',
    '',
    'Invoke the ' + def.skill + ' skill workflow with the user request below.',
    '',
    'User arguments: ' + String.fromCharCode(36) + 'ARGUMENTS',
    '',
  ].join('\n');
  writeFileSync(join(commandDest, def.name + '.md'), md);
}

/** Validate the assembled plugin.json: parseable + every required field present. */
function assertOpenCodeManifest(pluginJsonPath: string): void {
  let parsed: { name?: string; version?: string; description?: string; skills?: string[]; commands?: string[] };
  try {
    parsed = JSON.parse(readFileSync(pluginJsonPath, 'utf8')) as typeof parsed;
  } catch {
    fail('ERROR: plugin.json is not valid JSON');
  }
  const required = ['name', 'version', 'description', 'skills', 'commands'] as const;
  for (const field of required) {
    if (!parsed[field]) fail(`ERROR: plugin.json missing required field: ${field}`);
  }
}

export function run(): void {
  const VENDOR_ROOT = process.env.VENDOR_ROOT || join(REPO_ROOT, 'vendor');
  const VENDOR_SKILLS = join(VENDOR_ROOT, 'skills');
  const COMMAND_DEFS = join(REPO_ROOT, 'scripts/opencode-commands');
  const DIST_ROOT = process.env.DIST_ROOT || join(REPO_ROOT, 'dist');
  const DIST_DIR = join(DIST_ROOT, 'opencode-plugin');
  const PLUGIN_JSON_DIR = join(DIST_DIR, '.opencode-plugin');
  const SKILLS_DEST = join(DIST_DIR, 'skills');
  const COMMAND_DEST = join(DIST_DIR, 'command');

  // --- Fail closed if vendor missing (before touching dist) ---
  // NOTE: the trailing " >&2" is reproduced on purpose — the original shell
  // echo quoted it, sending both the message and the suffix to stdout. The
  // original's second line was properly redirected to stderr and stays there.
  if (!existsSync(VENDOR_SKILLS)) {
    process.stdout.write(`ERROR: vendor/skills directory not found at ${VENDOR_SKILLS} >&2\n`);
    fail('       Run node scripts/setup.ts first to vendor skills.');
  }

  // --- Fail closed: a failing or empty resolver aborts the build ---
  const bundled = readBundledEntries(VENDOR_SKILLS, 'opencode');
  if (bundled.length === 0) {
    fail(`ERROR: no bundled skills resolved from ${VENDOR_SKILLS} for host opencode`);
  }

  // --- Read version from package.json ---
  const version = readPackageVersion(join(REPO_ROOT, 'package.json'), 'ERROR: could not read version from package.json');

  console.log(`Building OpenCode payload ai-catapult@${version}...`);

  // --- Deterministic wipe-and-rebuild ---
  rmSync(DIST_DIR, { recursive: true, force: true });
  mkdirSync(PLUGIN_JSON_DIR, { recursive: true });
  mkdirSync(SKILLS_DEST, { recursive: true });
  mkdirSync(COMMAND_DEST, { recursive: true });

  // --- Skills: verbatim copy per bundled dir ---
  copyBundledSkills(bundled, SKILLS_DEST);

  // --- Commands: render shared-schema definitions deterministically ---
  const defs = readCommandDefs(COMMAND_DEFS);
  for (const def of defs) {
    renderCommand(COMMAND_DEST, def);
  }

  // --- Manifest marker ---
  const manifest = {
    name: 'ai-catapult',
    version: version,
    description: 'AI-SDLC governance scaffolding payload for OpenCode: bundled skills plus generated slash commands.',
    interface: { displayName: 'ai-catapult (OpenCode)' },
    skills: bundled.map((e) => e.name).sort(),
    commands: defs.map((d) => d.name).sort(),
  };
  writeFileSync(join(PLUGIN_JSON_DIR, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');

  // --- Validate ---
  assertOpenCodeManifest(join(PLUGIN_JSON_DIR, 'plugin.json'));

  for (const entry of bundled) {
    if (!existsSync(join(SKILLS_DEST, entry.name, 'SKILL.md'))) {
      fail(`ERROR: skills/${entry.name}/SKILL.md not present in output`);
    }
  }

  console.log('OK: dist/opencode-plugin assembled');
  console.log('  .opencode-plugin/plugin.json');
  console.log(`  skills/ (${bundled.length} skills)`);
  console.log(`  command/ (${defs.length} commands)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run();