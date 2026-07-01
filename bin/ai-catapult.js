#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import { scaffold } from '../src/scaffold.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

const VENDOR_TEMPLATES = join(__dirname, '..', 'vendor/skills/ai-catapult-init/templates');

const HELP = `Usage: ai-catapult <command> [options]

Commands:
  init [target]  Scaffold v3 .ai/ governance skeleton into <target> (default: cwd)
  install        (coming in a later slice) Install Claude Code and Codex plugins

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
 * @param {string}   opts.targetDir           - resolved absolute target path
 * @param {string[]} opts.emittedPaths         - relative paths actually written
 * @param {string[]} opts.judgmentLadenPaths   - from boundary-manifest.json
 * @returns {string}
 */
function buildFinishPrompt({ targetDir, emittedPaths, judgmentLadenPaths }) {
  // Pick two anchor paths that are always mechanical (existence already verified
  // by scaffold — if they are missing scaffold would have failed earlier).
  const matrixPath = emittedPaths.includes('.ai/matrix.json') ? '.ai/matrix.json' : emittedPaths[0] ?? null;
  const agentsPath = emittedPaths.includes('AGENTS.md') ? 'AGENTS.md' : null;

  const anchorLines = [];
  if (matrixPath) anchorLines.push(`  • ${targetDir}/${matrixPath}`);
  if (agentsPath) anchorLines.push(`  • ${targetDir}/${agentsPath}`);

  const jlLines = judgmentLadenPaths.map((p) => `  • ${p}`).join('\n');

  return [
    '╔══════════════════════════════════════════════════════════════╗',
    '║          ai-catapult — scaffold complete                     ║',
    '╚══════════════════════════════════════════════════════════════╝',
    '',
    'Mechanical v3 skeleton scaffolded into:',
    `  ${targetDir}`,
    '',
    'Key emitted paths (verified on disk):',
    ...anchorLines,
    '',
    'Judgment-laden phases NOT yet written (require in-harness plugin):',
    jlLines,
    '',
    '── Next step: complete in-harness ─────────────────────────────',
    '',
    '1. Install the ai-catapult plugin (install command lands in an upcoming release —',
    '   for now, add the plugin manually or watch the repo):',
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

  const { emittedPaths, judgmentLadenPaths } = scaffold({
    targetDir, templatesDir: VENDOR_TEMPLATES, repoId, date, upstreamUrl, upstreamRef, force,
  });

  // Build finish prompt — deterministic given same inputs.
  const finishPrompt = buildFinishPrompt({ targetDir, emittedPaths, judgmentLadenPaths });

  // Emit to stdout.
  process.stdout.write(finishPrompt + '\n');

  // Write the same content to <target>/.ai/handoff/NEXT-STEPS.md.
  // Safe to write unconditionally: scaffold's collision guard has already run
  // and would have exited 1 on mechanical collisions before reaching this line.
  const nextStepsPath = join(targetDir, '.ai/handoff/NEXT-STEPS.md');
  mkdirSync(dirname(nextStepsPath), { recursive: true });
  writeFileSync(nextStepsPath, finishPrompt, 'utf8');
}

// ---------------------------------------------------------------------------
// Subcommand: install (stub)
// ---------------------------------------------------------------------------

function runInstall(_argv) {
  process.stderr.write('install: coming in a later slice.\n');
  process.exit(1);
}

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
  // runInstall always calls process.exit — unreachable, but process.exit here
  // makes the fallthrough unreachable by construction (fix #7).
  process.exit(1);
}

process.stderr.write(`Unknown argument: ${verb}. Run ai-catapult --help for usage.\n`);
process.exit(1);
