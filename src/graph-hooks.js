/**
 * graph-hooks.js — `ai-catapult graph-hooks install <target>` subcommand.
 *
 * Wires git hooks (post-commit, post-checkout) and copies the graph-refresh
 * wrapper script into a target repo. Reads templates from the vendored
 * graph-automation/ directory (catalog-resolved vendored templates/
 * graph-automation/ in dev; dist/skill-templates/graph-automation/ in the
 * published tarball).
 *
 * Safety patterns mirror src/install.js:
 *   - --dry-run: early-return before any writes
 *   - non-git target: exit 1 with clear message
 *   - marker-managed idempotence in hook files
 *   - engine-absent: exits 0 (no-op at runtime is the wrapper's concern)
 *
 * Harness hooks (Claude Code Stop/SessionStart, Codex equivalents) are
 * printed as NEXT-STEPS guidance only — never written to harness dirs.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Marker constants for idempotent hook block management
// ---------------------------------------------------------------------------

const MARKER_START = '# BEGIN ai-catapult graph-hooks';
const MARKER_END = '# END ai-catapult graph-hooks';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the hooks directory for a git repo, honoring core.hooksPath.
 * Mirrors graphify's _hooks_dir() pattern.
 *
 * @param {string} repoRoot - absolute path to the git repo root
 * @returns {string} absolute path to the hooks directory
 */
function resolveHooksDir(repoRoot) {
  const result = spawnSync('git', ['-C', repoRoot, 'config', 'core.hooksPath'], {
    encoding: 'utf8',
  });
  if (result.status === 0) {
    const hooksPath = result.stdout.trim();
    if (hooksPath) {
      // core.hooksPath may be relative (to repo root) or absolute
      return resolve(repoRoot, hooksPath);
    }
  }
  // Default: .git/hooks
  return join(repoRoot, '.git', 'hooks');
}

/**
 * Install or update the ai-catapult marker block inside a hook file.
 * Preserves any pre-existing content outside the markers (idempotent replace).
 *
 * @param {string} hookPath  - absolute path to the hook file
 * @param {string} blockBody - content to place between the markers (no trailing newline needed)
 */
