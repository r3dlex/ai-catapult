/**
 * backfill.ts — `ai-catapult backfill --policy-v2` (ACH-C-04).
 *
 * Writes the baseline `readiness-policy/2` candidate into an existing
 * repository's `.ai/policies/readiness-policy.json` (rendered from the vendored
 * ai-catapult-init template through the boundary manifest, exactly as `init`
 * renders it) and appends one audit line to `.ai/drift/backfill-ledger.jsonl`.
 * The scaffold is not retroactive; this is the explicit, idempotent, ledgered
 * command for repositories that predate it.
 *
 * Activity is decided by the vendored `contract-run.sh inventory-v1` (never by
 * a second implementation): an in-flight v1 registry plan is active, completed
 * plans are not, unstarted and partly merged plans are not active but their
 * unmerged goals are listed as requiring migration (O10), and an unreachable
 * hosted API is active. While any plan is active the command refuses with ONE
 * consolidated report naming every active plan, writes no policy, and records
 * the refusal in the ledger.
 *
 * Fail-closed rules: a policy/2 with different bytes refuses; a symlinked root
 * or a symlinked/out-of-root write target refuses; a multiply linked target (a
 * hard link shared with a file outside the root) refuses, so no write can reach
 * through an alias; both write targets are validated before anything is
 * mutated, and a ledger that cannot be written fails the run rather than
 * claiming a success it never recorded; only the policy path and the ledger are
 * ever written, both inside `--root`; approvals, anchors and readiness contexts
 * are never written.
 *
 * Readings of the ambiguous acceptance sentences, recorded for review:
 *   - "every run appends": every invocation that reaches the decision stage
 *     (written, no-op, refused) appends exactly one ledger line. The line
 *     records the policy outcome, not the ledger itself, so the second run with
 *     the same inputs is still the required no-op policy-wise while remaining
 *     auditable.
 *   - "--dry-run prints the diff without writing": the declared no-write
 *     observation mode (matching the repo's graph-hooks dry-run contract). It
 *     writes neither the policy nor the ledger; it prints the unified diff, and
 *     it still refuses while a plan is active (printing the refusal report).
 *   - Refusals before a root is addressable (missing/symlinked/non-directory)
 *     cannot be ledgered: there is no validated root to append to.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { resolveVendorSkill } from './skill-resolver.ts';

const POLICY_REL = '.ai/policies/readiness-policy.json';
const LEDGER_REL = '.ai/drift/backfill-ledger.jsonl';
const POLICY_SCHEMA = 'readiness-policy/2';
const V1_POLICY_SCHEMA = 'readiness-policy/1';
const INVENTORY_SCHEMA = 'v1-inventory/1';
const REPORT_SCHEMA = 'backfill-report/1';
const LEDGER_SCHEMA = 'backfill-ledger/1';
const COMMAND = 'backfill --policy-v2';
const INVENTORY_TIMEOUT_MS = 120_000;
const DIFF_CONTEXT = 3;
const INVENTORY_ERROR_CODES = {
  unavailable: 'inventory_unavailable',
  unreachable: 'inventory_unreachable',
  invalid: 'inventory_invalid',
} as const;

export const BACKFILL_HELP = `Usage: ai-catapult backfill --policy-v2 [--root <repo>] [--dry-run]

Write the baseline readiness-policy/2 candidate into an existing repository's
.ai/policies/readiness-policy.json (rendered from the vendored ai-catapult-init
template exactly as init renders it) and append one audit line to
.ai/drift/backfill-ledger.jsonl.

Runs only when invoked explicitly, and only when the repository has no policy,
or a v1 policy and no active v1 registry plan. Activity comes from the vendored
contract-run.sh inventory-v1: an in-flight plan is active, completed plans are
not, and unstarted or partly merged plans are listed as requiring migration of
their unmerged goals. While any plan is active, or when the hosted API is
unreachable, the command refuses with one consolidated report naming every
active plan. A readiness-policy/2 with different bytes refuses. Nothing outside
--root is ever written, and approvals, anchors and readiness contexts are never
touched.

Options:
  --policy-v2    Required. Write the baseline readiness-policy/2 candidate
  --root <repo>  Repository to backfill (default: current directory)
  --dry-run      Print the unified diff without writing anything (policy or ledger)
  -h, --help     Show this help`;

type Obj = Record<string, unknown>;

export type InventoryReport = {
  schema?: unknown;
  entries?: unknown;
  refusals?: unknown;
  [key: string]: unknown;
};

export type InventoryOutcome = {
  exitCode: number | null;
  report?: InventoryReport | undefined;
  error?: string | undefined;
  /** Why no report was produced: an absent tool, a failed run, or unparseable output. */
  code?: 'unavailable' | 'unreachable' | 'invalid' | undefined;
};

