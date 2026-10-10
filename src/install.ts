/**
 * install.ts — wire assembled plugins into Claude Code and/or Codex harnesses.
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
import { sweepContractDrift } from './contract-drift.ts';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { moduleDir, packageRoot } from './paths.ts';

const root = packageRoot(moduleDir(import.meta.url));

// DIST_ROOT may be overridden via env (used by tests to point at a stable pre-built copy)
const DIST_ROOT = process.env.AI_CATAPULT_DIST_ROOT ?? join(root, 'dist');

// Marketplace / plugin identifiers (stable across installs)
const MARKETPLACE_NAME = 'ai-catapult-local';
const PLUGIN_NAME = 'ai-catapult';
const VERSION_DIR = 'local'; // version dir for local installs

type EnvOverride = {
  HOME?: string;
  CODEX_HOME?: string;
  XDG_CONFIG_HOME?: string;
};

type ClaudePluginManifest = { name?: string; version?: string };
type MarketplaceManifest = { name?: string };
type OpencodePluginManifest = { version?: string; skills?: string[]; commands?: string[] };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Ensure the plugin dist is present, building it if needed.
 * @param {string} script   - node script filename under scripts/
 * @param {string} distDir  - dist output directory; rebuilds if absent
 * @param {boolean} dryRun  - if true, skip
 */
