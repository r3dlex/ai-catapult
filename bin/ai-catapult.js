#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import { scaffold } from '../src/scaffold.js';
import { runInstall } from '../src/install.js';
import { runGraphHooks } from '../src/graph-hooks.js';
import { resolveVendorSkill } from '../src/skill-resolver.js';
import { runMatrixRuntime } from '../src/matrix-runtime.js';
import { runCiAdaptersRuntime } from '../src/ci-adapters-runtime.js';
import {
  assertReadmeWriteAllowed,
  generateScaffoldReadme,
  resolveReadmeContract,
  reviewedReadmeSha,
} from '../src/readme-contract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

// Resolve the templates directory.
//   1. catalog-resolved vendored skill templates — present in dev checkouts (after setup.sh)
//   2. dist/skill-templates/                      — staged by prepack; ships in the npm tarball
// vendor/ is intentionally excluded from the published package so only (2) is available
// when the CLI is installed via npx or npm install.
const _VENDOR_SKILLS = process.env.AI_CATAPULT_VENDOR_SKILLS || join(__dirname, '..', 'vendor/skills');
const _DIST_TEMPLATES   = join(__dirname, '..', 'dist/skill-templates');
const _DIST_DIR = join(__dirname, '..', 'dist');

function resolveTemplatesDir() {
  if (existsSync(_VENDOR_SKILLS)) {
    try {
      return join(resolveVendorSkill(_VENDOR_SKILLS), 'templates');
    } catch (error) {
      process.stderr.write(`Error: ${error.message}\n`);
      process.exit(1);
    }
  }
  if (existsSync(_DIST_TEMPLATES))   return _DIST_TEMPLATES;
  process.stderr.write(
    'Error: template directory not found.\n' +
    '  For a dev checkout: run  bash setup.sh  to populate vendor/\n' +
    '  For an npx install:  try  npm install -g ai-catapult  to reinstall the package\n',
  );
  process.exit(1);
}

const TEMPLATES_DIR = resolveTemplatesDir();

const HELP = `Usage: ai-catapult <command> [options]

Commands:
  init [target]                Scaffold v3 .ai/ governance skeleton into <target> (default: cwd)
  matrix <validate|project>    Run the pinned matrix v1.0/v1.1 contract runtime
  ci-adapters                  Render/check matrix-selected GitHub, ADO, and GitLab CI adapters
  install                      Install Claude Code and Codex plugins into detected harnesses
  graph-hooks install <target> Wire graph-automation git hooks and wrapper into a target git repo

Options:
  -v, --version  Print version
  -h, --help     Show this help`;

const INIT_HELP = `Usage: ai-catapult init [target] [options]

Scaffold the mechanical v3 .ai/ governance skeleton into <target>.
No LLM required. Judgment-laden content is deferred to the in-harness plugin.

Arguments:
  target               Directory to scaffold into (default: current directory)

Options:
  --repo-id <id>         Repository identifier, e.g. "my-repo"     (default: basename of target)
  --date <YYYY-MM-DD>    Scaffold date token                        (default: today)
  --upstream-url <url>   Upstream git URL for matrix.json           (default: "")
  --upstream-ref <ref>   Upstream git ref for matrix.json           (default: "main")
  --force                Overwrite existing files without error
  -h, --help             Show this help`;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/**
 * Parse flags from an argv array (already sliced past [node, script]).
 * Returns { positionals: string[], flags: Map<string, string|boolean>, firstPositionalIdx: number }
 * --foo bar   → flags.get('foo') === 'bar'
 * --foo       → flags.get('foo') === true
 * -h          → flags.get('h') === true
 */
function parseArgs(argv) {
  const positionals = [];
  const flags = new Map();
  // Track the raw index of the first positional in argv (for subcommand slicing)
  let firstPositionalIdx = -1;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
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
      if (firstPositionalIdx === -1) firstPositionalIdx = i;
      positionals.push(arg);
      i += 1;
    }
  }
  return { positionals, flags, firstPositionalIdx };
}

// ---------------------------------------------------------------------------
// Finish prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the structured next-steps block shown to the user after a successful
 * scaffold. Content is deterministic given same inputs.
 *
 * @param {object} opts
 * @param {string}   opts.targetDir           - resolved absolute target path (used in "scaffolded into" line)
 * @param {string}   opts.pathDisplay         - base used for anchor path bullet lines (e.g. targetDir for
 *                                              stdout, '.' for the file so it stays machine-independent)
 * @param {string[]} opts.emittedPaths         - relative paths actually written
 * @param {string[]} opts.judgmentLadenPaths   - from boundary-manifest.json
 * @returns {string}
 */
