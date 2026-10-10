#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { scaffold } from '../src/scaffold.ts';
import { runInstall } from '../src/install.ts';
import { runGraphHooks } from '../src/graph-hooks.ts';
import { resolveVendorSkill } from '../src/skill-resolver.ts';
import { runMatrixRuntime } from '../src/matrix-runtime.ts';
import { runCiAdaptersRuntime } from '../src/ci-adapters-runtime.ts';
import { runKnowledge } from '../src/knowledge.ts';
import type { ReadmeContract } from '../src/readme-contract.ts';
import {
  assertReadmeWriteAllowed,
  generateScaffoldReadme,
  preflightScaffoldReadme,
  resolveReadmeContract,
  reviewedReadmeSha,
} from '../src/readme-contract.ts';
import { moduleDir, packageRoot } from '../src/paths.ts';

// Resolve the templates directory.
//   1. catalog-resolved vendored skill templates — present in dev checkouts (after setup.sh)
//   2. dist/skill-templates/                      — staged by prepack; ships in the npm tarball
// vendor/ is intentionally excluded from the published package so only (2) is available
// when the CLI is installed via npx or npm install.
const VENDOR_SKILLS = process.env.AI_CATAPULT_VENDOR_SKILLS || join(packageRoot(moduleDir(import.meta.url)), 'vendor/skills');
const DIST_TEMPLATES = join(packageRoot(moduleDir(import.meta.url)), 'dist/skill-templates');
const DIST_DIR = join(packageRoot(moduleDir(import.meta.url)), 'dist');
const TEMPLATES_DIR = resolveTemplatesDir();

function resolveTemplatesDir(): string {
  if (existsSync(VENDOR_SKILLS)) {
    try {
      return join(resolveVendorSkill(VENDOR_SKILLS), 'templates');
    } catch (error) {
      process.stderr.write(`Error: ${(error as Error).message}\n`);
      process.exit(1);
    }
  }
  if (existsSync(DIST_TEMPLATES)) return DIST_TEMPLATES;
  process.stderr.write(
    'Error: template directory not found.\n' +
    '  For a dev checkout: run  node scripts/setup.ts  to populate vendor/\n' +
    '  For an npx install:  try  npm install -g ai-catapult  to reinstall the package\n',
  );
  process.exit(1);
}

/** Skills root selected for scaffold: vendor mode when vendor/ exists, undefined → staged dist copy. */
function scaffoldSkillsDir(): string | undefined {
  return existsSync(VENDOR_SKILLS) ? VENDOR_SKILLS : undefined;
}