export type InventoryRunner = (root: string) => InventoryOutcome;

export type BackfillOptions = {
  templatesDir: string;
  vendorSkillsDir?: string | undefined;
  inventory?: InventoryRunner | undefined;
  now?: (() => Date) | undefined;
  io?: { out: (text: string) => void; err: (text: string) => void } | undefined;
  /**
   * Test-only fault-injection points for the check/write races: they run at the
   * last deterministic moment before the policy rename and before the ledger
   * open. The CLI never sets them (observer pattern: a test adapter exists only
   * in-process), and they are called with the final checks already done.
   * Ancestor-directory swaps at these points are a known residual deferred to
   * the ADR-0013 review: not solved, not waived, not an accepted assumption.
   */
  faults?: { beforePolicyWrite?: () => void; beforeLedgerAppend?: () => void } | undefined;
};

type Io = { out: (text: string) => void; err: (text: string) => void };
type Refusal = { code: string; detail: string };
type Migration = { id: string; plan_id: string | null; fate: string; goals: string[] };

type ParsedArgs =
  | { kind: 'run'; root: string; dryRun: boolean }
  | { kind: 'help' }
  | { kind: 'usage'; message: string };

const BOOLEAN_FLAGS = new Set(['--policy-v2', '--dry-run', '--help', '-h']);

type ArgScan = { positionals: string[]; flags: Set<string>; values: Map<string, string> } | { message: string };

type ScanState = { positionals: string[]; flags: Set<string>; values: Map<string, string> };

/** Consume one argv token into the scan state; returns the next index or a usage message. */
function consumeArg(argv: string[], index: number, state: ScanState): { next: number } | { message: string } {
  const arg = argv[index] ?? '';
  if (arg === '--') {
    state.positionals.push(...argv.slice(index + 1));
    return { next: argv.length };
  }
  if (BOOLEAN_FLAGS.has(arg)) {
    state.flags.add(arg === '-h' ? '--help' : arg);
    return { next: index + 1 };
  }
  if (arg === '--root') {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('-')) return { message: '--root needs a value' };
    state.values.set('--root', value);
    return { next: index + 2 };
  }
  if (arg.startsWith('-')) return { message: `unknown argument: ${arg}` };
  state.positionals.push(arg);
  return { next: index + 1 };
}

function scanBackfillArgs(argv: string[]): ArgScan {
  const state: ScanState = { positionals: [], flags: new Set<string>(), values: new Map<string, string>() };
  let i = 0;
  while (i < argv.length) {
    const step = consumeArg(argv, i, state);
    if ('message' in step) return step;
    i = step.next;
  }
  return state;
}

function parseBackfillArgs(argv: string[]): ParsedArgs {
  const scanned = scanBackfillArgs(argv);
  if ('message' in scanned) return { kind: 'usage', message: scanned.message };
  if (scanned.flags.has('--help')) return { kind: 'help' };
  if (scanned.positionals.length > 0) return { kind: 'usage', message: `unexpected argument: ${scanned.positionals[0] ?? ''}` };
  if (!scanned.flags.has('--policy-v2')) return { kind: 'usage', message: 'backfill requires --policy-v2, the only supported policy mode' };
  return { kind: 'run', root: scanned.values.get('--root') ?? process.cwd(), dryRun: scanned.flags.has('--dry-run') };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function stamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Refuse a root whose final component is a symlink (the target identity is
 * ambiguous), that is not a directory, or that does not exist.
 */
function inspectRoot(rootPath: string): { realRoot: string } | { refusal: Refusal } {
  let stat;
  try {
    stat = lstatSync(rootPath);
  } catch {
    return { refusal: { code: 'root_missing', detail: rootPath } };
  }
  if (stat.isSymbolicLink()) return { refusal: { code: 'root_symlinked', detail: rootPath } };
  if (!stat.isDirectory()) return { refusal: { code: 'root_not_directory', detail: rootPath } };
  return { realRoot: realpathSync(rootPath) };
}

/**
 * A write target must not pass through any symlinked component below the root,
 * so nothing can land outside it. Existing non-final components must be
 * directories, the final component a regular file, and a multiply linked target
 * (a hard link shared with a file outside the root) is refused: writing through
 * the link would mutate the outside alias.
 */
/** An existing final component must be a regular, singly linked file. */
function leafRefusal(stat: Stats, rel: string): Refusal | null {
  if (!stat.isFile()) return { code: 'path_not_regular_file', detail: rel };
  if (stat.nlink > 1) return { code: 'path_multiply_linked', detail: rel };
  return null;
}

function containment(realRoot: string, rel: string): Refusal | null {
  const parts = rel.split('/');
  let current = realRoot;
  for (let i = 0; i < parts.length; i += 1) {
    current = join(current, parts[i] ?? '');
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      return null; // nothing exists at or below this component yet
    }
    if (stat.isSymbolicLink()) return { code: 'path_symlinked', detail: rel };
    if (i === parts.length - 1) return leafRefusal(stat, rel);
    if (!stat.isDirectory()) return { code: 'path_not_directory', detail: rel };
  }
  return null;
}

