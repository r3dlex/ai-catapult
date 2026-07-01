/**
 * install.js — wire assembled plugins into Claude Code and/or Codex harnesses.
 *
 * Install targets:
 *   Claude Code: ${HOME}/.claude/plugins/cache/ai-catapult-local/ai-catapult/local/
 *                + update ${HOME}/.claude/plugins/installed_plugins.json
 *   Codex:       ${CODEX_HOME}/plugins/cache/ai-catapult-local/ai-catapult/local/
 *                + write ${CODEX_HOME}/plugins/ai-catapult-local/marketplace.json
 *
 * All layout decisions follow the real installed plugin examples in ~/.claude and ~/.codex.
 */

import {
  existsSync,
  mkdirSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
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
 * @param {string} script  - shell script filename under scripts/
 * @param {string} distDir - dist output directory; rebuilds if absent
 * @param {boolean} dryRun - if true, skip
 */
function ensureBuilt(script, distDir, dryRun) {
  if (dryRun) return;
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

  // Dir exists but has no manifest — treat as safe (empty dir from prior failed install)
  return true;
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
 * Target: ${HOME}/.claude/plugins/cache/ai-catapult-local/ai-catapult/local/
 *
 * @param {object} opts
 * @param {string} opts.claudeDir - ${HOME}/.claude/
 * @param {boolean} opts.dryRun
 * @param {boolean} opts.force
 */
function installClaude({ claudeDir, dryRun, force }) {
  const pluginRoot = join(claudeDir, 'plugins', 'cache', MARKETPLACE_NAME, PLUGIN_NAME, VERSION_DIR);
  const installedPluginsPath = join(claudeDir, 'plugins', 'installed_plugins.json');

  if (dryRun) {
    process.stdout.write(`[dry-run] claude: would install to ${pluginRoot}\n`);
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
  const distDir = join(DIST_ROOT, 'claude-plugin');
  ensureBuilt('build-claude-plugin.sh', distDir, dryRun);

  // Copy dist/claude-plugin → pluginRoot
  resetDir(pluginRoot);
  cpSync(distDir, pluginRoot, { recursive: true });

  // Update installed_plugins.json
  const pluginsDir = join(claudeDir, 'plugins');
  mkdirSync(pluginsDir, { recursive: true });

  let installedPlugins = { version: 2, plugins: {} };
  if (existsSync(installedPluginsPath)) {
    try {
      installedPlugins = JSON.parse(readFileSync(installedPluginsPath, 'utf8'));
      if (!installedPlugins.plugins) installedPlugins.plugins = {};
    } catch {
      // corrupt — reset
      installedPlugins = { version: 2, plugins: {} };
    }
  }

  const key = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
  // Read version from installed plugin.json
  const pluginJson = join(pluginRoot, '.claude-plugin', 'plugin.json');
  const manifest = JSON.parse(readFileSync(pluginJson, 'utf8'));
  const now = new Date().toISOString();

  // Idempotent: replace existing entry entirely (no duplicates)
  installedPlugins.plugins[key] = [
    {
      scope: 'user',
      installPath: pluginRoot,
      version: manifest.version,
      installedAt: now,
      lastUpdated: now,
    },
  ];

  writeFileSync(installedPluginsPath, JSON.stringify(installedPlugins, null, 2) + '\n', 'utf8');

  process.stdout.write(`Installed Claude Code plugin ai-catapult@${manifest.version}\n`);
  process.stdout.write(`  → ${pluginRoot}\n`);
  process.stdout.write(`\nNext step: reload Claude Code or run:\n`);
  process.stdout.write(`  /plugin marketplace add ${pluginRoot}\n`);
}

// ---------------------------------------------------------------------------
// Codex install
// ---------------------------------------------------------------------------

/**
 * Install the Codex plugin.
 * Target: ${CODEX_HOME}/plugins/cache/ai-catapult-local/ai-catapult/local/
 * Marketplace: ${CODEX_HOME}/plugins/ai-catapult-local/marketplace.json
 *
 * @param {object} opts
 * @param {string} opts.codexHome - ${CODEX_HOME:-~/.codex}
 * @param {boolean} opts.dryRun
 * @param {boolean} opts.force
 */
function installCodex({ codexHome, dryRun, force }) {
  const pluginRoot = join(codexHome, 'plugins', 'cache', MARKETPLACE_NAME, PLUGIN_NAME, VERSION_DIR);
  const marketplaceDir = join(codexHome, 'plugins', MARKETPLACE_NAME);
  const marketplaceFile = join(marketplaceDir, 'marketplace.json');

  if (dryRun) {
    process.stdout.write(`[dry-run] codex: would install to ${pluginRoot}\n`);
    process.stdout.write(`[dry-run] codex: would write marketplace.json at ${marketplaceFile}\n`);
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
  const pluginJson = join(pluginRoot, '.codex-plugin', 'plugin.json');
  const manifest = JSON.parse(readFileSync(pluginJson, 'utf8'));

  // Write marketplace.json (idempotent — full overwrite)
  mkdirSync(marketplaceDir, { recursive: true });
  const marketplace = {
    name: MARKETPLACE_NAME,
    interface: { displayName: 'ai-catapult Local' },
    plugins: [
      {
        name: PLUGIN_NAME,
        source: {
          source: 'local',
          path: pluginRoot,
        },
        policy: {
          installation: 'AVAILABLE',
          authentication: 'NONE',
        },
        category: 'Developer Tools',
      },
    ],
  };
  writeFileSync(marketplaceFile, JSON.stringify(marketplace, null, 2) + '\n', 'utf8');

  process.stdout.write(`Installed Codex plugin ai-catapult@${manifest.version}\n`);
  process.stdout.write(`  → ${pluginRoot}\n`);
  process.stdout.write(`  marketplace: ${marketplaceFile}\n`);
  process.stdout.write(`\nNext step: in Codex, invoke the ai-catapult-init skill.\n`);
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
