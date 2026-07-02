/**
 * install.js — wire assembled plugins into Claude Code and/or Codex harnesses.
 *
 * Install targets:
 *   Claude Code: copies payload to
 *                ${HOME}/.claude/plugins/ai-catapult/
 *                then prints the two-step manual registration:
 *                  /plugin marketplace add <payload-path>
 *                  /plugin install ai-catapult@<marketplace-name>
 *
 *   Codex:       copies payload to
 *                ${CODEX_HOME}/plugins/cache/ai-catapult-local/ai-catapult/local/
 *                then prints the TOML block the user must add to config.toml
 *
 * Neither handler writes to Claude Code's internal installed_plugins.json nor
 * to Codex's config.toml — those mutations are too invasive and carry corruption
 * risk. We copy the payload and tell the user exactly what to do.
 */

import {
  existsSync,
  mkdirSync,
  rmSync,
  cpSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// DIST_ROOT may be overridden via env (used by tests to point at a stable pre-built copy)
const DIST_ROOT = process.env.AI_CATAPULT_DIST_ROOT ?? join(REPO_ROOT, 'dist');

// Marketplace / plugin identifiers (stable across installs)
const MARKETPLACE_NAME = 'ai-catapult-local';
const PLUGIN_NAME = 'ai-catapult';
const VERSION_DIR = 'local'; // version dir for local installs

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Ensure the plugin dist is present, building it if needed.
 * @param {string} script   - shell script filename under scripts/
 * @param {string} distDir  - dist output directory; rebuilds if absent
 * @param {boolean} dryRun  - if true, skip
 */
function ensureBuilt(script, distDir, dryRun) {
  if (dryRun) return;

  // If DIST_ROOT was overridden via env and the distDir is missing, fail with
  // a clear message rather than silently rebuilding into the wrong place.
  if (process.env.AI_CATAPULT_DIST_ROOT && !existsSync(distDir)) {
    throw new Error(
      `AI_CATAPULT_DIST_ROOT is set but the expected dist directory is not populated.\n` +
      `Expected: ${distDir}\n` +
      `Run the build scripts first, or unset AI_CATAPULT_DIST_ROOT to use dist/.`,
    );
  }

  // Check for either harness manifest to determine if already built
  const claudeManifest = join(distDir, '.claude-plugin', 'plugin.json');
  const codexManifest = join(distDir, '.codex-plugin', 'plugin.json');
  if (existsSync(claudeManifest) || existsSync(codexManifest)) return;

  // dist absent or empty — build now
  const r = spawnSync('bash', [join(REPO_ROOT, 'scripts', script)], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    timeout: 60000,
  });
  if (r.status !== 0) {
    throw new Error(
      `Plugin not built and build script failed.\n` +
      `Run: bash scripts/${script}\n\n${r.stderr}\n${r.stdout}`,
    );
  }
}

/**
 * Check if an existing directory is a prior ai-catapult install (or empty).
 * Returns true if safe to overwrite without --force.
 *
 * Rules:
 *   - Dir does not exist → safe
 *   - Dir exists and is empty → safe
 *   - Dir exists and carries our plugin.json name → safe
 *   - Dir exists and is non-empty without our plugin.json → NOT safe
 */