type PolicyView =
  | { kind: 'absent' }
  | { kind: 'present'; bytes: string; schema: string | undefined; repoId: string | undefined }
  | { kind: 'refusal'; refusal: Refusal };

type ReadablePolicy = Extract<PolicyView, { kind: 'absent' } | { kind: 'present' }>;

function readPolicy(realRoot: string): PolicyView {
  const unsafe = containment(realRoot, POLICY_REL);
  if (unsafe) return { kind: 'refusal', refusal: unsafe };
  const full = join(realRoot, POLICY_REL);
  if (!existsSync(full)) return { kind: 'absent' };
  const bytes = readFileSync(full, 'utf8');
  try {
    const parsed = JSON.parse(bytes) as { schema?: unknown; repository?: { id?: unknown } };
    const schema = typeof parsed.schema === 'string' ? parsed.schema : undefined;
    const id = parsed.repository !== undefined && typeof parsed.repository.id === 'string' && parsed.repository.id.length > 0
      ? parsed.repository.id
      : undefined;
    return { kind: 'present', bytes, schema, repoId: id };
  } catch {
    return { kind: 'present', bytes, schema: undefined, repoId: undefined };
  }
}

/** The vendored boundary manifest's template for the policy path. */
function policyTemplatePath(templatesDir: string): { template: string } | { refusal: Refusal } {
  const manifestPath = join(templatesDir, 'boundary-manifest.json');
  let manifest: { paths?: unknown };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { paths?: unknown };
  } catch {
    return { refusal: { code: 'template_missing', detail: manifestPath } };
  }
  const entries = Array.isArray(manifest.paths) ? (manifest.paths as unknown[]) : [];
  for (const raw of entries) {
    const entry = raw as Obj | null;
    if (entry?.path === POLICY_REL && entry.classification === 'mechanical' && typeof entry.template === 'string') {
      return { template: entry.template };
    }
  }
  return { refusal: { code: 'template_unsupported', detail: POLICY_REL } };
}

/** The baseline candidate: the vendored policy template rendered exactly as init renders it. */
function renderCandidate(templatesDir: string, repoId: string, date: string): { bytes: string } | { refusal: Refusal } {
  const located = policyTemplatePath(templatesDir);
  if ('refusal' in located) return located;
  let rendered: string;
  try {
    rendered = readFileSync(join(templatesDir, located.template), 'utf8');
  } catch {
    return { refusal: { code: 'template_missing', detail: located.template } };
  }
  rendered = rendered
    .replaceAll('{{REPO_ID}}', repoId)
    .replaceAll('{{DATE}}', date)
    .replaceAll('{{UPSTREAM_URL}}', '')
    .replaceAll('{{UPSTREAM_REF}}', 'main');
  if (rendered.includes('{{')) return { refusal: { code: 'template_unresolved_token', detail: located.template } };
  return { bytes: rendered };
}