const HELP = `Usage: ai-catapult <command> [options]

Commands:
  init [target]                Scaffold v3 .ai/ governance skeleton into <target> (default: cwd)
  matrix <validate|project>    Run the pinned matrix v1.0/v1.1 contract runtime
  ci-adapters                  Render/check matrix-selected GitHub, ADO, and GitLab CI adapters
  install                      Install Claude Code and Codex plugins into detected harnesses
  graph-hooks install <target> Wire graph-automation git hooks and wrapper into a target git repo
  knowledge <verb>             Read the .ai/knowledge registry (list|find|show|verify|rebuild|serialize)

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

type ParsedArgs = {
  positionals: string[];
  flags: Map<string, string | boolean>;
  firstPositionalIdx: number;
};

/** Consume a `--flag [value]` token at position i, returning the next index. */
function consumeLongFlag(argv: string[], arg: string, i: number, flags: Map<string, string | boolean>): number {
  const next = argv[i + 1];
  if (next !== undefined && !next.startsWith('-')) {
    flags.set(arg.slice(2), next);
    return i + 2;
  }
  flags.set(arg.slice(2), true);
  return i + 1;
}

/**
 * Parse flags from an argv array (already sliced past [node, script]).
 * --foo bar   → flags.get('foo') === 'bar'
 * --foo       → flags.get('foo') === true
 * -h          → flags.get('h') === true
 */
function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  // Track the raw index of the first positional in argv (for subcommand slicing)
  let firstPositionalIdx = -1;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) break; // unreachable: loop guard ensures a defined token
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      i = consumeLongFlag(argv, arg, i, flags);
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
 * `pathDisplay` is the base for anchor path bullet lines (targetDir so stdout
 * shows real openable paths; '.' so the file stays machine-independent).
 */
function buildFinishPrompt(opts: { targetDir: string; pathDisplay: string; emittedPaths: string[]; judgmentLadenPaths: string[] }): string {
  const { pathDisplay, emittedPaths, judgmentLadenPaths } = opts;
  // Pick two anchor paths that are always mechanical (existence already verified
  // by scaffold — if they are missing scaffold would have failed earlier).
  const matrixPath = emittedPaths.includes('.ai/matrix.json') ? '.ai/matrix.json' : emittedPaths[0] ?? null;
  const agentsPath = emittedPaths.includes('AGENTS.md') ? 'AGENTS.md' : null;

  const anchorLines: string[] = [];
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
    '',
    'The plugin also ships the rest of the ai-catapult skill catalog for the',
    'discover, plan, generate, and validate phases that follow.',
    '────────────────────────────────────────────────────────────────',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Subcommand: init
// ---------------------------------------------------------------------------

function runInit(argv: string[]): void {
  const { positionals, flags } = parseArgs(argv);

  if (flags.has('help') || flags.has('h')) {
    process.stdout.write(`${INIT_HELP}\n`);
    process.exit(0);
  }

  const targetDir = positionals[0] ? resolve(positionals[0]) : process.cwd();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const repoId = String(flags.get('repo-id') || basename(targetDir));
  const date = String(flags.get('date') || today);
  const upstreamUrl = String(flags.get('upstream-url') || '');
  const upstreamRef = String(flags.get('upstream-ref') || 'main');
  const force = flags.has('force');

  let readmeContract: ReadmeContract;
  try {
    readmeContract = resolveReadmeContract({ vendorSkillsDir: VENDOR_SKILLS, distDir: DIST_DIR });
    assertReadmeWriteAllowed(targetDir, force);
    preflightScaffoldReadme({ contract: readmeContract, targetDir, repoId });
  } catch (error) {
    process.stderr.write(`Error: ${(error as Error).message}\n`);
    process.exit(1);
  }
  const sourceSha = reviewedReadmeSha(targetDir);

  const { emittedPaths, judgmentLadenPaths } = scaffold({
    targetDir,
    templatesDir: TEMPLATES_DIR,
    skillsDir: scaffoldSkillsDir(),
    repoId, date, upstreamUrl, upstreamRef, force,
  });

  try {
    generateScaffoldReadme({ contract: readmeContract, targetDir, repoId, force, sourceSha });
    emittedPaths.push('README.md');
  } catch (error) {
    process.stderr.write(`Error: ${(error as Error).message}\n`);
    process.exit(1);
  }

  // Build finish prompt for stdout — uses absolute targetDir so the user sees
  // real paths they can open directly.
  const finishPromptStdout = buildFinishPrompt({ targetDir, pathDisplay: targetDir, emittedPaths, judgmentLadenPaths });

  // Emit to stdout.
  process.stdout.write(`${finishPromptStdout}\n`);

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

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

/** Known verb dispatch; anything else fails with the unknown-argument contract line. */
function dispatchVerb(verb: string, rest: string[]): void {
  if (verb === 'init') {
    // rest is sliced from firstPositionalIdx (the index of 'init' in rawArgv)
    // rather than rawArgv.indexOf('init'), which would match the first literal
    // 'init' anywhere — e.g. `ai-catapult --date init init <target>` would
    // mis-dispatch to ./init.
    runInit(rest);
    process.exit(0);
  }
  if (verb === 'install') {
    runInstall(rest);
    process.exit(0);
  }
  if (verb === 'graph-hooks') {
    runGraphHooks(rest, TEMPLATES_DIR);
    process.exit(0);
  }
  if (verb === 'matrix') process.exit(runMatrixRuntime(rest));
  if (verb === 'ci-adapters') process.exit(runCiAdaptersRuntime(rest));
  if (verb === 'knowledge') process.exit(runKnowledge(rest));
  process.stderr.write(`Unknown argument: ${verb}. Run ai-catapult --help for usage.\n`);
  process.exit(1);
}

function run(): void {
  const pkg = JSON.parse(readFileSync(join(packageRoot(moduleDir(import.meta.url)), 'package.json'), 'utf8')) as { version: string };

  const rawArgv = process.argv.slice(2);
  const { positionals: topPositionals, flags: topFlags, firstPositionalIdx } = parseArgs(rawArgv);

  if (topFlags.has('version') || topFlags.has('v')) {
    process.stdout.write(`${pkg.version}\n`);
    process.exit(0);
  }

  const verb = topPositionals[0];

  // Global --help/-h only when no verb is given; with a verb the subcommand
  // handles its own --help flag.
  if (!verb && (topFlags.has('help') || topFlags.has('h') || rawArgv.length === 0)) {
    process.stdout.write(`${HELP}\n`);
    process.exit(0);
  }

  // No verb and no global flag already handled above; bare invocation → help.
  if (!verb) {
    process.stdout.write(`${HELP}\n`);
    process.exit(0);
  }

  dispatchVerb(verb, rawArgv.slice(firstPositionalIdx + 1));
}

// The bin is an entrypoint, never an imported module, and it must dispatch on
// every invocation path: npm installs expose it through a symlink chain
// (<prefix>/bin → node_modules/.bin → entry), where process.argv[1] is the
// link path, not the real module path. v1 executed its module body
// unconditionally; the port's `argv[1] === fileURLToPath(import.meta.url)`
// guard silently skipped dispatch through those links (review round 1 F2).
// The `scripts/*.ts` guard stays for library-style scripts.
run();