function ensureBuilt(script: string, distDir: string, dryRun: boolean): void {
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

  // Check for any harness manifest to determine if already built
  const claudeManifest = join(distDir, '.claude-plugin', 'plugin.json');
  const codexManifest = join(distDir, '.codex-plugin', 'plugin.json');
  const opencodeManifest = join(distDir, '.opencode-plugin', 'plugin.json');
  if (existsSync(claudeManifest) || existsSync(codexManifest) || existsSync(opencodeManifest)) return;

  // dist absent or empty — build now; pin DIST_ROOT so the script writes the
  // same root this caller reads from (module DIST_ROOT may be overridden)
  const r = spawnSync(process.execPath, [join(root, 'scripts', script)], {
    encoding: 'utf8',
    cwd: root,
    timeout: 60000,
    env: { ...process.env, DIST_ROOT },
  });
  if (r.status !== 0) {
    throw new Error(
      `Plugin not built and build script failed.\n` +
      `Run: node scripts/${script}\n\n${r.stderr}\n${r.stdout}`,
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
 *   - Dir exists and carries our plugin.json name (any known harness) → safe
 *   - Dir exists and is non-empty without our plugin.json → NOT safe
 */
function isSafeToOverwrite(dir: string): boolean {
  if (!existsSync(dir)) return true;

  for (const manifestDir of ['.claude-plugin', '.codex-plugin', '.opencode-plugin']) {
    const manifestPath = join(dir, manifestDir, 'plugin.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string } | null;
      return manifest?.name === PLUGIN_NAME;
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
 * Enforce the prior-install ownership rule at one target path.
 *
 * Exits(1) on a foreign non-empty target without --force; warns when
 * --force overrides. One home for the invariant README documents as
 * "install refuses to replace a foreign plugin directory".
 */
function assertOwnInstallTarget(targetPath: string, { force }: { force: boolean }): void {
  if (isSafeToOverwrite(targetPath)) return;
  if (!force) {
    process.stderr.write(
      `Error: ${targetPath} exists and is not a prior ai-catapult install.\n` +
      `Use --force to overwrite.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`Warning: overwriting foreign plugin dir (--force)\n`);
}

/**
 * Wipe and recreate a directory.
 */
function resetDir(dir: string): void {
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
 */
function installClaude({ claudeDir, dryRun, force }: { claudeDir: string; dryRun: boolean; force: boolean }): void {
  // Stable payload path (not inside the cache hierarchy — avoids collision with
  // Claude Code's own cache management).
  const payloadPath = join(claudeDir, 'plugins', PLUGIN_NAME);

  if (dryRun) {
    process.stdout.write(`[dry-run] claude: would copy payload to ${payloadPath}\n`);
    process.stdout.write(`[dry-run] claude: would print /plugin registration instructions\n`);
    return;
  }

  assertOwnInstallTarget(payloadPath, { force });

  // Build the plugin if dist is not already assembled
  const distDir = join(DIST_ROOT, 'claude-plugin');
  ensureBuilt('build-claude-plugin.ts', distDir, dryRun);

  // Copy dist/claude-plugin → payloadPath
  resetDir(payloadPath);
  cpSync(distDir, payloadPath, { recursive: true });

  // Read version from installed plugin.json
  const pluginJson = join(payloadPath, '.claude-plugin', 'plugin.json');
  const manifest = JSON.parse(readFileSync(pluginJson, 'utf8')) as ClaudePluginManifest;

  // Read the marketplace name from marketplace.json — single source of truth.
  // The marketplace name is the `name` field of the marketplace payload, which
  // is what `/plugin install <plugin>@<marketplace>` expects as the marketplace
  // half of the ref.
  const marketplaceJson = join(payloadPath, '.claude-plugin', 'marketplace.json');
  const marketplaceManifest = JSON.parse(readFileSync(marketplaceJson, 'utf8')) as MarketplaceManifest;
  const marketplaceRef = marketplaceManifest.name ?? PLUGIN_NAME;
  const pluginRef = manifest.name ?? PLUGIN_NAME;

  process.stdout.write(`Installed Claude Code plugin ai-catapult@${manifest.version}\n`);
  process.stdout.write(`  payload: ${payloadPath}\n`);
  process.stdout.write(`\nTo register the plugin in Claude Code, run these two commands inside Claude Code:\n`);
  process.stdout.write(`\n  /plugin marketplace add ${payloadPath}\n`);
  process.stdout.write(`  /plugin install ${pluginRef}@${marketplaceRef}\n`);
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
 */
function installCodex({ codexHome, dryRun, force }: { codexHome: string; dryRun: boolean; force: boolean }): void {
  const pluginRoot = join(codexHome, 'plugins', 'cache', MARKETPLACE_NAME, PLUGIN_NAME, VERSION_DIR);

  if (dryRun) {
    process.stdout.write(`[dry-run] codex: would copy payload to ${pluginRoot}\n`);
    process.stdout.write(`[dry-run] codex: would print TOML block for config.toml registration\n`);
    return;
  }

  assertOwnInstallTarget(pluginRoot, { force });

  // Build the plugin if dist is not already assembled
  const distDir = join(DIST_ROOT, 'codex-plugin');
  ensureBuilt('build-codex-plugin.ts', distDir, dryRun);

  // Copy dist/codex-plugin → pluginRoot
  resetDir(pluginRoot);
  cpSync(distDir, pluginRoot, { recursive: true });

  // Read version from installed plugin.json
  const pluginJsonPath = join(pluginRoot, '.codex-plugin', 'plugin.json');
  const manifest = JSON.parse(readFileSync(pluginJsonPath, 'utf8')) as ClaudePluginManifest;

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
// OpenCode install
// ---------------------------------------------------------------------------

/**
 * Install the OpenCode payload.
 *
 * OpenCode has no plugin registry file: it scans well-known directories under
 * its config root. The installer therefore MERGES owned entries additively:
 *   skills/<name>/    ← dist/opencode-plugin/skills/<name>/     (verbatim dirs)
 *   command/<name>.md ← dist/opencode-plugin/command/<name>.md
 *
 * Only entries named in the payload manifest are touched — foreign content is
 * preserved byte-for-byte, and opencode.jsonc is NEVER read or written
 * (user-owned, strict schema validation on OpenCode's side).
 */
function installOpenCode({ opencodeDir, dryRun }: { opencodeDir: string; dryRun: boolean }): void {
  const payloadRoot = join(DIST_ROOT, 'opencode-plugin');

  if (dryRun) {
    process.stdout.write(`[dry-run] opencode: would merge owned skills+commands into ${opencodeDir}\n`);
    process.stdout.write(`[dry-run] opencode: would print restart instructions\n`);
    return;
  }

  // Build the payload if dist is not already assembled
  ensureBuilt('build-opencode-plugin.ts', payloadRoot, dryRun);

  // Read version + owned-entry names from the payload manifest
  const manifestPath = join(payloadRoot, '.opencode-plugin', 'plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as OpencodePluginManifest;

  let entries = 0;
  for (const name of manifest.skills ?? []) {
    const dest = join(opencodeDir, 'skills', name);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(payloadRoot, 'skills', name), dest, { recursive: true });
    entries += 1;
  }
  for (const name of manifest.commands ?? []) {
    const dest = join(opencodeDir, 'command', `${name}.md`);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(payloadRoot, 'command', `${name}.md`), dest);
    entries += 1;
  }

  process.stdout.write(`Installed OpenCode payload ai-catapult@${manifest.version} (${entries} entries)\n`);
  process.stdout.write(`  skills:  ${join(opencodeDir, 'skills')}\n`);
  process.stdout.write(`  command: ${join(opencodeDir, 'command')}\n`);
  process.stdout.write(`\nQuit and restart OpenCode for the changes to take effect.\n`);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

const INSTALL_HELP = `Usage: ai-catapult install [options]

Install the ai-catapult plugin into detected AI coding harnesses.

Detected harnesses:
  Claude Code   ~/.claude/ present
  Codex         \${CODEX_HOME:-~/.codex}/ present
  OpenCode      \${XDG_CONFIG_HOME:-~/.config}/opencode/ present

Options:
  --harness <claude|codex|opencode|all>   Select harness(es) to install into (default: auto-detect)
  --dry-run                      Print what would happen without writing
  --force                        Overwrite existing dirs even if not a prior ai-catapult install
  -h, --help                     Show this help`;

type InstallParsedArgs = {
  flags: Map<string, string | boolean>;
  positionals: string[];
};

/** Parse install flags: `--key value`, `--bool`, `-x` short flags, and a `--` positional stop. */
function parseInstallArgs(argv: string[]): InstallParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) break; // unreachable: loop guard ensures a defined arg
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
  return { flags, positionals };
}

type HarnessTargets = { claude: boolean; codex: boolean; opencode: boolean };

/**
 * Determine which harnesses to run: named selection via --harness, or
 * auto-detection when the flag is absent or unrecognized.
 */
function resolveHarnessTargets(
  harnessFlag: string | boolean | undefined,
  detected: HarnessTargets,
): HarnessTargets {
  if (harnessFlag === 'claude') return { claude: true, codex: false, opencode: false };
  if (harnessFlag === 'codex') return { claude: false, codex: true, opencode: false };
  if (harnessFlag === 'opencode') return { claude: false, codex: false, opencode: true };
  if (harnessFlag === 'all') return { claude: true, codex: true, opencode: true };
  // Auto-detect
  return detected;
}

/** Resolve install root dirs from the override / process env, mirroring the sweep env. */
function resolveInstallDirs(envOverride: EnvOverride): {
  home: string;
  codexHome: string;
  xdgConfig: string;
  opencodeDir: string;
  claudeDir: string;
} {
  const home = envOverride.HOME ?? process.env.HOME ?? homedir();
  const codexHome = envOverride.CODEX_HOME
    ?? process.env.CODEX_HOME
    ?? join(home, '.codex');
  const xdgConfig = envOverride.XDG_CONFIG_HOME
    ?? process.env.XDG_CONFIG_HOME
    ?? join(home, '.config');
  return {
    home,
    codexHome,
    xdgConfig,
    opencodeDir: join(xdgConfig, 'opencode'),
    claudeDir: join(home, '.claude'),
  };
}

/**
 * Skip-or-run one harness install: absent harness dirs are only fatal-looking
 * when a real (non-dry) run was requested for them.
 */
function skipOrInstall(
  name: string,
  dir: string,
  run: boolean,
  detected: boolean,
  dryRun: boolean,
  install: () => void,
): void {
  if (!run) return;
  if (!detected && !dryRun) {
    process.stdout.write(`Skipping ${name}: ${dir} not found\n`);
    return;
  }
  install();
}

/** Print the drift sweep failure report naming path/expected/actual, then exit non-zero. */
function printSweepFailure(sweep: ReturnType<typeof sweepContractDrift>): void {
  process.stderr.write('Readiness contract drift sweep FAILED: installed payload differs from the pinned readiness-contract bytes.\n');
  for (const surface of sweep.surfaces) {
    if (surface.status === 'absent') continue;
    process.stderr.write(`  ${surface.status}: ${surface.label}\n`);
    for (const finding of surface.findings) {
      process.stderr.write(`    path: ${finding.path} (${finding.kind})\n`);
      process.stderr.write(`    expected: ${finding.expected}\n`);
      process.stderr.write(`    actual:   ${finding.actual}\n`);
    }
    for (const hint of surface.refreshHints) {
      process.stderr.write(`    refresh: ${hint}\n`);
    }
  }
  process.exit(sweep.exitCode);
}

/**
 * Main install handler.
 * @param {string[]} argv - arguments after "install" (already sliced)
 * @param {EnvOverride} [envOverride] - override HOME / CODEX_HOME (for tests)
 */
export function runInstall(argv: string[], envOverride: EnvOverride = {}): void {
  const { flags } = parseInstallArgs(argv);

  if (flags.has('help') || flags.has('h')) {
    process.stdout.write(INSTALL_HELP + '\n');
    process.exit(0);
  }

  const dryRun = flags.has('dry-run');
  const force = flags.has('force');
  const harnessFlag = flags.get('harness'); // 'claude' | 'codex' | 'all' | undefined

  // Resolve dirs
  const { home, codexHome, xdgConfig, opencodeDir, claudeDir } = resolveInstallDirs(envOverride);

  const targets = resolveHarnessTargets(harnessFlag, {
    claude: existsSync(claudeDir),
    codex: existsSync(codexHome),
    opencode: existsSync(opencodeDir),
  });

  if (!targets.claude && !targets.codex && !targets.opencode) {
    process.stdout.write(
      'No supported harness detected.\n' +
      '  Claude Code: ~/.claude/ not found\n' +
      `  Codex:       ${codexHome} not found\n` +
      `  OpenCode:    ${opencodeDir} not found\n` +
      '\nUse --harness claude|codex|opencode|all to force a harness.\n',
    );
    process.exit(0);
  }

  if (dryRun) {
    process.stdout.write('[dry-run] No changes will be made.\n');
  }

  skipOrInstall('Claude Code', claudeDir, targets.claude, existsSync(claudeDir), dryRun, () => {
    installClaude({ claudeDir, dryRun, force });
  });

  skipOrInstall('Codex', codexHome, targets.codex, existsSync(codexHome), dryRun, () => {
    installCodex({ codexHome, dryRun, force });
  });

  skipOrInstall('OpenCode', opencodeDir, targets.opencode, existsSync(opencodeDir), dryRun, () => {
    installOpenCode({ opencodeDir, dryRun });
  });

  // ACH-C-02 (AC-8): after any real install, sweep the six readiness-contract
  // deployment surfaces — every file named in the vendored readiness-dependency
  // manifests must match its pinned sha256 wherever the plugin payload lives.
  // Dry-run writes nothing, so there is nothing to verify. Drift exits
  // non-zero naming path/expected/actual; loaded-cache drift additionally
  // prints the marketplace refresh commands.
  if (!dryRun) {
    const sweep = sweepContractDrift({
      env: { HOME: home, CODEX_HOME: codexHome, XDG_CONFIG_HOME: xdgConfig },
      vendorRoot: join(root, 'vendor', 'skills'),
      distRoot: DIST_ROOT,
    });
    if (sweep.ok) {
      const matched = sweep.surfaces.filter((s) => s.status === 'ok').length;
      const skipped = sweep.surfaces.filter((s) => s.status === 'absent').length;
      process.stdout.write(`Readiness contract drift sweep: ok (${matched} surfaces match pinned bytes, ${skipped} absent skipped)\n`);
    } else {
      printSweepFailure(sweep);
    }
  }
}