/** The production runner: the vendored contract-run.sh inventory-v1, exactly. */
function defaultInventoryRunner(vendorSkillsDir: string | undefined): InventoryRunner {
  return (root: string): InventoryOutcome => {
    if (vendorSkillsDir === undefined) return { exitCode: null, code: 'unavailable', error: 'vendored skills are not present' };
    let script: string;
    try {
      script = join(resolveVendorSkill(vendorSkillsDir, 'autobahn'), 'contract-run.sh');
    } catch (error) {
      return { exitCode: null, code: 'unavailable', error: `vendored autobahn skill is unavailable: ${(error as Error).message}` };
    }
    if (!existsSync(script)) return { exitCode: null, code: 'unavailable', error: `vendored contract-run.sh is absent: ${script}` };
    const result = spawnSync('bash', [script, 'inventory-v1', '--root', root], {
      cwd: root,
      encoding: 'utf8',
      timeout: INVENTORY_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.error !== undefined || result.status === null) {
      return { exitCode: null, code: 'unreachable', error: 'inventory-v1 did not terminate' };
    }
    let report: InventoryReport;
    try {
      report = JSON.parse(result.stdout) as InventoryReport;
    } catch {
      return { exitCode: result.status, code: 'invalid', error: 'inventory-v1 stdout is not JSON' };
    }
    return { exitCode: result.status, report };
  };
}

type Classification = { refusal?: Refusal; migrations: Migration[]; inFlight: string[] };

function refusalCodes(report: InventoryReport): string[] {
  if (!Array.isArray(report.refusals)) return [];
  return (report.refusals as unknown[])
    .map((raw) => (raw as Obj | null)?.code)
    .filter((code): code is string => typeof code === 'string');
}

/** The post-loop refusal: in-flight names, then any inventory-level refusal or non-zero exit. */
function refusalFor(report: InventoryReport, outcome: InventoryOutcome, inFlight: string[]): Refusal | null {
  if (inFlight.length > 0) return { code: 'plan_in_flight', detail: inFlight.join(', ') };
  const codes = refusalCodes(report);
  if (outcome.exitCode !== 0) return { code: 'inventory_refused', detail: codes.join(', ') || `inventory-v1 exited ${outcome.exitCode}` };
  if (codes.length > 0) return { code: 'inventory_refused', detail: codes.join(', ') };
  return null;
}

type EntryFacts = { id: string; fate: string; planId: string | null; goals: string[] };

/** One entry's fate as data, or null when the entry carries no id or fate. */
function entryFacts(raw: unknown): EntryFacts | null {
  const entry = raw as Obj | null;
  if (entry === null || typeof entry !== 'object') return null;
  if (typeof entry.id !== 'string' || typeof entry.fate !== 'string') return null;
  const planId = typeof entry.plan_id === 'string' ? entry.plan_id : null;
  const goals = Array.isArray(entry.unmerged) ? entry.unmerged.filter((goal): goal is string => typeof goal === 'string') : [];
  return { id: entry.id, fate: entry.fate, planId, goals };
}

/** Route one observed fate into migrations, in-flight names, or a refusal. */
function classifyEntry(facts: EntryFacts, migrations: Migration[], inFlight: string[]): Refusal | null {
  if (facts.fate === 'in-flight') {
    inFlight.push(facts.planId === null ? facts.id : `${facts.id} (${facts.planId})`);
  } else if (facts.fate === 'unstarted' || facts.fate === 'partly-merged') {
    migrations.push({ id: facts.id, plan_id: facts.planId, fate: facts.fate, goals: facts.goals });
  } else if (facts.fate !== 'completed') {
    return { code: 'inventory_unattributable', detail: `${facts.id}: ${facts.fate}` };
  }
  return null;
}

/** The refusal for a runner that produced no report at all. */
function failureRefusal(outcome: InventoryOutcome): Refusal {
  const code = outcome.code === undefined ? 'inventory_unreachable' : INVENTORY_ERROR_CODES[outcome.code];
  return { code, detail: outcome.error ?? 'inventory-v1 produced no exit status' };
}

/** The validated entries list of a `v1-inventory/1` report, or null for any other shape. */
function validInventory(report: InventoryReport | undefined): { report: InventoryReport; entries: unknown[] } | null {
  if (report === undefined || report.schema !== INVENTORY_SCHEMA || !Array.isArray(report.entries)) return null;
  return { report, entries: report.entries as unknown[] };
}

function classifyInventory(outcome: InventoryOutcome): Classification {
  const migrations: Migration[] = [];
  const inFlight: string[] = [];
  if (outcome.error !== undefined || outcome.exitCode === null) {
    return { refusal: failureRefusal(outcome), migrations, inFlight };
  }
  const observed = validInventory(outcome.report);
  if (observed === null) {
    return { refusal: { code: 'inventory_invalid', detail: 'the inventory report carries no entries list' }, migrations, inFlight };
  }
  for (const raw of observed.entries) {
    const facts = entryFacts(raw);
    if (facts === null) return { refusal: { code: 'inventory_invalid', detail: 'an inventory entry has no id or fate' }, migrations, inFlight };
    const entryRefusal = classifyEntry(facts, migrations, inFlight);
    if (entryRefusal !== null) return { refusal: entryRefusal, migrations, inFlight };
  }
  const refusal = refusalFor(observed.report, outcome, inFlight);
  return refusal === null ? { migrations, inFlight } : { refusal, migrations, inFlight };
}

/** The write decision for the policy file: replace, nothing to do, or refuse. */
function decidePolicy(policy: ReadablePolicy, candidateBytes: string): 'write' | 'no-op' | Refusal {
  if (policy.kind === 'absent') return 'write';
  if (policy.schema === POLICY_SCHEMA) {
    return policy.bytes === candidateBytes
      ? 'no-op'
      : { code: 'policy_v2_differs', detail: `${sha256(policy.bytes)} != ${sha256(candidateBytes)}` };
  }
  if (policy.schema === V1_POLICY_SCHEMA) return 'write';
  return { code: 'policy_unsupported', detail: policy.schema ?? 'unparseable policy JSON' };
}

const LEDGER_FLAGS = constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW;
const TEMP_FLAGS = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;

function insideRoot(realRoot: string, resolved: string): boolean {
  return resolved === realRoot || resolved.startsWith(realRoot + sep);
}

/** Any ledger I/O failure names its cause instead of exiting silently. */
function ledgerFailure(error: unknown): Refusal {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ELOOP') return { code: 'path_symlinked', detail: LEDGER_REL };
  if (code === 'ENOTDIR') return { code: 'path_not_directory', detail: LEDGER_REL };
  return { code: 'ledger_append_failed', detail: `${code ?? 'error'}: ${(error as Error).message}` };
}

/**
 * The opened descriptor must be a regular, singly linked file whose path still
 * resolves inside the root to the same inode: a leaf swapped for a symlink
 * (ELOOP at open) or a hard link shared outside the root fails here.
 */
function verifyOpened(fd: number, target: string, realRoot: string, rel: string): Refusal | null {
  const stat = fstatSync(fd);
  if (!stat.isFile()) return { code: 'path_not_regular_file', detail: rel };
  if (stat.nlink > 1) return { code: 'path_multiply_linked', detail: rel };
  if (!insideRoot(realRoot, realpathSync(target))) return { code: 'path_symlinked', detail: rel };
  const pathStat = statSync(target);
  if (pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) return { code: 'path_changed', detail: rel };
  return null;
}

/**
 * Replace the target atomically: the bytes land in a same-directory temp file
 * created with O_CREAT|O_EXCL|O_NOFOLLOW, fsynced, then renamed over the target.
 * A symlink or hard-linked leaf swapped in at any point is replaced by the
 * rename, never followed or truncated. An ancestor directory replaced with an
 * outside symlink before this rename is a known residual deferred to the
 * ADR-0013 review: not solved, not waived, not an accepted assumption.
 */
function writeAtomic(realRoot: string, rel: string, bytes: string, beforeRename?: () => void): Refusal | null {
  const unsafe = containment(realRoot, rel);
  if (unsafe) return unsafe;
  const target = join(realRoot, rel);
  mkdirSync(dirname(target), { recursive: true });
  const afterMkdir = containment(realRoot, rel);
  if (afterMkdir) return afterMkdir;
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    const fd = openSync(temp, TEMP_FLAGS, 0o644);
    try {
      writeSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const stat = lstatSync(temp);
    if (!stat.isFile() || stat.nlink > 1) {
      unlinkSync(temp);
      return { code: 'path_multiply_linked', detail: rel };
    }
    beforeRename?.();
    renameSync(temp, target);
    return null;
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // nothing left to clean up (for example after a successful rename)
    }
    throw error;
  }
}