function installMarkerBlock(hookPath, blockBody) {
  let existing = '';
  if (existsSync(hookPath)) {
    existing = readFileSync(hookPath, 'utf8');
  }

  const block = `${MARKER_START}\n${blockBody}\n${MARKER_END}\n`;

  let updated;
  if (existing.includes(MARKER_START)) {
    // Replace the existing marker block (idempotent)
    const re = new RegExp(
      escapeRegExp(MARKER_START) + '[\\s\\S]*?' + escapeRegExp(MARKER_END) + '\\n?',
    );
    updated = existing.replace(re, block);
  } else {
    // Append the block after the shebang line (or at start if none)
    if (existing === '') {
      updated = `#!/usr/bin/env bash\n${block}`;
    } else {
      // Find the end of the first line (shebang or first content)
      const firstNewline = existing.indexOf('\n');
      if (firstNewline === -1) {
        updated = existing + '\n' + block;
      } else {
        updated = existing.slice(0, firstNewline + 1) + block + existing.slice(firstNewline + 1);
      }
    }
  }

  writeFileSync(hookPath, updated, 'utf8');
  chmodSync(hookPath, 0o755);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Walk the ancestors of `startDir` (exclusive — startDir itself is not checked)
 * looking for a directory that contains both scripts/graph-refresh.sh and .git.
 * Stops when reaching $HOME or the filesystem root.
 *
 * @param {string} startDir - directory whose PARENT is the first candidate
 * @param {string} home     - path to stop at (exclusive)
 * @returns {string|null}   ancestor path if found, null otherwise
 */
function findAncestorWrapper(startDir, home) {
  let dir = dirname(startDir);
  while (dir !== home && dir !== dirname(dir)) {
    if (
      existsSync(join(dir, 'scripts', 'graph-refresh.sh')) &&
      existsSync(join(dir, '.git'))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return null;
}

/**
 * Strip a leading shebang line from a shell template string.
 * Avoids embedding a duplicate shebang inside the marker block.
 *
 * @param {string} content - raw file content
 * @returns {string}
 */
function stripLeadingShebang(content) {
  if (content.startsWith('#!')) {
    const firstNewline = content.indexOf('\n');
    if (firstNewline !== -1) {
      return content.slice(firstNewline + 1);
    }
    return '';
  }
  return content;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export const GRAPH_HOOKS_INSTALL_HELP = `Usage: ai-catapult graph-hooks install <target> [options]

Install graph-automation git hooks and wrapper script into a target git repo.

Writes:
  <target>/.git/hooks/post-commit       (marker-managed, preserves existing content)
  <target>/.git/hooks/post-checkout     (marker-managed, preserves existing content)
  <target>/scripts/graph-refresh.sh     (lock+coalesce wrapper, {{ENGINE}} substituted)
  <target>/graph-automation/config.json (engine knob)

Prints harness hook NEXT-STEPS (Claude Code Stop/SessionStart, Codex) — does NOT
write to any harness config file.

Arguments:
  target   Path to the git repository to install into (default: current directory)

Options:
  --engine <graphify|graphwiki>  Graph engine to use (default: graphify)
  --dry-run                      Print what would happen without writing any files
  -h, --help                     Show this help`;

/**
 * Main graph-hooks install handler.
 * @param {string[]} argv - arguments after "graph-hooks install" (already sliced)
 * @param {string} templatesDir - resolved path to the templates directory
 */
export function runGraphHooksInstall(argv, templatesDir) {
  // Parse flags
  const flags = new Map();
  const positionals = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags.set(key, next);
        i += 2;
      } else {
        flags.set(key, true);
        i += 1;
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      flags.set(arg.slice(1), true);
      i += 1;
    } else {
      positionals.push(arg);
      i += 1;
    }
  }

  if (flags.has('help') || flags.has('h')) {
    process.stdout.write(GRAPH_HOOKS_INSTALL_HELP + '\n');
    process.exit(0);
  }

  const dryRun = flags.has('dry-run');
  const force = flags.has('force');
  const engineRaw = flags.get('engine');
  const targetArg = positionals[0];
  const targetDir = targetArg ? resolve(targetArg) : process.cwd();

  // Validate --engine: must be one of the allowed values.
  // Allowed set mirrors config.json's engine_options field.
  // If --engine was given without a value, engineRaw is `true` (boolean) — also invalid.
  const ALLOWED_ENGINES = ['graphify', 'graphwiki']; // see graph-automation/config.json engine_options
  const engine = engineRaw === undefined ? 'graphify' : String(engineRaw);
  if (engineRaw !== undefined && !ALLOWED_ENGINES.includes(engine)) {
    process.stderr.write(
      `Error: invalid --engine value: "${engine}". Must be one of: ${ALLOWED_ENGINES.join(', ')}.\n`,
    );
    process.exit(1);
  }

  // Validate: must be a git repo
  const gitCheck = spawnSync('git', ['-C', targetDir, 'rev-parse', '--git-dir'], {
    encoding: 'utf8',
  });
  if (gitCheck.status !== 0 || !gitCheck.stdout.trim()) {
    process.stderr.write(`Error: ${targetDir} is not a git repo (no .git found).\n`);
    process.exit(1);
  }

  // Ancestor-wrapper guard: refuse to install if an ancestor repo already has a
  // wrapper (scripts/graph-refresh.sh + .git), which would mean this target is a
  // workspace child — silently forking the graph contradicts the one-root-graph
  // contract. Walk from the TARGET's PARENT upward, stop at $HOME / root.
  const home = process.env.HOME ?? homedir();
  const ancestorWithWrapper = findAncestorWrapper(targetDir, home);
  if (ancestorWithWrapper) {
    process.stderr.write(
      `Error: ancestor repo already has a graph-refresh wrapper at ${ancestorWithWrapper}.\n` +
      `Installing here would fork the workspace graph (contradicts one-root-graph contract).\n` +
      `Use --force to install anyway.\n`,
    );
    if (!force) {
      process.exit(1);
    }
    process.stderr.write(
      `Warning: proceeding despite ancestor wrapper at ${ancestorWithWrapper} (--force).\n`,
    );
  }

  // Load templates from the graph-automation/ subdir
  const gaDir = join(templatesDir, 'graph-automation');
  if (!existsSync(gaDir)) {
    process.stderr.write(
      `Error: graph-automation templates not found at ${gaDir}\n` +
      `  For a dev checkout: run bash setup.sh to populate vendor/\n` +
      `  For an npx install: try npm install -g ai-catapult to reinstall\n`,
    );
    process.exit(1);
  }

  const wrapperTemplate = readFileSync(join(gaDir, 'graph-refresh.sh'), 'utf8');
  const hookBodyTemplate = readFileSync(join(gaDir, 'hook-body.sh'), 'utf8');
  const configTemplate = readFileSync(join(gaDir, 'config.json'), 'utf8');
  const harnessTemplate = readFileSync(join(gaDir, 'harness-hooks.json'), 'utf8');

  // Substitute {{ENGINE}} token
  const wrapperContent = wrapperTemplate.replaceAll('{{ENGINE}}', engine);
  const harnessConfig = JSON.parse(harnessTemplate.replaceAll('{{ENGINE}}', engine));

  // Build config.json with the chosen engine
  const configObj = JSON.parse(configTemplate);
  configObj.engine = engine;
  const configContent = JSON.stringify(configObj, null, 2);

  if (dryRun) {
    const hooksDir = resolveHooksDir(targetDir);
    process.stdout.write('[dry-run] No changes will be made.\n');
    process.stdout.write(`[dry-run] Would write: ${join(hooksDir, 'post-commit')}\n`);
    process.stdout.write(`[dry-run] Would write: ${join(hooksDir, 'post-checkout')}\n`);
    process.stdout.write(`[dry-run] Would write: ${join(targetDir, 'scripts', 'graph-refresh.sh')}\n`);
    process.stdout.write(`[dry-run] Would write: ${join(targetDir, 'graph-automation', 'config.json')}\n`);
    process.stdout.write(`[dry-run] Would print: harness hook NEXT-STEPS\n`);
    return;
  }

  // Resolve hooks directory (honors core.hooksPath)
  const hooksDir = resolveHooksDir(targetDir);
  mkdirSync(hooksDir, { recursive: true });

  // Strip leading shebang from hook-body template before embedding in the
  // marker block — the hook file already has its own shebang at the top.
  const hookBodyContent = stripLeadingShebang(hookBodyTemplate);

  // Install git hooks (marker-managed)
  for (const hookName of ['post-commit', 'post-checkout']) {
    const hookPath = join(hooksDir, hookName);
    installMarkerBlock(hookPath, hookBodyContent);
  }

  // Copy wrapper script with engine substituted
  const scriptsDir = join(targetDir, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  const wrapperPath = join(scriptsDir, 'graph-refresh.sh');
  writeFileSync(wrapperPath, wrapperContent, 'utf8');
  chmodSync(wrapperPath, 0o755);

  // Write graph-automation/config.json
  const graphAutoDir = join(targetDir, 'graph-automation');
  mkdirSync(graphAutoDir, { recursive: true });
  writeFileSync(join(graphAutoDir, 'config.json'), configContent + '\n', 'utf8');

  process.stdout.write(`graph-hooks install: wired git hooks and wrapper in ${targetDir}\n`);
  process.stdout.write(`  engine: ${engine}\n`);
  process.stdout.write(`  hooks dir: ${hooksDir}\n`);
  process.stdout.write(`  wrapper: ${wrapperPath}\n`);
  process.stdout.write(`\n`);

  // Print harness NEXT-STEPS (never write to harness dirs)
  printHarnessNextSteps(harnessConfig, engine, targetDir);
}

// ---------------------------------------------------------------------------
// Graph-hooks verb dispatcher (graph-hooks <subverb>)
// ---------------------------------------------------------------------------

export const GRAPH_HOOKS_HELP = `Usage: ai-catapult graph-hooks <subcommand> [options]

Subcommands:
  install <target>   Wire git hooks and wrapper script into a target git repo

Options:
  -h, --help   Show this help`;

/**
 * Dispatch graph-hooks subcommands.
 * @param {string[]} argv - arguments after "graph-hooks" (already sliced)
 * @param {string} templatesDir - resolved templates directory
 */
export function runGraphHooks(argv, templatesDir) {
  const sub = argv[0];

  if (!sub || sub === '--help' || sub === '-h') {
    process.stdout.write(GRAPH_HOOKS_HELP + '\n');
    process.exit(0);
  }

  if (sub === 'install') {
    runGraphHooksInstall(argv.slice(1), templatesDir);
    return;
  }

  process.stderr.write(`Unknown graph-hooks subcommand: ${sub}. Run ai-catapult graph-hooks --help for usage.\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// NEXT-STEPS printer
// ---------------------------------------------------------------------------

function printHarnessNextSteps(harnessConfig, engine, targetDir) {
  const claudeEntry = harnessConfig?.hooks?.claude_code;
  const codexEntry = harnessConfig?.hooks?.codex;

  process.stdout.write('── Harness hook NEXT-STEPS ─────────────────────────────────────\n');
  process.stdout.write('\n');
  process.stdout.write('The git hooks are installed. To also wire the harness hooks\n');
  process.stdout.write('(Claude Code Stop + SessionStart, Codex), add the following\n');
  process.stdout.write('snippets to the respective config files in your repo.\n');
  process.stdout.write('\n');

  if (claudeEntry) {
    process.stdout.write(`Claude Code — ${claudeEntry.config_file}:\n`);
    process.stdout.write(`  ${claudeEntry.note}\n`);
    for (const entry of claudeEntry.entries ?? []) {
      process.stdout.write(`\n  Event: ${entry.event}\n`);
      process.stdout.write(`  Command: ${entry.command}\n`);
      if (entry.description) {
        process.stdout.write(`  # ${entry.description}\n`);
      }
    }
    process.stdout.write('\n');
  }

  if (codexEntry) {
    process.stdout.write(`Codex — ${codexEntry.config_file}:\n`);
    process.stdout.write(`  ${codexEntry.note}\n`);
    for (const [event, entries] of Object.entries(codexEntry.entries ?? {})) {
      for (const entry of entries) {
        process.stdout.write(`\n  Event: ${event}\n`);
        process.stdout.write(`  Command: ${entry.command}\n`);
      }
    }
    process.stdout.write('\n');
  }

  process.stdout.write(`Engine: ${engine} (change in graph-automation/config.json, then re-run install)\n`);
  process.stdout.write('────────────────────────────────────────────────────────────────\n');
}