function isSafeToOverwrite(dir) {
  if (!existsSync(dir)) return true;

  // Check for .claude-plugin/plugin.json
  const claudeManifest = join(dir, '.claude-plugin', 'plugin.json');
  if (existsSync(claudeManifest)) {
    try {
      const p = JSON.parse(readFileSync(claudeManifest, 'utf8'));
      return p.name === PLUGIN_NAME;
    } catch {
      return false;
    }
  }

  // Check for .codex-plugin/plugin.json
  const codexManifest = join(dir, '.codex-plugin', 'plugin.json');
  if (existsSync(codexManifest)) {
    try {
      const p = JSON.parse(readFileSync(codexManifest, 'utf8'));
      return p.name === PLUGIN_NAME;
    } catch {
      return false;
    }
  }

  // Dir exists but has no manifest — only safe if it is empty
  try {
    return readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

/**
 * Wipe and recreate a directory.
 */
function resetDir(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Claude Code install
// ---------------------------------------------------------------------------

/**
 * Install the Claude Code plugin.
 *
 * Copies the plugin payload to a stable path under ~/.claude/plugins/ai-catapult/
 * and prints the two-step manual registration the user must run inside Claude Code.
 * We do NOT write installed_plugins.json — that is a Claude Code internal file
 * and hand-writing it is brittle.
 *
 * @param {object} opts
 * @param {string} opts.claudeDir - ${HOME}/.claude/
 * @param {boolean} opts.dryRun
 * @param {boolean} opts.force
 */
function installClaude({ claudeDir, dryRun, force }) {
  // Stable payload path (not inside the cache hierarchy — avoids collision with
  // Claude Code's own cache management).
  const payloadPath = join(claudeDir, 'plugins', PLUGIN_NAME);

  if (dryRun) {
    process.stdout.write(`[dry-run] claude: would copy payload to ${payloadPath}\n`);
    process.stdout.write(`[dry-run] claude: would print /plugin registration instructions\n`);
    return;
  }

  // Safety check
  if (!isSafeToOverwrite(payloadPath)) {
    if (!force) {
      process.stderr.write(
        `Error: ${payloadPath} exists and is not a prior ai-catapult install.\n` +
        `Use --force to overwrite.\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`Warning: overwriting foreign plugin dir (--force)\n`);
  }

  // Build the plugin if dist is not already assembled
  const distDir = join(DIST_ROOT, 'claude-plugin');
  ensureBuilt('build-claude-plugin.sh', distDir, dryRun);

  // Copy dist/claude-plugin → payloadPath
  resetDir(payloadPath);
  cpSync(distDir, payloadPath, { recursive: true });

  // Read version from installed plugin.json
  const pluginJson = join(payloadPath, '.claude-plugin', 'plugin.json');
  const manifest = JSON.parse(readFileSync(pluginJson, 'utf8'));
  const marketplaceName = manifest.name ?? PLUGIN_NAME;

  process.stdout.write(`Installed Claude Code plugin ai-catapult@${manifest.version}\n`);
  process.stdout.write(`  payload: ${payloadPath}\n`);
  process.stdout.write(`\nTo register the plugin in Claude Code, run these two commands inside Claude Code:\n`);
  process.stdout.write(`\n  /plugin marketplace add ${payloadPath}\n`);
  process.stdout.write(`  /plugin install ${marketplaceName}@${MARKETPLACE_NAME}\n`);
  process.stdout.write(`\nThen reload Claude Code for the plugin to take effect.\n`);
}

// ---------------------------------------------------------------------------
// Codex install
// ---------------------------------------------------------------------------

/**
 * Install the Codex plugin.
 *
 * Copies the plugin payload to the standard Codex cache path and prints
 * the TOML block the user must add to their config.toml. We do NOT
 * auto-mutate config.toml — that carries corruption risk.
 *
 * Codex discovers plugins via config.toml tables:
 *   [marketplaces.<name>]   with source_type/source
 *   [plugins."<plugin>@<marketplace>"]  with enabled = true
 *
 * @param {object} opts
 * @param {string} opts.codexHome - ${CODEX_HOME:-~/.codex}
 * @param {boolean} opts.dryRun
 * @param {boolean} opts.force
 */
function installCodex({ codexHome, dryRun, force }) {
  const pluginRoot = join(codexHome, 'plugins', 'cache', MARKETPLACE_NAME, PLUGIN_NAME, VERSION_DIR);

  if (dryRun) {
    process.stdout.write(`[dry-run] codex: would copy payload to ${pluginRoot}\n`);
    process.stdout.write(`[dry-run] codex: would print TOML block for config.toml registration\n`);
    return;
  }

  // Safety check
  if (!isSafeToOverwrite(pluginRoot)) {
    if (!force) {
      process.stderr.write(
        `Error: ${pluginRoot} exists and is not a prior ai-catapult install.\n` +
        `Use --force to overwrite.\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`Warning: overwriting foreign plugin dir (--force)\n`);
  }

  // Build the plugin if dist is not already assembled
  const distDir = join(DIST_ROOT, 'codex-plugin');
  ensureBuilt('build-codex-plugin.sh', distDir, dryRun);

  // Copy dist/codex-plugin → pluginRoot
  resetDir(pluginRoot);
  cpSync(distDir, pluginRoot, { recursive: true });

  // Read version from installed plugin.json
  const pluginJsonPath = join(pluginRoot, '.codex-plugin', 'plugin.json');
  const manifest = JSON.parse(readFileSync(pluginJsonPath, 'utf8'));

  process.stdout.write(`Installed Codex plugin ai-catapult@${manifest.version}\n`);
  process.stdout.write(`  payload: ${pluginRoot}\n`);
  process.stdout.write(`\nTo register the plugin, add the following block to your Codex config.toml\n`);
  process.stdout.write(`(typically at \${CODEX_HOME:-~/.codex}/config.toml):\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`[marketplaces.${MARKETPLACE_NAME}]\n`);
  process.stdout.write(`source_type = "local"\n`);
  process.stdout.write(`source = "${pluginRoot}"\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`[plugins."${PLUGIN_NAME}@${MARKETPLACE_NAME}"]\n`);
  process.stdout.write(`enabled = true\n`);
  process.stdout.write(`\nThen restart Codex for the plugin to take effect.\n`);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

const INSTALL_HELP = `Usage: ai-catapult install [options]

Install the ai-catapult plugin into detected AI coding harnesses.

Detected harnesses:
  Claude Code   ~/.claude/ present
  Codex         \${CODEX_HOME:-~/.codex}/ present

Options:
  --harness <claude|codex|all>   Select harness(es) to install into (default: auto-detect)
  --dry-run                      Print what would happen without writing
  --force                        Overwrite existing dirs even if not a prior ai-catapult install
  -h, --help                     Show this help`;

/**
 * Main install handler.
 * @param {string[]} argv - arguments after "install" (already sliced)
 * @param {object} [envOverride] - override HOME / CODEX_HOME (for tests)
 */
export function runInstall(argv, envOverride = {}) {
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
    process.stdout.write(INSTALL_HELP + '\n');
    process.exit(0);
  }

  const dryRun = flags.has('dry-run');
  const force = flags.has('force');
  const harnessFlag = flags.get('harness'); // 'claude' | 'codex' | 'all' | undefined

  // Resolve dirs
  const home = envOverride.HOME ?? process.env.HOME ?? homedir();
  const codexHome = envOverride.CODEX_HOME
    ?? process.env.CODEX_HOME
    ?? join(home, '.codex');

  const claudeDir = join(home, '.claude');
  const claudeDetected = existsSync(claudeDir);
  const codexDetected = existsSync(codexHome);

  // Determine which harnesses to run
  let runClaude = false;
  let runCodex = false;

  if (harnessFlag === 'claude') {
    runClaude = true;
  } else if (harnessFlag === 'codex') {
    runCodex = true;
  } else if (harnessFlag === 'all') {
    runClaude = true;
    runCodex = true;
  } else {
    // Auto-detect
    runClaude = claudeDetected;
    runCodex = codexDetected;
  }

  if (!runClaude && !runCodex) {
    process.stdout.write(
      'No supported harness detected.\n' +
      '  Claude Code: ~/.claude/ not found\n' +
      `  Codex:       ${codexHome} not found\n` +
      '\nUse --harness claude|codex|all to force a harness.\n',
    );
    process.exit(0);
  }

  if (dryRun) {
    process.stdout.write('[dry-run] No changes will be made.\n');
  }

  if (runClaude) {
    if (!claudeDetected && !dryRun) {
      process.stdout.write(`Skipping Claude Code: ${claudeDir} not found\n`);
    } else {
      installClaude({ claudeDir, dryRun, force });
    }
  }

  if (runCodex) {
    if (!codexDetected && !dryRun) {
      process.stdout.write(`Skipping Codex: ${codexHome} not found\n`);
    } else {
      installCodex({ codexHome, dryRun, force });
    }
  }
}