/**
 * Append one ledger line to a leaf that cannot have been swapped or hard-linked:
 * O_NOFOLLOW refuses a symlinked leaf at open, and the descriptor identity check
 * refuses anything that is not the singly linked regular file inside the root.
 * Any failure is a structured refusal — never a silent exit. An ancestor
 * directory replaced with an outside symlink before this open can still let
 * O_CREAT create an empty ledger outside; that residual is deferred to the
 * ADR-0013 review: not solved, not waived, not an accepted assumption.
 */
function appendLedger(
  realRoot: string,
  entry: Record<string, unknown>,
  beforeAppend?: () => void,
): Refusal | null {
  const unsafe = containment(realRoot, LEDGER_REL);
  if (unsafe) return unsafe;
  const target = join(realRoot, LEDGER_REL);
  let fd: number;
  try {
    mkdirSync(dirname(target), { recursive: true });
    const afterMkdir = containment(realRoot, LEDGER_REL);
    if (afterMkdir) return afterMkdir;
    beforeAppend?.();
    fd = openSync(target, LEDGER_FLAGS, 0o644);
  } catch (error) {
    return ledgerFailure(error);
  }
  try {
    const refusal = verifyOpened(fd, target, realRoot, LEDGER_REL);
    if (refusal) return refusal;
    writeSync(fd, `${JSON.stringify(entry)}\n`);
    return null;
  } catch (error) {
    return ledgerFailure(error);
  } finally {
    closeSync(fd);
  }
}