function buildFinishPrompt({ targetDir, pathDisplay, emittedPaths, judgmentLadenPaths }) {
  // Pick two anchor paths that are always mechanical (existence already verified
  // by scaffold — if they are missing scaffold would have failed earlier).
  const matrixPath = emittedPaths.includes('.ai/matrix.json') ? '.ai/matrix.json' : emittedPaths[0] ?? null;
  const agentsPath = emittedPaths.includes('AGENTS.md') ? 'AGENTS.md' : null;

  const anchorLines = [];
  if (matrixPath) anchorLines.push(`  • ${pathDisplay}/${matrixPath}`);
  if (agentsPath) anchorLines.push(`  • ${pathDisplay}/${agentsPath}`);

  const jlLines = judgmentLadenPaths.map((p) => `  • ${p}`).join('\n');

  return [
    '╔══════════════════════════════════════════════════════════════╗',
    '║          ai-catapult — scaffold complete                     ║',
    '╚══════════════════════════════════════════════════════════════╝',
    '',
    'Mechanical v3 skeleton scaffolded into:',
    `  ${pathDisplay}`,
    '',
    'Key emitted paths (verified on disk):',
    ...anchorLines,
    '',
    'Judgment-laden phases NOT yet written (require in-harness plugin):',
    jlLines,
    '',
    '── Next step: complete in-harness ─────────────────────────────',
    '',
    '1. Install the ai-catapult plugin:',
    '     npx ai-catapult install',
    '',
    '2. Open the scaffolded repo in Claude Code or Codex, then run:',
    '     Claude Code:  /ai-catapult-init',
    '     Codex:        invoke the ai-catapult-init skill',
    '',
    'The ai-catapult-init skill will guide you through topology decisions,',
    'ADRs, cascade configuration, and traceability — the judgment-laden',
    'phases that require knowledge of your specific repository.',
    '────────────────────────────────────────────────────────────────',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Subcommand: init
// ---------------------------------------------------------------------------

function runInit(argv) {
  const { positionals, flags } = parseArgs(argv);

  if (flags.has('help') || flags.has('h')) {
    console.log(INIT_HELP);
    process.exit(0);
  }

  const targetDir = positionals[0] ? resolve(positionals[0]) : process.cwd();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const repoId = String(flags.get('repo-id') || basename(targetDir));
  const date = String(flags.get('date') || today);
  const upstreamUrl = String(flags.get('upstream-url') || '');
  const upstreamRef = String(flags.get('upstream-ref') || 'main');
  const force = flags.has('force');

  let readmeContract;
  try {
    readmeContract = resolveReadmeContract({ vendorSkillsDir: _VENDOR_SKILLS, distDir: _DIST_DIR });
    assertReadmeWriteAllowed(targetDir, force);
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exit(1);
  }
  const sourceSha = reviewedReadmeSha(targetDir);

  const { emittedPaths, judgmentLadenPaths } = scaffold({
    targetDir, templatesDir: TEMPLATES_DIR, repoId, date, upstreamUrl, upstreamRef, force,
  });

  try {
    generateScaffoldReadme({ contract: readmeContract, targetDir, repoId, force, sourceSha });
    emittedPaths.push('README.md');
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exit(1);
  }

  // Build finish prompt for stdout — uses absolute targetDir so the user sees
  // real paths they can open directly.
  const finishPromptStdout = buildFinishPrompt({ targetDir, pathDisplay: targetDir, emittedPaths, judgmentLadenPaths });

  // Emit to stdout.
  process.stdout.write(finishPromptStdout + '\n');

  // Build finish prompt for the file — uses '.' as the path base so the file
  // contains only relative paths and is byte-identical across machines/CI runs.
  const finishPromptFile = buildFinishPrompt({ targetDir, pathDisplay: '.', emittedPaths, judgmentLadenPaths });

  // Write to <target>/.ai/handoff/NEXT-STEPS.md.
  // Safe to write unconditionally: scaffold's collision guard has already run
  // and would have exited 1 on mechanical collisions before reaching this line.
  const nextStepsPath = join(targetDir, '.ai/handoff/NEXT-STEPS.md');
  mkdirSync(dirname(nextStepsPath), { recursive: true });
  writeFileSync(nextStepsPath, finishPromptFile, 'utf8');
}

// runInstall is imported from src/install.js

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

const rawArgv = process.argv.slice(2);
const { positionals: topPositionals, flags: topFlags, firstPositionalIdx } = parseArgs(rawArgv);

if (topFlags.has('version') || topFlags.has('v')) {
  console.log(pkg.version);
  process.exit(0);
}

const verb = topPositionals[0];

// Global --help/-h only when no verb is given; with a verb the subcommand
// handles its own --help flag.
if (!verb && (topFlags.has('help') || topFlags.has('h') || rawArgv.length === 0)) {
  console.log(HELP);
  process.exit(0);
}

// No verb and no global flag already handled above; bare invocation → help.
if (!verb) {
  console.log(HELP);
  process.exit(0);
}

if (verb === 'init') {
  // Fix #2: use firstPositionalIdx (the index of 'init' in rawArgv) rather than
  // rawArgv.indexOf('init'), which would match the first literal 'init' anywhere
  // — e.g. `ai-catapult --date init init <target>` would mis-dispatch to ./init.
  runInit(rawArgv.slice(firstPositionalIdx + 1));
  process.exit(0);
}

if (verb === 'install') {
  runInstall(rawArgv.slice(firstPositionalIdx + 1));
  process.exit(0);
}

if (verb === 'graph-hooks') {
  runGraphHooks(rawArgv.slice(firstPositionalIdx + 1), TEMPLATES_DIR);
  process.exit(0);
}

if (verb === 'matrix') {
  process.exit(runMatrixRuntime(rawArgv.slice(firstPositionalIdx + 1)));
}

if (verb === 'ci-adapters') {
  process.exit(runCiAdaptersRuntime(rawArgv.slice(firstPositionalIdx + 1)));
}

process.stderr.write(`Unknown argument: ${verb}. Run ai-catapult --help for usage.\n`);
process.exit(1);
