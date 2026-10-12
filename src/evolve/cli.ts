/**
 * `ai-catapult evolve` — deterministic recorded-judgment gate.
 * Judge calls stay out of band. The clock is not consulted.
 */
import { realpathSync } from 'node:fs';
import { validateCycle, renderReport, type ValidateRequest } from './validate.ts';

const EVOLVE_HELP = `Usage: ai-catapult evolve --validate [options]

Apply the recorded-judgment gate to one candidate overlay. Judge calls stay
out of band; this command only reads records already on disk.

Options:
  --root <dir>                 Workspace root that contains evolve/
  --skill <name>               Skill whose proposals/<name>.overlay is the candidate
  --cycle-run <id>             Run id whose judgment records are this cycle
  --seed-run <id>              Run id of the current-catalog seed judgment
  --seed-judgment <id>         Judgment id of the current-catalog validation score
  --catalog-sha256 <hex>       Digest of the current catalog state (S_0)
  --task-set-version <n>       Frozen task-set version the judgments must bind to
  --judge-model <model>        Judge model the judgments must bind to
  --recorded-at <iso>          Audit timestamp; the clock is not consulted
  --recorder <name>            Audit recorder
  --expect <judgment-id>       Invocation that must have a recorded judgment (repeatable)
  --dispatch                   Spend check only; refuse past $100/cycle
  -h, --help                   Show this help`;

const REQUIRED = [
  'root',
  'skill',
  'cycle-run',
  'seed-run',
  'seed-judgment',
  'catalog-sha256',
  'task-set-version',
  'judge-model',
  'recorded-at',
  'recorder',
] as const;

export function runEvolve(argv: string[]): number {
  if (wantsHelp(argv)) {
    process.stdout.write(`${EVOLVE_HELP}\n`);
    return 0;
  }
  if (argv[0] !== '--validate') {
    process.stderr.write('Unknown argument: evolve. Run ai-catapult evolve --help for usage.\n');
    return 1;
  }
  const parsed = parseValidate(argv.slice(1));
  if (parsed === null) return 1;
  return emit(parsed.root, parsed.request);
}

function wantsHelp(argv: readonly string[]): boolean {
  return argv.length === 0 || argv.includes('--help') || argv.includes('-h');
}

function emit(root: string, request: ValidateRequest): number {
  try {
    const report = validateCycle(root, request);
    process.stdout.write(`${renderReport(report)}\n`);
    if (report.code === null) return 0;
    process.stderr.write(`${report.code}\n`);
    return 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'evolve --validate failed';
    process.stderr.write(`Error: ${message}\n`);
    return 1;
  }
}

function parseValidate(argv: readonly string[]): { request: ValidateRequest; root: string } | null {
  const flags = takeFlags(argv);
  if (flags === null) return null;
  const missing = REQUIRED.find((name) => flags.get(name) === undefined);
  if (missing !== undefined) {
    process.stderr.write(`missing --${missing}\n`);
    return null;
  }
  const version = parseVersion(flags.get('task-set-version')?.[0] ?? '');
  if (version === null) {
    process.stderr.write('invalid --task-set-version\n');
    return null;
  }
  const root = canonicalRoot(flags.get('root')?.[0] ?? '');
  if (root === null) return null;
  return { request: requestFrom(flags, version), root };
}

function requestFrom(flags: Map<string, string[]>, taskSetVersion: number): ValidateRequest {
  return {
    action: flags.has('dispatch') ? 'dispatch' : 'accept',
    catalogSha256: flag(flags, 'catalog-sha256'),
    cycleRunId: flag(flags, 'cycle-run'),
    expectedInvocations: flags.get('expect') ?? [],
    judgeModel: flag(flags, 'judge-model'),
    recordedAt: flag(flags, 'recorded-at'),
    recorder: flag(flags, 'recorder'),
    seedJudgmentId: flag(flags, 'seed-judgment'),
    seedRunId: flag(flags, 'seed-run'),
    skill: flag(flags, 'skill'),
    taskSetVersion,
  };
}

function flag(flags: Map<string, string[]>, name: string): string {
  const values = flags.get(name);
  if (values === undefined) return '';
  return values[0] ?? '';
}

function takeFlags(argv: readonly string[]): Map<string, string[]> | null {
  const flags = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const taken = takeOne(argv, index);
    if (taken === null) return null;
    const existing = flags.get(taken.name) ?? [];
    existing.push(...taken.values);
    flags.set(taken.name, existing);
    index = taken.next;
  }
  return flags;
}

function takeOne(argv: readonly string[], index: number): { name: string; next: number; values: string[] } | null {
  const token = argv[index];
  if (token === undefined || !token.startsWith('--') || token === '--') {
    process.stderr.write(`Unknown argument: ${token ?? ''}. Run ai-catapult evolve --help for usage.\n`);
    return null;
  }
  const name = token.slice(2);
  if (name === 'dispatch') return { name, next: index, values: ['true'] };
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    process.stderr.write(`missing --${name}\n`);
    return null;
  }
  return { name, next: index + 1, values: [value] };
}

function parseVersion(text: string): number | null {
  if (!/^[1-9][0-9]*$/.test(text)) return null;
  return Number(text);
}

function canonicalRoot(input: string): string | null {
  try {
    return realpathSync(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'root not found';
    process.stderr.write(`Error: ${message}\n`);
    return null;
  }
}