function printReport(io: Io, fields: {
  root: string;
  repositoryId: string;
  at: string;
  before: string | null;
  after: string | null;
  result: string;
  migrations: Migration[];
  refusals: Refusal[];
}): void {
  io.out(`${JSON.stringify({
    schema: REPORT_SCHEMA,
    command: COMMAND,
    root: fields.root,
    policy_path: POLICY_REL,
    repository_id: fields.repositoryId,
    before_sha256: fields.before,
    after_sha256: fields.after,
    at: fields.at,
    result: fields.result,
    migrations: fields.migrations,
    refusals: fields.refusals,
  }, null, 2)}\n`);
}

type LineOp = { type: 'equal' | 'delete' | 'insert'; line: string };

const OP_PREFIX = { equal: ' ', delete: '-', insert: '+' } as const;

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** LCS table of before[i..] versus after[j..]. */
function lcsTable(before: string[], after: string[]): number[][] {
  const rows = before.length;
  const cols = after.length;
  const grid: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  const cell = (row: number, col: number): number => grid[row]?.[col] ?? 0;
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let col = cols - 1; col >= 0; col -= 1) {
      grid[row]![col] = before[row] === after[col]
        ? cell(row + 1, col + 1) + 1
        : Math.max(cell(row + 1, col), cell(row, col + 1));
    }
  }
  return grid;
}

/** The next diff step at (row, col); equal wins, then a deletion, then an insertion. */
function nextStep(before: string[], after: string[], grid: number[][], row: number, col: number): 'equal' | 'delete' | 'insert' {
  if (row >= before.length) return 'insert';
  if (col >= after.length) return 'delete';
  if (before[row] === after[col]) return 'equal';
  const cellRow = grid[row + 1]?.[col] ?? 0;
  const cellCol = grid[row]?.[col + 1] ?? 0;
  return cellRow >= cellCol ? 'delete' : 'insert';
}

/** Line diff; on equal-cost paths a deletion wins before an insertion (deterministic). */
function lineOps(before: string[], after: string[]): LineOp[] {
  const grid = lcsTable(before, after);
  const ops: LineOp[] = [];
  let row = 0;
  let col = 0;
  while (row < before.length || col < after.length) {
    const step = nextStep(before, after, grid, row, col);
    if (step === 'equal') {
      ops.push({ type: 'equal', line: before[row] ?? '' });
      row += 1;
      col += 1;
    } else if (step === 'delete') {
      ops.push({ type: 'delete', line: before[row] ?? '' });
      row += 1;
    } else {
      ops.push({ type: 'insert', line: after[col] ?? '' });
      col += 1;
    }
  }
  return ops;
}

/** Indices of ops that belong to a hunk: every change plus DIFF_CONTEXT lines around it. */
function hunkRanges(ops: LineOp[]): Array<[number, number]> {
  const marked = ops.map((op, index) => {
    if (op.type !== 'equal') return true;
    for (let probe = Math.max(0, index - DIFF_CONTEXT); probe <= Math.min(ops.length - 1, index + DIFF_CONTEXT); probe += 1) {
      if (ops[probe]?.type !== 'equal') return true;
    }
    return false;
  });
  const ranges: Array<[number, number]> = [];
  let start = -1;
  for (let index = 0; index <= marked.length; index += 1) {
    const inside = index < marked.length && marked[index] === true;
    if (inside && start === -1) start = index;
    if (!inside && start !== -1) {
      ranges.push([start, index]);
      start = -1;
    }
  }
  return ranges;
}

/** Before/after line counts over an op range. */
function lineCounts(ops: LineOp[], start: number, end: number): { before: number; after: number } {
  let before = 0;
  let after = 0;
  for (let index = start; index < end; index += 1) {
    const op = ops[index];
    if (op === undefined) continue;
    if (op.type !== 'insert') before += 1;
    if (op.type !== 'delete') after += 1;
  }
  return { before, after };
}

function renderHunk(ops: LineOp[], start: number, end: number): string[] {
  const lead = lineCounts(ops, 0, start);
  const counts = lineCounts(ops, start, end);
  const lines = ops.slice(start, end).map((op) => `${OP_PREFIX[op.type]}${op.line}`);
  const beforeStart = counts.before === 0 ? lead.before : lead.before + 1;
  const afterStart = counts.after === 0 ? lead.after : lead.after + 1;
  return [`@@ -${beforeStart},${counts.before} +${afterStart},${counts.after} @@`, ...lines];
}

/** Unified diff (context 3) between the current policy bytes and the candidate. */
function unifiedDiff(rel: string, before: string, after: string): string {
  const ops = lineOps(splitLines(before), splitLines(after));
  if (!ops.some((op) => op.type !== 'equal')) return '';
  const lines = [`--- a/${rel}`, `+++ b/${rel}`];
  for (const [start, end] of hunkRanges(ops)) lines.push(...renderHunk(ops, start, end));
  return `${lines.join('\n')}\n`;
}

type RunState = {
  root: string;
  realRoot: string | null;
  repositoryId: string;
  at: string;
  before: string | null;
  migrations: Migration[];
};

type Run = {
  parsed: { root: string; dryRun: boolean };
  options: BackfillOptions;
  io: Io;
  current: Date;
  state: RunState;
  policy: ReadablePolicy;
  realRoot: string;
  faults: BackfillOptions['faults'];
};

function refusal(io: Io, state: RunState, refusals: Refusal[], dryRun: boolean): number {
  printReport(io, {
    root: state.root,
    repositoryId: state.repositoryId,
    at: state.at,
    before: state.before,
    after: null,
    result: 'refused',
    migrations: state.migrations,
    refusals,
  });
  io.err(`backfill: refused (${refusals.map((item) => item.code).join(', ')})\n`);
  if (!dryRun && state.realRoot !== null) {
    // The ledger target was validated before any mutation; a refusal here is a
    // race, and a refusal whose audit line cannot be written says so.
    const ledger = appendLedger(state.realRoot, {
      schema: LEDGER_SCHEMA,
      command: COMMAND,
      repository_id: state.repositoryId,
      before_sha256: state.before,
      after_sha256: null,
      at: state.at,
      result: 'refused',
    });
    if (ledger !== null) io.err(`backfill: the refusal could not be ledgered (${ledger.code})\n`);
  }
  return 1;
}

/** A mutation that cannot be audited is reported as failed, never silently. */
function ledgerFailed(run: Run, after: string | null, ledger: Refusal): number {
  printReport(run.io, {
    root: run.state.root,
    repositoryId: run.state.repositoryId,
    at: run.state.at,
    before: run.state.before,
    after,
    result: 'failed',
    migrations: run.state.migrations,
    refusals: [ledger],
  });
  run.io.err(`backfill: failed (${ledger.code})\n`);
  return 1;
}

/** The dry-run observation: print the diff for a would-be write, change nothing. */
function dryRun(run: Run, decision: 'write' | 'no-op', candidateBytes: string): number {
  if (decision === 'write') {
    const before = run.policy.kind === 'present' ? run.policy.bytes : '';
    run.io.out(unifiedDiff(POLICY_REL, before, candidateBytes));
  }
  return 0;
}

/** The policy write step: nothing on a no-op or dry-run, atomic replace on a write. */
function writeStep(run: Run, candidateBytes: string, decision: 'write' | 'no-op'): Refusal | null {
  if (decision !== 'write' || run.parsed.dryRun) return null;
  return writeAtomic(run.realRoot, POLICY_REL, candidateBytes, run.faults?.beforePolicyWrite);
}

/** Apply the decision: write, ledger, report, or print the dry-run diff. */
function applyDecision(run: Run, candidateBytes: string, decision: 'write' | 'no-op'): number {
  const { io, parsed, state } = run;
  const unsafe = writeStep(run, candidateBytes, decision);
  if (unsafe) return refusal(io, state, [unsafe], parsed.dryRun);
  const after = decision === 'no-op' ? state.before : sha256(candidateBytes);
  if (parsed.dryRun) return dryRun(run, decision, candidateBytes);
  const ledger = appendLedger(run.realRoot, {
    schema: LEDGER_SCHEMA,
    command: COMMAND,
    repository_id: state.repositoryId,
    before_sha256: state.before,
    after_sha256: after,
    at: state.at,
    result: decision === 'write' ? 'written' : 'no-op',
  }, run.faults?.beforeLedgerAppend);
  if (ledger !== null) return ledgerFailed(run, after, ledger);
  printReport(io, {
    root: state.root,
    repositoryId: state.repositoryId,
    at: state.at,
    before: state.before,
    after,
    result: decision === 'write' ? 'written' : 'no-op',
    migrations: state.migrations,
    refusals: [],
  });
  return 0;
}

/** Render the candidate and decide, after the inventory has cleared the write. */
function produceDecision(run: Run): number {
  // Revalidate both write targets after the inventory ran: a target invalidated
  // during that step refuses before any mutation.
  const recheck = containment(run.realRoot, LEDGER_REL) ?? containment(run.realRoot, POLICY_REL);
  if (recheck) return refusal(run.io, run.state, [recheck], run.parsed.dryRun);
  const candidate = renderCandidate(run.options.templatesDir, run.state.repositoryId, run.current.toISOString().slice(0, 10));
  if ('refusal' in candidate) return refusal(run.io, run.state, [candidate.refusal], run.parsed.dryRun);
  const decision = decidePolicy(run.policy, candidate.bytes);
  if (decision !== 'write' && decision !== 'no-op') {
    return refusal(run.io, run.state, [decision], run.parsed.dryRun);
  }
  return applyDecision(run, candidate.bytes, decision);
}

/** Ask the vendored inventory; refuse unless every entry is settled or migrating. */
function consultInventory(run: Run): number {
  const runInventory = run.options.inventory ?? defaultInventoryRunner(run.options.vendorSkillsDir);
  const classified = classifyInventory(runInventory(run.realRoot));
  run.state.migrations = classified.migrations;
  if (classified.refusal) return refusal(run.io, run.state, [classified.refusal], run.parsed.dryRun);
  return produceDecision(run);
}

function executeBackfill(parsed: { root: string; dryRun: boolean }, options: BackfillOptions, io: Io): number {
  const current = (options.now ?? ((): Date => new Date()))();
  const rootPath = resolve(parsed.root);
  const inspected = inspectRoot(rootPath);
  const state: RunState = {
    root: rootPath,
    realRoot: null,
    repositoryId: basename(rootPath),
    at: stamp(current),
    before: null,
    migrations: [],
  };
  if ('refusal' in inspected) return refusal(io, state, [inspected.refusal], parsed.dryRun);
  state.realRoot = inspected.realRoot;

  // Both write targets are validated before anything is mutated: an unsafe
  // ledger path refuses the run before the policy write, never a silent skip.
  const ledgerTarget = containment(state.realRoot, LEDGER_REL);
  if (ledgerTarget) return refusal(io, state, [ledgerTarget], parsed.dryRun);

  const policy = readPolicy(state.realRoot);
  if (policy.kind === 'refusal') return refusal(io, state, [policy.refusal], parsed.dryRun);
  if (policy.kind === 'present') {
    state.repositoryId = policy.repoId ?? basename(state.realRoot);
    state.before = sha256(policy.bytes);
  }
  return consultInventory({ parsed, options, io, current, state, policy, realRoot: state.realRoot, faults: options.faults });
}

/**
 * Run `ai-catapult backfill`. Returns the exit code: 0 written/no-op/dry-run,
 * 1 refused (fail closed), 2 usage. Never calls process.exit.
 */
export function runBackfill(argv: string[], options: BackfillOptions): number {
  const io = options.io ?? { out: (text: string) => process.stdout.write(text), err: (text: string) => process.stderr.write(text) };
  const parsed = parseBackfillArgs(argv);
  if (parsed.kind === 'help') {
    io.out(`${BACKFILL_HELP}\n`);
    return 0;
  }
  if (parsed.kind === 'usage') {
    io.err(`Error: ${parsed.message}\nRun: ai-catapult backfill --help\n`);
    return 2;
  }
  try {
    return executeBackfill(parsed, options, io);
  } catch (error) {
    io.err(`backfill: failed: ${(error as Error).message}\n`);
    return 1;
  }
}
