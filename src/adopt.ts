/**
 * Knowledge inventory and migration for `ai-catapult adopt`.
 *
 * Layout and topology are detected from the target tree, not from its path.
 * The dry-run prints the knowledge-migration-map/1 document. `--apply`
 * performs the relocation actions of the frozen vocabulary (XSKP-P4-05):
 *
 * - `copy` promotes a legacy artifact to its v3 target and leaves the source
 *   in place; `migrate` is the only destructive action and is refused unless
 *   a per-run confirmation token is bound to its source, target and backup
 *   (ai-catapult-init modules/migration.md; token shape ct-YYYY-MM-DD-NNN,
 *   the same shape archive confirmation binds).
 * - The run map is written under `.ai/knowledge/migration/<run_id>/map.json`
 *   before any write. A migrate writes its backup under
 *   `.ai/drift/backups/<run_id>/<source>` first, verifies the moved bytes,
 *   removes the source, then repairs tracked citations (plain path tokens
 *   and relative Markdown link destinations). A link is resolved from the
 *   citer's original location, mapped through relocated destinations, and
 *   rendered from the citer's final location — including a document that was
 *   copied rather than moved. A relocated document rebases every local link,
 *   including destinations that stay in place and links to itself. Native,
 *   immutable, private and pre-existing dirty paths are never rewritten.
 *   Every write is recorded as a
 *   knowledge-migration-event/1 line in `.ai/knowledge/migration/ledger.jsonl`.
 * - An existing v3 target is present-not-overwritten: the item is a noop and
 *   the source is kept. Re-running an applied run-id replays the recorded
 *   map: every after-state is re-verified and only noop events are appended.
 * - Every predictable refusal is decided before the first write (confirmation
 *   binding, map shape, source/target/backup state, overlap, event shape and
 *   both contract ledgers). An interrupted run records a `failed` event and is
 *   never replayed; recovery is a fresh run id with a fresh token after
 *   inspecting the run's backups under `.ai/drift/backups/<run_id>/`.
 *
 * The remaining vocabulary (`supersede`, `deprecate`, `reference`, `adopt`
 * and a targetless native `copy`) stays an inventory disposition: apply never
 * rewrites those paths.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, join, posix, resolve } from 'node:path';
import {
  appendLedger,
  canonical,
  classify,
  compileSecretPattern,
  compareCodePoints,
  CONFIRMATIONS,
  CONTRACT_DIR,
  emit,
  KnowledgeError,
  MIGRATION_LEDGER,
  policyMatches,
  readLedger,
  safePath,
  schemaErrors,
  verifyContract,
} from './knowledge.ts';
import type { JsonSchema } from './knowledge.ts';

type Policy = Parameters<typeof classify>[2];
type ClassInfo = ReturnType<typeof classify>;

type Item = {
  action: string;
  broken_links: string[];
  classification: string;
  conflicts: string[];
  duplicate_of: null;
  kind: string | null;
  knowledge_id: null;
  reason: string;
  sha256: string | null;
  source: string;
  surface: string;
  target: string | null;
};

type MigrationMap = {
  created_at: string;
  items: Item[];
  layout: string;
  repo_id: string;
  run_id: string;
  schema: 'knowledge-migration-map/1';
  source_commit: string;
  topology: string;
};

type Options = {
  apply: boolean;
  confirm: string | undefined;
  confirmFile: string | undefined;
  destructive: boolean;
  repoId: string | undefined;
  runId: string;
};

type LegacyMove = { kind: string; target: string };
type ConfirmAction = { backup: string; source: string; target: string };
type Confirmation = {
  actions: ConfirmAction[];
  confirmation_token: string;
  run_id: string;
  schema: string;
  source_commit: string;
};

type Parsed =
  | { kind: 'help' }
  | { kind: 'usage'; detail: string }
  | { kind: 'ok'; options: Options; root: string };

const ENTRY_FILES = ['AGENTS.md', 'CLAUDE.md', 'README.md', 'GEMINI.md'];
const LEGACY_MARKER = '<!-- ai-sdlc-init:start -->';
const V3_MARKER = '<!-- v3-ai-sdlc-init:start -->';
const NATIVE = new Set(['native', 'native-legacy', 'workspace-convention']);
const TOKEN = /^ct-\d{4}-\d{2}-\d{2}-\d{3}$/;
const VALUED = new Set(['run-id', 'repo-id', 'confirm', 'confirm-file']);
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BACKUPS_DIR = '.ai/drift/backups';
const MIGRATION_DIR = '.ai/knowledge/migration';
const EXCLUDED_REPAIRS = ['.ai/drift/backups/', `${MIGRATION_DIR}/`, '.ai/knowledge/.locks/'];
const NATIVE_ROOTS = ['.omc', '.omx', '.omo', '.sisyphus', '.memory'];
const MIGRATION_CONFIRMATION = 'knowledge-migration-confirmation-event/1';
const ARCHIVE_CONFIRMATION = 'knowledge-archive-confirmation-event/1';

/** One planned copy/migrate write. */
type PlannedAction = {
  item: Item;
  sourceBytes: Buffer;
  beforeSha: string;
  target: string;
  /** sha256 of a pre-existing target, null when the target is absent. */
  targetSha: string | null;
  /** Relative backup path for migrate; null for copy (no source bytes change). */
  backup: string | null;
};

type RefRepair = { file: string; before: Buffer; after: Buffer };
type MigrationEvent = Record<string, unknown>;

const ADOPT_HELP = `Usage: ai-catapult adopt [target] [options]

dry-run inventory of a repository. Prints a knowledge-migration-map/1 document
and does not write. --apply performs the copy and migrate actions: a migrate is
refused unless a per-run confirmation token is bound to its source, target and
backup, then moves the file (backup first under .ai/drift/backups/<run-id>/,
source removed only after the written bytes verify), repairs tracked citations
and appends knowledge-migration-event/1 lines to
.ai/knowledge/migration/ledger.jsonl. The run map lands at
.ai/knowledge/migration/<run-id>/map.json before any write. Re-running an
applied run-id replays the recorded map: every after-state must still hold and
only noop events are appended. An interrupted run is recorded failed and is
never replayed; recover under a fresh run id and a fresh token after
inspecting the run's backups.

Arguments:
  target                 Directory to inventory (default: current directory)

Options:
  --dry-run              Inventory only (default)
  --apply                Apply copy and migrate actions (backup, ledger, repair)
  --destructive          Classify legacy-map copy defaults as migrate
  --run-id <id>          Run id recorded on the map
  --repo-id <id>         Repository id (default: matrix repo_id, else directory name)
  --confirm <token>      Confirmation token ct-YYYY-MM-DD-NNN
  --confirm-file <path>  Receipt binding that token to this run's migrate actions
  -h, --help             Show this help`;

function blankItem(source: string, classification: string, action: string, reason: string): Item {
  return {
    action,
    broken_links: [],
    classification,
    conflicts: [],
    duplicate_of: null,
    kind: null,
    knowledge_id: null,
    reason,
    sha256: null,
    source,
    surface: 'workspace',
    target: null,
  };
}

function fileSha(path: string): string | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

function existsKind(root: string, relative: string, want: 'file' | 'dir'): boolean {
  try {
    const stat = lstatSync(join(root, relative));
    if (stat.isSymbolicLink()) return false;
    return want === 'file' ? stat.isFile() : stat.isDirectory();
  } catch {
    return false;
  }
}

function readText(root: string, relative: string): string {
  const path = join(root, relative);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) return '';
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function hasMarker(root: string, marker: string): boolean {
  return ENTRY_FILES.some((name) => readText(root, name).includes(marker));
}

function isLegacyAiSdlc(root: string): boolean {
  return hasMarker(root, LEGACY_MARKER) || existsKind(root, '.rules.ts', 'file') || existsKind(root, 'docs/adr', 'dir');
}

function isPartialV3(root: string): boolean {
  if (existsKind(root, '.ai/knowledge/registry.json', 'file')) return false;
  return hasMarker(root, V3_MARKER)
    || existsKind(root, 'docs/architecture', 'dir')
    || existsKind(root, '.ai/workflows', 'dir')
    || existsKind(root, '.ai/phases', 'dir');
}

function hasMarkdownUnder(root: string, relative: string): boolean {
  const abs = join(root, relative);
  let stat: Stats;
  try {
    stat = lstatSync(abs);
  } catch {
    return false;
  }
  if (stat.isSymbolicLink()) return false;
  if (stat.isFile()) return relative.endsWith('.md');
  if (!stat.isDirectory() || existsSync(join(abs, '.git'))) return false;
  return readdirSync(abs).some((name) => hasMarkdownUnder(root, `${relative}/${name}`));
}

function isBrownfield(root: string): boolean {
  if (ENTRY_FILES.some((name) => name !== 'README.md' && existsKind(root, name, 'file'))) return true;
  if (['.omc', '.omx', '.omo', '.sisyphus'].some((name) => existsKind(root, name, 'dir'))) return true;
  return hasMarkdownUnder(root, 'docs');
}

function detectLayout(root: string): string {
  if (isLegacyAiSdlc(root)) return 'legacy-ai-sdlc';
  if (existsKind(root, '.agents', 'dir')) return 'legacy-agents';
  if (isPartialV3(root)) return 'partial-v3';
  if (isBrownfield(root)) return 'brownfield';
  return 'greenfield';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readMatrix(root: string): Record<string, unknown> | null {
  if (!existsKind(root, '.ai/matrix.json', 'file')) return null;
  try {
    const value: unknown = JSON.parse(readText(root, '.ai/matrix.json'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function isUmbrella(matrix: Record<string, unknown> | null): boolean {
  if (matrix === null) return false;
  if (matrix.topology_type === 'umbrella') return true;
  return Array.isArray(matrix.managed_repositories) && matrix.managed_repositories.length > 0;
}

function packageHasWorkspaces(root: string): boolean {
  if (!existsKind(root, 'package.json', 'file')) return false;
  try {
    const value: unknown = JSON.parse(readText(root, 'package.json'));
    if (!isRecord(value)) return false;
    if (Array.isArray(value.workspaces)) return value.workspaces.length > 0;
    if (!isRecord(value.workspaces)) return false;
    return Array.isArray(value.workspaces.packages) && value.workspaces.packages.length > 0;
  } catch {
    return false;
  }
}

function isMonorepo(root: string): boolean {
  return existsKind(root, 'pnpm-workspace.yaml', 'file')
    || existsKind(root, 'lerna.json', 'file')
    || packageHasWorkspaces(root);
}

function detectTopology(root: string, matrix: Record<string, unknown> | null): string {
  if (isUmbrella(matrix)) return 'umbrella';
  if (isMonorepo(root)) return 'monorepo';
  return 'single';
}

function repoIdOf(root: string, matrix: Record<string, unknown> | null, override: string | undefined): string {
  if (override) return override;
  if (matrix !== null && typeof matrix.repo_id === 'string' && matrix.repo_id.length > 0) return matrix.repo_id;
  return basename(root);
}

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  return env;
}

function sourceCommit(root: string): string {
  const env = gitEnv();
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', env });
  if (top.status !== 0 || resolve(top.stdout.trim()) !== resolve(root)) return 'uncommitted';
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, encoding: 'utf8', env });
  if (head.status !== 0) return 'uncommitted';
  return head.stdout.trim();
}

function managedPaths(matrix: Record<string, unknown> | null): Set<string> {
  const found = new Set<string>();
  if (matrix === null || !Array.isArray(matrix.managed_repositories)) return found;
  for (const entry of matrix.managed_repositories) {
    if (isRecord(entry) && typeof entry.path === 'string') found.add(entry.path);
  }
  return found;
}

function denied(relative: string, patterns: string[]): boolean {
  return patterns.some((pattern) => policyMatches(relative, pattern) || policyMatches(`${relative}/x`, pattern));
}

function stopHere(abs: string, relative: string, managed: Set<string>, deny: string[]): boolean {
  const stat = lstatSync(abs);
  if (stat.isSymbolicLink()) return true;
  if (!stat.isDirectory()) return false;
  if (managed.has(relative) || existsSync(join(abs, '.git'))) return true;
  return denied(relative, deny);
}

function isDirectory(abs: string): boolean {
  const stat = lstatSync(abs);
  return !stat.isSymbolicLink() && stat.isDirectory();
}

function childName(relative: string, name: string): string | null {
  if (relative === '' && name === '.git') return null;
  return relative === '' ? name : `${relative}/${name}`;
}

function walk(root: string, relative: string, managed: Set<string>, deny: string[]): string[] {
  const abs = relative === '' ? root : join(root, relative);
  if (relative !== '' && stopHere(abs, relative, managed, deny)) return [relative];
  if (!isDirectory(abs)) return relative === '' ? [] : [relative];
  const found: string[] = [];
  for (const name of readdirSync(abs).sort(compareCodePoints)) {
    const child = childName(relative, name);
    if (child !== null) found.push(...walk(root, child, managed, deny));
  }
  return found;
}

function directoryItem(relative: string, policy: Policy): Item {
  if (denied(relative, policy.deny.paths)) {
    return blankItem(relative, 'private', 'skip', 'private path: content is never opened');
  }
  return blankItem(relative, 'unsupported', 'skip', 'nested repository is outside root ownership');
}

function legacyMove(relative: string): LegacyMove | null {
  if (relative === '.rules.ts') return { target: '.ai/rules/technical-bounds.md', kind: 'doc' };
  const adr = /^docs\/adr\/([^/]+\.md)$/.exec(relative);
  if (adr?.[1]) return { target: `docs/architecture/adr/${adr[1]}`, kind: 'adr' };
  const skill = /^\.agents\/skills\/([^/]+)\/SKILL\.md$/.exec(relative);
  if (skill?.[1]) return { target: `.ai/system-prompts/${skill[1]}.md`, kind: 'doc' };
  const reference = /^\.agents\/skills\/([^/]+)\/REFERENCE\.md$/.exec(relative);
  if (reference?.[1]) return { target: `docs/learning/concept-maps/${reference[1]}.md`, kind: 'learning' };
  return null;
}

function legacyItem(root: string, relative: string, move: LegacyMove, destructive: boolean): Item {
  const action = destructive ? 'migrate' : 'copy';
  const reason = destructive
    ? 'legacy path relocates only with a per-run confirmation token'
    : 'legacy path copies by default; migrate requires --destructive and a confirmation token';
  const item = blankItem(relative, 'workspace-convention', action, reason);
  if (relative.startsWith('docs/adr/')) item.classification = 'canonical';
  item.kind = move.kind;
  item.target = move.target;
  item.sha256 = fileSha(join(root, relative));
  return item;
}

function nativeItem(root: string, relative: string, info: ClassInfo): Item | null {
  if (!NATIVE.has(info.classification)) return null;
  const item = blankItem(relative, info.classification, 'copy', 'native source preserved; promotion is not a move');
  item.surface = info.surface ?? 'workspace';
  item.kind = info.kind ?? null;
  item.sha256 = fileSha(join(root, relative));
  return item;
}

function canonicalKind(relative: string, targets: Record<string, string>): string | null {
  if (!relative.endsWith('.md')) return null;
  let best: { kind: string; length: number } | null = null;
  for (const [kind, dir] of Object.entries(targets)) {
    if (!relative.startsWith(dir)) continue;
    if (best === null || dir.length > best.length) best = { kind, length: dir.length };
  }
  return best?.kind ?? null;
}

function canonicalItem(root: string, relative: string, policy: Policy): Item | null {
  const kind = canonicalKind(relative, policy.canonical_targets);
  if (kind === null) return null;
  const item = blankItem(relative, 'canonical', 'adopt', 'canonical document registered in place');
  item.kind = kind;
  item.target = relative;
  item.sha256 = fileSha(join(root, relative));
  return item;
}

function markerItem(root: string, relative: string): Item | null {
  if (!ENTRY_FILES.includes(relative) || !readText(root, relative).includes(LEGACY_MARKER)) return null;
  return blankItem(relative, 'workspace-convention', 'supersede', 'legacy AI-SDLC marker block is rewritten in place');
}

function classifiedItem(root: string, relative: string, policy: Policy, info: ClassInfo, destructive: boolean): Item {
  const legacy = legacyMove(relative);
  if (legacy) return legacyItem(root, relative, legacy, destructive);
  const native = nativeItem(root, relative, info);
  if (native) return native;
  const canonical = canonicalItem(root, relative, policy);
  if (canonical) return canonical;
  const marker = markerItem(root, relative);
  if (marker) return marker;
  return blankItem(relative, 'workspace-convention', 'skip', 'out of knowledge scope');
}

type SecretScan = 'clean' | 'present' | 'unscannable';

/**
 * Scan one candidate file for policy secret patterns. The whole file is read
 * (no size cap), and any scan that cannot run — stat/read failure, NUL bytes —
 * reports `unscannable`, which the caller classifies `unsupported/skip`. An
 * omitted scan is never treated as secret-free.
 */
function scanSecret(path: string, policy: Policy): SecretScan {
  let bytes: Buffer;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return 'unscannable';
    bytes = readFileSync(path);
  } catch {
    return 'unscannable';
  }
  if (bytes.includes(0)) return 'unscannable';
  const text = bytes.toString('utf8');
  return policy.deny.secret_patterns.some((pattern) => compileSecretPattern(pattern).test(text))
    ? 'present'
    : 'clean';
}

function classifiedOrUnsafe(root: string, relative: string, policy: Policy): ClassInfo | Item {
  try {
    return classify(root, relative, policy);
  } catch (error) {
    if (error instanceof KnowledgeError) {
      return blankItem(relative, 'unsupported', 'skip', error.detail || error.error);
    }
    throw error;
  }
}

function immutableOverride(root: string, item: Item, policy: Policy): Item {
  if (!policy.immutable.some((pattern) => policyMatches(item.source, pattern))) return item;
  item.action = 'skip';
  item.target = null;
  item.reason = 'immutable path is never migrated or published';
  item.sha256 = fileSha(join(root, item.source));
  return item;
}

function fileItem(root: string, relative: string, policy: Policy, destructive: boolean): Item {
  const info = classifiedOrUnsafe(root, relative, policy);
  if (isItem(info)) return info;
  if (info.classification === 'private') return blankItem(relative, 'private', 'skip', 'private path: content is never opened');
  if (info.classification === 'unsupported') return blankItem(relative, 'unsupported', 'skip', 'unsupported format');
  const scan = scanSecret(join(root, relative), policy);
  if (scan === 'present') {
    return blankItem(relative, 'private', 'skip', 'secret pattern match: content is not recorded');
  }
  if (scan === 'unscannable') {
    return blankItem(relative, 'unsupported', 'skip', 'content could not be scanned; never treated as secret-free');
  }
  return immutableOverride(root, classifiedItem(root, relative, policy, info, destructive), policy);
}

function isItem(value: ClassInfo | Item): value is Item {
  return 'action' in value;
}

function toItem(root: string, relative: string, policy: Policy, destructive: boolean): Item {
  const stat = lstatSync(join(root, relative));
  if (stat.isSymbolicLink()) return blankItem(relative, 'unsupported', 'skip', 'symlink component');
  if (stat.isDirectory()) return directoryItem(relative, policy);
  return fileItem(root, relative, policy, destructive);
}

function markAdrConflicts(items: Item[]): void {
  const legacy = items.some((item) => item.source.startsWith('docs/adr/'));
  const current = items.some((item) => item.source.startsWith('docs/architecture/adr/'));
  if (!legacy || !current) return;
  for (const item of items) {
    if (!item.source.startsWith('docs/adr/') && !item.source.startsWith('docs/architecture/adr/')) continue;
    item.conflicts.push('duplicate ADR authorities: docs/adr and docs/architecture/adr');
    if (item.action === 'skip') continue;
    item.action = 'unresolved';
    item.reason = 'duplicate ADR roots require an authority decision';
  }
}

function compareItems(left: Item, right: Item): number {
  return compareCodePoints(left.source, right.source)
    || compareCodePoints(left.target ?? '', right.target ?? '')
    || compareCodePoints(left.reason, right.reason);
}

function loadPolicy(): Policy {
  verifyContract();
  return JSON.parse(readFileSync(join(CONTRACT_DIR, 'publication-policy.json'), 'utf8')) as Policy;
}

function collectItems(root: string, policy: Policy, matrix: Record<string, unknown> | null, destructive: boolean): Item[] {
  const items = walk(root, '', managedPaths(matrix), policy.deny.paths)
    .map((relative) => toItem(root, relative, policy, destructive));
  markAdrConflicts(items);
  items.sort(compareItems);
  return items;
}

function buildMap(root: string, options: Options): MigrationMap {
  const policy = loadPolicy();
  const matrix = readMatrix(root);
  return {
    created_at: new Date().toISOString(),
    items: collectItems(root, policy, matrix, options.destructive),
    layout: detectLayout(root),
    repo_id: repoIdOf(root, matrix, options.repoId),
    run_id: options.runId,
    schema: 'knowledge-migration-map/1',
    source_commit: sourceCommit(root),
    topology: detectTopology(root, matrix),
  };
}

function resolveRefs(schema: unknown, defs: Record<string, unknown>): unknown {
  if (Array.isArray(schema)) return schema.map((item) => resolveRefs(item, defs));
  if (!isRecord(schema)) return schema;
  if (typeof schema.$ref === 'string') {
    if (!schema.$ref.startsWith('#/$defs/')) throw new KnowledgeError('invalid_map', `unsupported schema reference ${schema.$ref}`);
    const name = schema.$ref.slice('#/$defs/'.length);
    if (!Object.prototype.hasOwnProperty.call(defs, name)) throw new KnowledgeError('invalid_map', `missing schema def ${name}`);
    return resolveRefs(defs[name], defs);
  }
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) resolved[key] = resolveRefs(value, defs);
  return resolved;
}

function assertValid(map: MigrationMap): void {
  const raw = JSON.parse(readFileSync(join(CONTRACT_DIR, 'migration.schema.json'), 'utf8')) as { $defs?: Record<string, unknown> };
  const resolved = resolveRefs(raw, raw.$defs ?? {}) as JsonSchema;
  const errors = schemaErrors(map, resolved, 'map');
  if (errors.length > 0) throw new KnowledgeError('invalid_map', errors.join('; '));
}

function asAction(value: unknown): ConfirmAction | null {
  if (!isRecord(value)) return null;
  if (typeof value.source !== 'string' || typeof value.target !== 'string' || typeof value.backup !== 'string') return null;
  return { source: value.source, target: value.target, backup: value.backup };
}

function asConfirmation(value: unknown): Confirmation {
  if (!isRecord(value) || !Array.isArray(value.actions)) {
    throw new KnowledgeError('invalid_confirmation', 'confirmation token is not bound to this run');
  }
  const actions = value.actions.map((entry) => asAction(entry));
  if (actions.some((entry) => entry === null)) {
    throw new KnowledgeError('invalid_confirmation', 'confirmation token is not bound to this run');
  }
  if (typeof value.schema !== 'string' || typeof value.run_id !== 'string'
    || typeof value.confirmation_token !== 'string' || typeof value.source_commit !== 'string') {
    throw new KnowledgeError('invalid_confirmation', 'confirmation token is not bound to this run');
  }
  return {
    schema: value.schema,
    run_id: value.run_id,
    confirmation_token: value.confirmation_token,
    source_commit: value.source_commit,
    actions: actions as ConfirmAction[],
  };
}

function loadConfirmation(options: Options): Confirmation {
  if (options.confirmFile === undefined || options.confirm === undefined || !TOKEN.test(options.confirm)) {
    throw new KnowledgeError('invalid_confirmation', 'confirmation token is not bound to this run');
  }
  try {
    return asConfirmation(JSON.parse(readFileSync(options.confirmFile, 'utf8')));
  } catch (error) {
    if (error instanceof KnowledgeError) throw error;
    throw new KnowledgeError('invalid_confirmation', String((error as Error).message ?? error));
  }
}

function actionMatches(action: ConfirmAction, item: Item, runId: string): boolean {
  return action.source === item.source
    && action.target === item.target
    && action.backup === `.ai/drift/backups/${runId}/${item.source}`;
}

function binds(confirmation: Confirmation, map: MigrationMap, pending: Item[], options: Options): boolean {
  if (confirmation.schema !== 'knowledge-migration-confirmation/1') return false;
  if (confirmation.run_id !== options.runId || confirmation.source_commit !== map.source_commit) return false;
  if (confirmation.confirmation_token !== options.confirm) return false;
  return pending.every((item) => confirmation.actions.some((action) => actionMatches(action, item, options.runId)));
}

function tokenConsumed(root: string, token: string): boolean {
  const path = join(root, '.ai/knowledge/migration/confirmations.jsonl');
  if (!existsSync(path)) return false;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return true;
  }
  return text.split('\n').filter((line) => line.trim() !== '').some((line) => consumedLine(line, token));
}

function consumedLine(line: string, token: string): boolean {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) && value.confirmation_token === token;
  } catch {
    return true;
  }
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort(compareCodePoints);
  const expected = [...keys].sort(compareCodePoints);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function migrationConfirmationOk(value: Record<string, unknown>): boolean {
  return value.schema === MIGRATION_CONFIRMATION
    && hasText(value.at)
    && hasText(value.run_id)
    && hasText(value.source_commit)
    && typeof value.confirmation_token === 'string'
    && TOKEN.test(value.confirmation_token)
    && value.result === 'consumed'
    && exactKeys(value, ['at', 'confirmation_token', 'result', 'run_id', 'schema', 'source_commit']);
}

function archiveConfirmationOk(value: Record<string, unknown>): boolean {
  return value.schema === ARCHIVE_CONFIRMATION
    && hasText(value.at)
    && hasText(value.run_id)
    && typeof value.confirmation_token === 'string'
    && TOKEN.test(value.confirmation_token)
    && typeof value.manifest_sha256 === 'string'
    && /^[0-9a-f]{64}$/.test(value.manifest_sha256)
    && value.result === 'consumed'
    && exactKeys(value, ['at', 'confirmation_token', 'manifest_sha256', 'result', 'run_id', 'schema']);
}

/** Every committed confirmation line must be a schema-complete record before a token is spent. */
function assertConfirmationLedger(root: string): void {
  assertLedgerTail(root, CONFIRMATIONS);
  const { values } = readLedger(root, CONFIRMATIONS);
  for (const value of values) {
    if (!migrationConfirmationOk(value) && !archiveConfirmationOk(value)) {
      throw new KnowledgeError('invalid_ledger', `${CONFIRMATIONS}: an existing line is not a confirmation record`);
    }
  }
}

function requireConfirmation(root: string, map: MigrationMap, options: Options): void {
  const pending = map.items.filter((item) => item.action === 'migrate');
  if (pending.length === 0) return;
  assertConfirmationLedger(root);
  if (options.confirm === undefined && options.confirmFile === undefined) {
    throw new KnowledgeError('confirmation_required', 'migrate actions require a per-run confirmation token');
  }
  const confirmation = loadConfirmation(options);
  if (!binds(confirmation, map, pending, options) || tokenConsumed(root, confirmation.confirmation_token)) {
    throw new KnowledgeError('invalid_confirmation', 'confirmation token is not bound to this run');
  }
}

function defaultRunId(): string {
  return `adopt-${new Date().toISOString().replace(/[:.]/g, '')}`;
}

// ---------------------------------------------------------------------------
// Apply: copy/migrate writes, backups, ledger events and reference repair
// ---------------------------------------------------------------------------

function sha256Bytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fileDigest(path: string): string | null {
  try {
    return sha256Bytes(readFileSync(path));
  } catch {
    return null;
  }
}

type Relocation = Item & { target: string };

/**
 * The items apply relocates: a copy or migrate with a v3 target. A targetless
 * copy is a native promotion — a publish decision, not a relocation — and
 * stays an inventory disposition.
 */
function relocations(map: MigrationMap): Relocation[] {
  return map.items.filter(
    (item): item is Relocation => (item.action === 'copy' || item.action === 'migrate') && item.target !== null,
  );
}

/** A migrate without a target is a map defect and stops the run before any write. */
function assertMigrateTargets(map: MigrationMap): void {
  for (const item of map.items) {
    if (item.action === 'migrate' && item.target === null) {
      throw new KnowledgeError('invalid_map', `${item.source}: migrate requires a target`);
    }
  }
}

/**
 * Every existing ancestor of a write destination must be a directory: a
 * regular file on the path blocks the write and refuses the run before it
 * touches anything.
 */
function assertEffectivelyWritable(path: string, relative: string): void {
  let cursor = path;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const creating = !existsSync(path) || !lstatSync(path).isFile();
  try {
    accessSync(cursor, creating ? constants.W_OK | constants.X_OK : constants.W_OK);
  } catch {
    throw new KnowledgeError('target_conflict', `${relative}: not writable`);
  }
  let parent = dirname(cursor);
  while (parent !== cursor) {
    if (existsSync(parent)) {
      try {
        accessSync(parent, constants.X_OK);
      } catch {
        throw new KnowledgeError('target_conflict', `${relative}: not writable`);
      }
    }
    const next = dirname(parent);
    if (next === parent) break;
    cursor = parent;
    parent = next;
  }
}

function assertWritableTarget(root: string, path: string, relative: string): void {
  for (let parent = dirname(path); parent !== root && parent !== dirname(parent); parent = dirname(parent)) {
    if (existsSync(parent) && !lstatSync(parent).isDirectory()) {
      throw new KnowledgeError('target_conflict', `${relative}: an ancestor is not a directory`);
    }
  }
  assertEffectivelyWritable(path, relative);
}

/** A pre-existing backup must hold the same bytes; anything else refuses the run. */
function assertBackupFree(root: string, backup: string, beforeSha: string): void {
  const path = safePath(root, backup);
  assertWritableTarget(root, path, backup);
  if (!existsSync(path) || fileDigest(path) === beforeSha) return;
  throw new KnowledgeError('backup_conflict', `${backup}: an existing backup holds different bytes`);
}

function planOne(root: string, item: Relocation, runId: string): PlannedAction {
  const sourcePath = safePath(root, item.source);
  const targetPath = safePath(root, item.target);
  const stat = lstatSync(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new KnowledgeError('invalid_map', `${item.source}: apply requires a regular file`);
  }
  const sourceBytes = readFileSync(sourcePath);
  const exists = existsSync(targetPath);
  if (exists && !lstatSync(targetPath).isFile()) {
    throw new KnowledgeError('target_conflict', `${item.target}: the v3 target is not a regular file`);
  }
  assertWritableTarget(root, targetPath, item.target);
  if (item.action === 'migrate') assertEffectivelyWritable(dirname(sourcePath), item.source);
  const beforeSha = sha256Bytes(sourceBytes);
  const backup = item.action === 'migrate' ? `${BACKUPS_DIR}/${runId}/${item.source}` : null;
  if (backup !== null) assertBackupFree(root, backup, beforeSha);
  return {
    item,
    sourceBytes,
    beforeSha,
    target: item.target,
    targetSha: exists ? fileDigest(targetPath) : null,
    backup,
  };
}

function planItems(root: string, map: MigrationMap): PlannedAction[] {
  const sources = new Set(relocations(map).map((item) => item.source));
  const targets = new Set<string>();
  const plan: PlannedAction[] = [];
  for (const item of relocations(map)) {
    if (targets.has(item.target) || sources.has(item.target)) {
      throw new KnowledgeError('invalid_map', `${item.target}: two actions overlap on one path`);
    }
    targets.add(item.target);
    plan.push(planOne(root, item, map.run_id));
  }
  return plan;
}

/** Write the migrate backup, reusing identical existing bytes and refusing drift. */
function writeBackup(root: string, entry: PlannedAction): void {
  const backup = entry.backup as string;
  const path = safePath(root, backup);
  if (existsSync(path)) {
    if (fileDigest(path) !== entry.beforeSha) {
      throw new KnowledgeError('backup_conflict', `${backup}: an existing backup holds different bytes`);
    }
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, entry.sourceBytes);
}

/** One candidate rewrite: replace [start, end) with `replacement`. */
type Span = { start: number; end: number; replacement: string };

function unescapeMd(value: string): string {
  return value.replace(/\\(.)/g, '$1');
}

function splitDestination(destination: string): { head: string; tail: string; wrapped: boolean } | null {
  const wrapped = destination.startsWith('<') && destination.endsWith('>');
  const inner = wrapped ? destination.slice(1, -1) : destination;
  const cut = inner.search(/[#?]/);
  const head = unescapeMd(cut < 0 ? inner : inner.slice(0, cut));
  const tail = cut < 0 ? '' : inner.slice(cut);
  if (head === '' || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(head)) return null;
  return { head, tail, wrapped };
}

/** Wrap a rendered destination when a bare form would be re-parsed incorrectly. */
function finishDestination(path: string, tail: string, wrapped: boolean): string {
  const raw = `${path}${tail}`;
  return wrapped || /[\s()]/.test(raw) ? `<${raw}>` : raw;
}

/**
 * The replacement for one Markdown link destination that resolves to a
 * relocated source. Resolution uses the citer's original directory — a moved
 * or copied document still names siblings from where it was written — and the
 * replacement is rendered from the citer's final directory. A relative link
 * stays relative, an absolute one stays absolute, and any query or fragment
 * suffix survives.
 */
function linkReplacement(
  originalCiter: string,
  finalCiter: string,
  destination: string,
  source: string,
  target: string,
): string | null {
  const split = splitDestination(destination);
  if (split === null) return null;
  const absolute = split.head.startsWith('/');
  const resolved = posix.normalize(
    absolute ? split.head.slice(1) : posix.join(posix.dirname(originalCiter), split.head),
  );
  if (resolved !== source) return null;
  const path = absolute ? `/${target}` : posix.relative(posix.dirname(finalCiter), target);
  return finishDestination(path, split.tail, split.wrapped);
}

/** Spaces, tabs, and at most one line ending — the whitespace a title may follow. */
function skipTitleSpace(text: string, at: number): number {
  let index = at;
  let broke = false;
  while (index < text.length) {
    const char = text[index];
    if (char === ' ' || char === '\t') {
      index += 1;
      continue;
    }
    if (char !== '\n' && char !== '\r') break;
    if (broke) break;
    broke = true;
    index += char === '\r' && text[index + 1] === '\n' ? 2 : 1;
  }
  return index;
}

function closingDelimiter(text: string, open: number, delimiter: string): number {
  for (let index = open + 1; index < text.length; index += 1) {
    if (text[index] === '\\' && index + 1 < text.length) {
      index += 1;
      continue;
    }
    if (text[index] === delimiter) return index;
  }
  return -1;
}

function skipTitle(text: string, at: number): number {
  const index = skipTitleSpace(text, at);
  if (index === at) return at;
  const quote = text[index];
  if (quote === '"' || quote === "'") {
    const close = closingDelimiter(text, index, quote);
    return close < 0 ? at : close + 1;
  }
  if (quote !== '(') return at;
  const close = closingDelimiter(text, index, ')');
  return close < 0 ? at : close + 1;
}

function destinationDepth(char: string | undefined, depth: number): number {
  if (char === '(') return depth + 1;
  if (char === ')' && depth === 0) return -1;
  if (char === ')') return depth - 1;
  return depth;
}

function readBareDestination(text: string, start: number): number {
  let index = start;
  let depth = 0;
  while (index < text.length && text[index] !== ' ' && text[index] !== '\t' && text[index] !== '\n' && text[index] !== '\r') {
    if (text[index] === '\\' && index + 1 < text.length) {
      index += 2;
      continue;
    }
    depth = destinationDepth(text[index], depth);
    if (depth < 0) break;
    index += 1;
  }
  return index;
}

function angledEnd(text: string, start: number): number | null {
  const close = text.indexOf('>', start + 1);
  if (close < 0 || text.slice(start, close).includes('\n')) return null;
  return close + 1;
}

function skipSpace(text: string, at: number): number {
  let index = at;
  while (text[index] === ' ' || text[index] === '\t') index += 1;
  return index;
}

function skipInlineSpace(text: string, at: number): number {
  let index = at;
  while (text[index] === ' ' || text[index] === '\t' || text[index] === '\n' || text[index] === '\r') index += 1;
  return index;
}

function readInlineDestination(text: string, openParen: number): { start: number; end: number; destination: string } | null {
  if (text[openParen] !== '(') return null;
  const start = skipInlineSpace(text, openParen + 1);
  const end = text[start] === '<' ? angledEnd(text, start) : readBareDestination(text, start);
  if (end === null || end === start || text[skipInlineSpace(text, skipTitle(text, end))] !== ')') return null;
  return { start, end, destination: text.slice(start, end) };
}

function readReferenceDestination(text: string, at: number): { start: number; end: number; destination: string } | null {
  const start = skipSpace(text, at);
  if (text[start] === '<') {
    const end = angledEnd(text, start);
    return end === null ? null : { start, end, destination: text.slice(start, end) };
  }
  const end = readBareDestination(text, start);
  if (end === start) return null;
  return { start, end, destination: text.slice(start, end) };
}

/** A continuation is valid only when the destination line has no trailing prose. */
function definitionTail(text: string, at: number): boolean {
  const titled = skipTitle(text, at);
  let index = titled === at ? at : titled;
  while (text[index] === ' ' || text[index] === '\t') index += 1;
  return index >= text.length || text[index] === '\n' || text[index] === '\r';
}

function sameLineDestination(text: string, at: number, limit: number): boolean {
  let index = at;
  while (index < limit && (text[index] === ' ' || text[index] === '\t')) index += 1;
  if (text[index] === '\r' && index + 1 === limit && text[limit] === '\n') return false;
  return index < limit;
}

function nextLineAt(text: string, limit: number): number {
  return limit < text.length && text[limit] === '\n' ? limit + 1 : limit;
}

function continuationDestination(text: string, at: number, limit: number): { start: number; end: number; destination: string } | null {
  if (sameLineDestination(text, at, limit)) return readReferenceDestination(text, at);
  const next = nextLineAt(text, limit);
  if (next >= text.length) return null;
  const found = readReferenceDestination(text, next);
  if (found === null || !definitionTail(text, found.end)) return null;
  return found;
}

function definitionDestination(text: string, lineStart: number, limit: number): { start: number; end: number; destination: string } | null {
  const open = text.indexOf('[', lineStart);
  if (open < 0 || open >= limit || !/^ {0,3}\[/.test(text.slice(lineStart, open + 1))) return null;
  const close = labelClose(text, open);
  if (close <= open || close >= limit || text[close + 1] !== ':') return null;
  return continuationDestination(text, close + 2, limit);
}

function referenceDestinations(text: string): Array<{ start: number; end: number; destination: string }> {
  const found: Array<{ start: number; end: number; destination: string }> = [];
  let index = 0;
  while (index < text.length) {
    const lineEnd = text.indexOf('\n', index);
    const limit = lineEnd < 0 ? text.length : lineEnd;
    const destination = definitionDestination(text, index, limit);
    if (destination !== null) found.push(destination);
    index = lineEnd < 0 ? text.length : lineEnd + 1;
  }
  return found;
}

function labelClose(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '\\' && index + 1 < text.length) {
      index += 1;
      continue;
    }
    if (text[index] === '[') depth += 1;
    else if (text[index] === ']') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function inlineDestinations(text: string): Array<{ start: number; end: number; destination: string }> {
  const found: Array<{ start: number; end: number; destination: string }> = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '[') continue;
    const labelEnd = labelClose(text, index);
    if (labelEnd < 0 || text[labelEnd + 1] !== '(') continue;
    const destination = readInlineDestination(text, labelEnd + 1);
    if (destination === null) continue;
    found.push(destination);
    index = labelEnd;
  }
  return found;
}

/** Destination spans of inline links and reference definitions, rewritten by `replace`. */
function destinationSpans(text: string, replace: (destination: string) => string | null): Span[] {
  const spans: Span[] = [];
  for (const found of [...inlineDestinations(text), ...referenceDestinations(text)]) {
    const replacement = replace(found.destination);
    if (replacement === null) continue;
    spans.push({ start: found.start, end: found.end, replacement });
  }
  return spans;
}

/** Destination spans of inline links and reference definitions that cite the source. */
function linkSpans(
  text: string,
  originalCiter: string,
  finalCiter: string,
  source: string,
  target: string,
): Span[] {
  return destinationSpans(
    text,
    (destination) => linkReplacement(originalCiter, finalCiter, destination, source, target),
  );
}

function relocationTarget(resolved: string, relocations: AppliedMove[]): string {
  return relocations.find((entry) => entry.source === resolved)?.target ?? resolved;
}

function resolveLink(originalCiter: string, head: string): string {
  const joined = head.startsWith('/') ? head.slice(1) : posix.join(posix.dirname(originalCiter), head);
  return posix.normalize(joined);
}

function escapeRelative(fromDir: string, toPath: string): string {
  const depth = fromDir === '' || fromDir === '.' ? 0 : fromDir.split('/').length;
  const parts = toPath.split('/');
  let ups = 0;
  while (parts[0] === '..') {
    ups += 1;
    parts.shift();
  }
  const prefix = '../'.repeat(depth + ups).replace(/\/$/, '');
  const rest = parts.join('/');
  if (prefix === '') return rest === '' ? '.' : rest;
  return rest === '' ? prefix : `${prefix}/${rest}`;
}

function relativeLink(fromDir: string, toPath: string): string {
  if (toPath === '..' || toPath.startsWith('../')) return escapeRelative(fromDir, toPath);
  const relative = posix.relative(fromDir === '' ? '.' : fromDir, toPath);
  return relative === '' ? '.' : relative;
}

/**
 * Rebase one local link from the citer's original directory onto its final
 * directory. A destination that was itself relocated lands on that target;
 * one that stayed in place keeps its resolved path. Self-links are included.
 */
function rebaseDestination(
  originalCiter: string,
  finalCiter: string,
  destination: string,
  relocations: AppliedMove[],
): string | null {
  const split = splitDestination(destination);
  if (split === null) return null;
  const resolved = resolveLink(originalCiter, split.head);
  if (resolved === '' || (split.head.startsWith('/') && resolved.startsWith('..'))) return null;
  const landed = relocationTarget(resolved, relocations);
  const path = split.head.startsWith('/') ? `/${landed}` : relativeLink(posix.dirname(finalCiter), landed);
  const rendered = finishDestination(path, split.tail, split.wrapped);
  return rendered === destination ? null : rendered;
}

function rebaseLinkSpans(
  text: string,
  originalCiter: string,
  finalCiter: string,
  relocations: AppliedMove[],
): Span[] {
  return destinationSpans(
    text,
    (destination) => rebaseDestination(originalCiter, finalCiter, destination, relocations),
  );
}

function isPathChar(char: string | undefined): boolean {
  return char !== undefined && /[\w./-]/.test(char);
}

/** Every parsed destination, including ones the rebase leaves unchanged. */
function destinationCoverage(text: string): Span[] {
  return [...inlineDestinations(text), ...referenceDestinations(text)].map((found) => ({
    start: found.start,
    end: found.end,
    replacement: '',
  }));
}

/** Every bare occurrence of `source` on a path boundary, outside `covered`. */
function tokenSpans(text: string, source: string, target: string, covered: Span[]): Span[] {
  const spans: Span[] = [];
  for (let at = text.indexOf(source); at >= 0; at = text.indexOf(source, at + 1)) {
    const end = at + source.length;
    if (isPathChar(text[at - 1]) || isPathChar(text[end])) continue;
    if (covered.some((span) => at < span.end && end > span.start)) continue;
    spans.push({ start: at, end, replacement: target });
  }
  return spans;
}

/** Apply every span right-to-left, so earlier offsets stay valid. */
function applySpans(text: string, spans: Span[]): string {
  let updated = text;
  for (const span of [...spans].sort((left, right) => right.start - left.start)) {
    updated = updated.slice(0, span.start) + span.replacement + updated.slice(span.end);
  }
  return updated;
}

/**
 * Rebase every local link in a relocated document, plus bare tokens of
 * relocated sources. Unmoved destinations keep their resolved path; self-links
 * land on this document's final path.
 */
/** Every bracket interior is a label or reference identifier, not a bare path token. */
function markdownLabelSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '[') continue;
    const close = labelClose(text, index);
    if (close > index + 1) spans.push({ start: index + 1, end: close, replacement: '' });
    if (close >= index) index = close;
  }
  return spans;
}

function rebaseBytes(
  content: Buffer,
  originalCiter: string,
  finalCiter: string,
  relocations: AppliedMove[],
): Buffer | null {
  if (content.includes(0)) return null;
  const text = content.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(content)) return null;
  const spans = rebaseLinkSpans(text, originalCiter, finalCiter, relocations);
  const covered = [...destinationCoverage(text), ...markdownLabelSpans(text)];
  for (const entry of relocations) {
    spans.push(...tokenSpans(text, entry.source, entry.target, covered));
  }
  if (spans.length === 0) return null;
  const updated = Buffer.from(applySpans(text, spans), 'utf8');
  return updated.equals(content) ? null : updated;
}

function rebaseOne(
  root: string,
  source: string,
  target: string,
  relocations: AppliedMove[],
): RefRepair | null {
  const path = safePath(root, target);
  let content: Buffer;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    content = readFileSync(path);
  } catch {
    return null;
  }
  const updated = rebaseBytes(content, source, target, relocations);
  if (updated === null) return null;
  writeFileSync(path, updated);
  return { file: target, before: content, after: updated };
}

/** Rewrite a citer's citations of the relocated source, or null when untouched. */
function repairedBytes(
  content: Buffer,
  originalCiter: string,
  finalCiter: string,
  source: string,
  target: string,
): Buffer | null {
  if (content.includes(0)) return null;
  const text = content.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(content)) return null;
  const links = linkSpans(text, originalCiter, finalCiter, source, target);
  const covered = [...destinationCoverage(text), ...markdownLabelSpans(text)];
  const spans = [...links, ...tokenSpans(text, source, target, covered)];
  if (spans.length === 0) return null;
  const updated = Buffer.from(applySpans(text, spans), 'utf8');
  return updated.equals(content) ? null : updated;
}

function nativeRoot(relative: string): boolean {
  return NATIVE_ROOTS.includes(relative.split('/')[0] ?? '');
}

function classifiedProtected(root: string, citer: string, policy: Policy): boolean {
  try {
    const info = classify(root, citer, policy);
    return info.classification === 'native'
      || info.classification === 'native-legacy'
      || info.classification === 'private';
  } catch {
    return true;
  }
}

/**
 * Paths the spec never rewrites: native roots, immutable readiness bytes,
 * private paths, managed (reference-only) children, and pre-existing dirty or
 * untracked work. A classification failure is protected too — an unreadable
 * path is not treated as rewriteable.
 */
function repairBlocked(root: string, citer: string, policy: Policy, dirty: Set<string>, managed: string[]): boolean {
  if (nativeRoot(citer) || dirty.has(citer) || underManaged(citer, managed)) return true;
  if (EXCLUDED_REPAIRS.some((prefix) => citer.startsWith(prefix))) return true;
  if (policy.immutable.some((pattern) => policyMatches(citer, pattern))) return true;
  if (denied(citer, policy.deny.paths)) return true;
  return classifiedProtected(root, citer, policy);
}

function underManaged(citer: string, managed: string[]): boolean {
  return managed.some((path) => citer === path || citer.startsWith(`${path}/`));
}

/**
 * A citer this engine may rewrite: not the source or target of this pass, not
 * a protected path, and only text the secret scan classifies clean. A citer
 * that classifies private or unscannable is left byte-unchanged and never
 * hashed into the ledger.
 */
function repairAllowed(
  root: string,
  citer: string,
  policy: Policy,
  source: string,
  target: string,
  dirty: Set<string>,
  managed: string[],
): boolean {
  if (citer === source || citer === target || repairBlocked(root, citer, policy, dirty, managed)) return false;
  try {
    return scanSecret(safePath(root, citer), policy) === 'clean';
  } catch {
    return false;
  }
}

function trackedFiles(root: string): string[] {
  const listed = spawnSync('git', ['ls-files', '-z'], {
    cwd: root, encoding: 'utf8', env: gitEnv(), maxBuffer: 64 * 1024 * 1024,
  });
  if (listed.status !== 0) return [];
  return listed.stdout.split('\0').filter((name) => name !== '').sort(compareCodePoints);
}

type AppliedMove = { action: string; source: string; target: string };

function originalCiter(citer: string, relocations: AppliedMove[]): string {
  return relocations.find((entry) => entry.target === citer)?.source ?? citer;
}

/** A copy leaves its source in place, so only relocated documents are retargeted. */
function repairCiters(action: string, citers: string[], relocations: AppliedMove[]): string[] {
  if (action !== 'copy') return citers;
  const targets = new Set(relocations.map((entry) => entry.target));
  return citers.filter((citer) => targets.has(citer));
}

function rewriteCiter(
  root: string,
  citer: string,
  original: string,
  source: string,
  target: string,
): RefRepair | null {
  const path = safePath(root, citer);
  let content: Buffer;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    content = readFileSync(path);
  } catch {
    return null;
  }
  const updated = repairedBytes(content, original, citer, source, target);
  if (updated === null) return null;
  writeFileSync(path, updated);
  return { file: citer, before: content, after: updated };
}

/** Repair every allowed citer's references to one relocated source. */
function repairReferences(
  root: string,
  policy: Policy,
  source: string,
  target: string,
  citers: string[],
  relocations: AppliedMove[],
  dirty: Set<string>,
  managed: string[],
  preserved: Set<string>,
): RefRepair[] {
  const relocatedTargets = new Set(relocations.map((entry) => entry.target));
  const repairs: RefRepair[] = [];
  for (const citer of citers) {
    // A relocated document is rebased once, with every local link, before this
    // per-source pass. A preserved target is present-not-overwritten.
    if (relocatedTargets.has(citer) || preserved.has(citer)) continue;
    if (!repairAllowed(root, citer, policy, source, target, dirty, managed)) continue;
    const updated = rewriteCiter(root, citer, originalCiter(citer, relocations), source, target);
    if (updated === null) continue;
    repairs.push(updated);
  }
  return repairs;
}

function eventFor(
  root: string,
  map: MigrationMap,
  entry: PlannedAction,
  result: 'applied' | 'noop',
  afterSha: string,
  repairs: RefRepair[],
): MigrationEvent {
  const { item } = entry;
  return {
    schema: 'knowledge-migration-event/1',
    run_id: map.run_id,
    action: item.action,
    source: item.source,
    target: item.target,
    before_sha256: entry.beforeSha,
    after_sha256: afterSha,
    backup: result === 'applied' && entry.backup !== null ? entry.backup : null,
    refs_repaired: repairs.map((repair) => ({
      file: repair.file,
      before_sha256: sha256Bytes(repair.before),
      // Every recorded after-hash is the run's final bytes: a citer repaired by
      // two passes verifies against the file as it stands after the last one.
      after_sha256: fileDigest(safePath(root, repair.file)) ?? sha256Bytes(repair.after),
    })),
    result,
  };
}

function eventSchemaErrors(event: MigrationEvent): string[] {
  const raw = JSON.parse(
    readFileSync(join(CONTRACT_DIR, 'migration.schema.json'), 'utf8'),
  ) as { $defs?: Record<string, unknown> };
  const defs = raw.$defs ?? {};
  const resolved = resolveRefs(defs.event ?? {}, defs) as JsonSchema;
  return schemaErrors(event, resolved, 'event');
}

function assertValidEvents(events: MigrationEvent[]): void {
  for (const event of events) {
    const errors = eventSchemaErrors(event);
    if (errors.length > 0) throw new KnowledgeError('invalid_map', errors.join('; '));
  }
}

/** Catch a schema drift in the event shape before the first write. */
function validateEventShape(root: string, plan: PlannedAction[], map: MigrationMap): void {
  const first = plan[0];
  if (first === undefined) return;
  const probe = {
    ...eventFor(root, map, first, 'applied', first.beforeSha, []),
    seq: 1,
    at: new Date().toISOString(),
  };
  assertValidEvents([probe]);
}

function assertLedgerSequence(values: Record<string, unknown>[]): void {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index]?.seq !== index + 1) {
      throw new KnowledgeError('invalid_ledger', `${MIGRATION_LEDGER}: seq must be contiguous from 1`);
    }
  }
}

/** Refuse to append over an unterminated tail: its bytes are not a committed record. */
function assertLedgerTail(root: string, relative: string): void {
  const { path } = readLedger(root, relative);
  if (!existsSync(path)) return;
  const bytes = readFileSync(path);
  if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) {
    throw new KnowledgeError('invalid_ledger', `${relative}: interrupted tail must be inspected before appending`);
  }
}

/** Every committed migration-ledger line must be a schema-valid event. */
function assertEventLedger(root: string): void {
  const { values } = readLedger(root, MIGRATION_LEDGER);
  assertLedgerSequence(values);
  for (const value of values) {
    if (value.schema !== 'knowledge-migration-event/1' || eventSchemaErrors(value).length > 0) {
      throw new KnowledgeError('invalid_ledger', `${MIGRATION_LEDGER}: an existing line is not a contract migration event`);
    }
  }
}

/** Validate and append events, assigning the run's seq and timestamp. */
function appendEvents(root: string, events: MigrationEvent[]): void {
  if (events.length === 0) return;
  const { values } = readLedger(root, MIGRATION_LEDGER);
  assertLedgerSequence(values);
  const dated = events.map((event, index) => ({
    ...event,
    seq: values.length + index + 1,
    at: new Date().toISOString(),
  }));
  assertValidEvents(dated);
  for (const event of dated) appendLedger(root, MIGRATION_LEDGER, event);
}

type Moved = { entry: PlannedAction; result: 'applied' | 'noop'; afterSha: string };

function moveOne(root: string, entry: PlannedAction): Moved {
  if (entry.targetSha !== null) {
    // present-not-overwritten: an existing v3 path is skipped, never rewritten.
    return { entry, result: 'noop', afterSha: entry.targetSha };
  }
  if (entry.item.action === 'migrate') writeBackup(root, entry);
  const target = safePath(root, entry.target);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(safePath(root, entry.item.source), target);
  const afterSha = fileDigest(target);
  if (afterSha === null || afterSha !== entry.beforeSha) {
    throw new KnowledgeError('apply_failed', `${entry.item.source}: the written bytes differ`);
  }
  if (entry.item.action === 'migrate') unlinkSync(safePath(root, entry.item.source));
  return { entry, result: 'applied', afterSha };
}

/**
 * The citers a repair pass may touch: the tracked files at plan time (a
 * migrated source is still tracked after its file is gone) plus the run's
 * targets, so a document that was just moved or copied is repaired at its new
 * location too.
 */
function citersFor(root: string, plan: PlannedAction[]): string[] {
  const citers = new Set<string>(trackedFiles(root));
  for (const entry of plan) citers.add(entry.target);
  return [...citers].sort(compareCodePoints);
}

/** The target's bytes after every repair of the run (the recorded after-state). */
function finalAfterSha(root: string, item: Moved): string {
  return fileDigest(safePath(root, item.entry.target)) ?? item.afterSha;
}

/** The planned backup when it already holds the source bytes; null otherwise. */
function existingBackup(root: string, entry: PlannedAction): string | null {
  if (entry.backup === null) return null;
  return fileDigest(safePath(root, entry.backup)) === entry.beforeSha ? entry.backup : null;
}

/**
 * Record an interrupted run's outcome (best effort): a `failed` event no
 * replay accepts, so a partial state can never be mistaken for a completed
 * run. The original error always stands.
 */
function recordFailed(root: string, map: MigrationMap, failing: PlannedAction | undefined): void {
  if (failing === undefined) return;
  try {
    appendEvents(root, [{
      schema: 'knowledge-migration-event/1',
      run_id: map.run_id,
      action: failing.item.action,
      source: failing.item.source,
      target: failing.item.target,
      before_sha256: failing.beforeSha,
      after_sha256: null,
      backup: existingBackup(root, failing),
      refs_repaired: [],
      result: 'failed',
    }]);
  } catch {
    // The ledger may be exactly what failed; recovery is the same either way.
  }
}

function appliedMoves(moved: Moved[]): AppliedMove[] {
  return moved.filter((item) => item.result === 'applied').map((item) => ({
    action: item.entry.item.action,
    source: item.entry.item.source,
    target: item.entry.target,
  }));
}

function repairsFor(
  root: string,
  policy: Policy,
  item: Moved,
  citers: string[],
  relocations: AppliedMove[],
  dirty: Set<string>,
  managed: string[],
  preserved: Set<string>,
): RefRepair[] {
  if (item.result !== 'applied') return [];
  const action = item.entry.item.action;
  if (action !== 'migrate' && action !== 'copy') return [];
  return repairReferences(
    root,
    policy,
    item.entry.item.source,
    item.entry.target,
    repairCiters(action, citers, relocations),
    relocations,
    dirty,
    managed,
    preserved,
  );
}

/**
 * Move every planned item, then repair every citation, then record the run's
 * final bytes: no event hash is read before the last repair lands, so a citer
 * touched by two passes is recorded consistently. Copy repairs run too, but
 * only inside relocated documents, so a copied source stays byte-identical.
 */
function executePlan(
  root: string,
  plan: PlannedAction[],
  map: MigrationMap,
  policy: Policy,
  dirty: Set<string>,
  managed: string[],
): MigrationEvent[] {
  const citers = citersFor(root, plan);
  const moved: Moved[] = [];
  try {
    if (process.env.AI_CATAPULT_ADOPT_FAULT === 'execute') {
      throw new KnowledgeError('apply_failed', 'injected execution failure');
    }
    for (const entry of plan) moved.push(moveOne(root, entry));
    const relocations = appliedMoves(moved);
    const rebased = new Map<string, RefRepair>();
    for (const entry of relocations) {
      const repair = rebaseOne(root, entry.source, entry.target, relocations);
      if (repair !== null) rebased.set(entry.target, repair);
    }
    const repairs = new Map<PlannedAction, RefRepair[]>();
    for (const item of moved) {
      const preserved = new Set(plan.filter((entry) => entry.targetSha !== null).map((entry) => entry.target));
      const citation = repairsFor(root, policy, item, citers, relocations, dirty, managed, preserved);
      const own = rebased.get(item.entry.target);
      repairs.set(item.entry, own === undefined ? citation : [own, ...citation]);
    }
    return moved.map((item) => (
      eventFor(root, map, item.entry, item.result, finalAfterSha(root, item), repairs.get(item.entry) ?? [])
    ));
  } catch (error) {
    recordFailed(root, map, plan[moved.length] ?? plan[plan.length - 1]);
    throw error;
  }
}

function recordedMapPath(root: string, runId: string): string {
  return safePath(root, `${MIGRATION_DIR}/${runId}/map.json`);
}

function readRecordedMap(root: string, runId: string): MigrationMap | null {
  const path = recordedMapPath(root, runId);
  if (!existsSync(path)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new KnowledgeError('invalid_map', `recorded run map is unreadable: ${(error as Error).message}`);
  }
  if (!isRecord(value) || value.schema !== 'knowledge-migration-map/1' || value.run_id !== runId
    || typeof value.source_commit !== 'string' || !Array.isArray(value.items)) {
    throw new KnowledgeError('invalid_map', 'the recorded run map does not describe this run');
  }
  return value as unknown as MigrationMap;
}

/** Consume the confirmation token before the first mutation: no retry under it. */
function consumeToken(root: string, map: MigrationMap, options: Options): void {
  if (options.confirm === undefined) return;
  appendLedger(root, CONFIRMATIONS, {
    schema: 'knowledge-migration-confirmation-event/1',
    at: new Date().toISOString(),
    run_id: map.run_id,
    source_commit: map.source_commit,
    confirmation_token: options.confirm,
    result: 'consumed',
  });
}

/** The run's own outputs — the map and both contract ledgers — must be writable. */
function assertRunOutputs(root: string, map: MigrationMap, hasMigrate: boolean): void {
  assertWritableTarget(root, recordedMapPath(root, map.run_id), `${MIGRATION_DIR}/${map.run_id}/map.json`);
  assertWritableTarget(root, readLedger(root, MIGRATION_LEDGER).path, MIGRATION_LEDGER);
  if (hasMigrate) assertWritableTarget(root, readLedger(root, CONFIRMATIONS).path, CONFIRMATIONS);
}

function porcelainPaths(text: string): string[] {
  const found: string[] = [];
  const parts = text.split('\0');
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    if (entry === undefined || entry.length < 4) continue;
    found.push(entry.slice(3));
    if (entry.startsWith('R') || entry.startsWith('C')) {
      const next = parts[index + 1];
      if (next) found.push(next);
      index += 1;
    }
  }
  return found;
}

/**
 * Paths dirty or untracked before the run. A work tree whose status cannot be
 * listed refuses the run: a missing listing is not treated as a clean tree.
 * A directory that is not a work tree has no git dirty set.
 */
function preExistingDirty(root: string): Set<string> {
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: root, encoding: 'utf8', env: gitEnv(),
  });
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return new Set();
  const status = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: root, encoding: 'utf8', env: gitEnv(), maxBuffer: 64 * 1024 * 1024,
  });
  if (status.status !== 0) {
    throw new KnowledgeError('invalid_ledger', 'pre-existing dirty paths could not be listed');
  }
  return new Set(porcelainPaths(status.stdout));
}

function managedRoots(root: string): string[] {
  const matrix = readMatrix(root);
  if (matrix === null || !Array.isArray(matrix.managed_repositories)) return [];
  const found: string[] = [];
  for (const entry of matrix.managed_repositories) {
    if (isRecord(entry) && typeof entry.path === 'string') found.push(entry.path);
  }
  return found;
}

/**
 * Every predictable refusal of a run, before its first write: confirmation
 * binding and confirmation-ledger schema, map shape, source/target/backup
 * state (including the type of every existing ancestor), overlap, event shape,
 * both contract ledgers (committed lines and an unterminated tail), and a
 * listable dirty set.
 */
function wouldRepair(root: string, citer: string, relocations: AppliedMove[], policy: Policy, dirty: Set<string>, managed: string[]): boolean {
  const path = safePath(root, citer);
  if (!existsSync(path)) return false;
  const content = readFileSync(path);
  return relocations.some((entry) => (
    repairAllowed(root, citer, policy, entry.source, entry.target, dirty, managed)
    && repairedBytes(content, originalCiter(citer, relocations), citer, entry.source, entry.target) !== null
  ));
}

function assertRepairPermissions(root: string, plan: PlannedAction[], dirty: Set<string>, managed: string[]): void {
  const policy = loadPolicy();
  const relocations = plan.filter((entry) => entry.targetSha === null).map((entry) => ({
    action: entry.item.action,
    source: entry.item.source,
    target: entry.target,
  }));
  const preserved = new Set(plan.filter((entry) => entry.targetSha !== null).map((entry) => entry.target));
  for (const citer of citersFor(root, plan)) {
    if (relocations.some((entry) => entry.target === citer) || preserved.has(citer)) continue;
    if (wouldRepair(root, citer, relocations, policy, dirty, managed)) {
      assertEffectivelyWritable(safePath(root, citer), citer);
    }
  }
}

function preflightApply(root: string, map: MigrationMap, options: Options): { dirty: Set<string>; plan: PlannedAction[] } {
  requireConfirmation(root, map, options);
  assertMigrateTargets(map);
  const plan = planItems(root, map);
  const hasMigrate = plan.some((entry) => entry.item.action === 'migrate');
  validateEventShape(root, plan, map);
  assertLedgerTail(root, MIGRATION_LEDGER);
  if (hasMigrate) assertLedgerTail(root, CONFIRMATIONS);
  assertEventLedger(root);
  assertRunOutputs(root, map, hasMigrate);
  const dirty = preExistingDirty(root);
  assertRepairPermissions(root, plan, dirty, managedRoots(root));
  return { dirty, plan };
}

function freshApply(root: string, map: MigrationMap, options: Options): MigrationMap {
  const policy = loadPolicy();
  const prepared = preflightApply(root, map, options);
  const mapPath = recordedMapPath(root, map.run_id);
  mkdirSync(dirname(mapPath), { recursive: true });
  writeFileSync(mapPath, canonical(map), 'utf8');
  if (prepared.plan.some((entry) => entry.item.action === 'migrate')) consumeToken(root, map, options);
  appendEvents(root, executePlan(root, prepared.plan, map, policy, prepared.dirty, managedRoots(root)));
  return map;
}

function asRefRepairs(value: unknown): Array<{ file: string; after_sha256: string }> {
  if (!Array.isArray(value)) return [];
  const repairs: Array<{ file: string; after_sha256: string }> = [];
  for (const entry of value) {
    if (isRecord(entry) && typeof entry.file === 'string' && typeof entry.after_sha256 === 'string') {
      repairs.push({ file: entry.file, after_sha256: entry.after_sha256 });
    }
  }
  return repairs;
}

function verifyTarget(root: string, target: unknown, after: unknown): void {
  if (typeof target !== 'string' || typeof after !== 'string') return;
  if (fileDigest(safePath(root, target)) !== after) {
    throw new KnowledgeError('replay_mismatch', `${target}: after-state drifted`);
  }
}

function verifyBackup(root: string, backup: unknown, before: unknown): void {
  if (typeof backup !== 'string' || typeof before !== 'string') return;
  if (fileDigest(safePath(root, backup)) !== before) {
    throw new KnowledgeError('replay_mismatch', `${backup}: backup bytes drifted`);
  }
}

function verifySourceGone(root: string, action: unknown, source: unknown): void {
  if (action !== 'migrate' || typeof source !== 'string') return;
  if (existsSync(safePath(root, source))) {
    throw new KnowledgeError('replay_mismatch', `${source}: the migrated source exists again`);
  }
}

/**
 * Verify every recorded event's after-state; a drifted run is never replayed.
 * A preserved (noop) target is verified too, and its source stays in place, so
 * only applied migrations must have lost their source.
 */
function verifyAfterStates(root: string, events: Record<string, unknown>[]): void {
  const final = new Map<string, string>();
  for (const event of events) {
    verifyTarget(root, event.target, event.after_sha256);
    verifyBackup(root, event.backup, event.before_sha256);
    if (event.result === 'applied') verifySourceGone(root, event.action, event.source);
    for (const repair of asRefRepairs(event.refs_repaired)) final.set(repair.file, repair.after_sha256);
  }
  for (const [file, after] of final) {
    if (fileDigest(safePath(root, file)) !== after) {
      throw new KnowledgeError('replay_mismatch', `${file}: repaired citation drifted`);
    }
  }
}

function eventBound(event: Record<string, unknown>, item: Relocation): boolean {
  return event.source === item.source
    && event.action === item.action
    && event.target === item.target
    && (event.result === 'applied' || event.result === 'noop')
    && typeof event.after_sha256 === 'string';
}

function assertReplayBound(events: Record<string, unknown>[], items: Relocation[]): void {
  for (const item of items) {
    if (!events.some((event) => eventBound(event, item))) {
      throw new KnowledgeError('replay_mismatch', `${item.source}: the recorded run has no completed event for this action`);
    }
  }
  for (const event of events) {
    if (event.result !== 'applied' && event.result !== 'noop') continue;
    if (!items.some((item) => eventBound(event, item))) {
      throw new KnowledgeError('replay_mismatch', `${String(event.source)}: completion event is not bound to a recorded action`);
    }
  }
}

/** Schema, tail and binding checks. They run before replay's all-noop return. */
function assertReplayReady(root: string, recorded: MigrationMap): Record<string, unknown>[] {
  assertValid(recorded);
  assertLedgerTail(root, MIGRATION_LEDGER);
  assertConfirmationLedger(root);
  assertEventLedger(root);
  const runEvents = readLedger(root, MIGRATION_LEDGER).values.filter((event) => event.run_id === recorded.run_id);
  if (runEvents.some((event) => event.result === 'failed' || event.result === 'rolled-back')) {
    throw new KnowledgeError('replay_mismatch', 'the recorded run is marked failed; recover under a fresh run id');
  }
  assertReplayBound(runEvents, relocations(recorded));
  verifyAfterStates(root, runEvents);
  return runEvents;
}

/** Replay the recorded map of a completed run: verify the after-state, append noops. */
function replayRun(root: string, recorded: MigrationMap): MigrationMap {
  if (recorded.source_commit !== 'uncommitted' && sourceCommit(root) !== recorded.source_commit) {
    throw new KnowledgeError('source_commit_mismatch', 'the recorded run map names another source commit');
  }
  const runEvents = assertReplayReady(root, recorded);
  const applied = runEvents.filter((event) => event.result === 'applied');
  if (applied.length === 0) return recorded;
  appendEvents(root, applied.map((event) => ({ ...event, result: 'noop' })));
  return recorded;
}

function applyRun(root: string, map: MigrationMap, options: Options): MigrationMap {
  const recorded = readRecordedMap(root, options.runId);
  if (recorded !== null) return replayRun(root, recorded);
  return freshApply(root, map, options);
}

function flagValue(argv: string[], index: number): { next: number; value: string } | string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('-')) return 'missing value';
  return { value, next: index + 2 };
}

function consumeLong(argv: string[], arg: string, index: number, flags: Map<string, string | boolean>): number | string {
  const name = arg.slice(2);
  if (name === 'help' || name === 'dry-run' || name === 'apply' || name === 'destructive') {
    flags.set(name, true);
    return index + 1;
  }
  if (!VALUED.has(name)) return `unknown argument: ${arg}`;
  const taken = flagValue(argv, index);
  if (typeof taken === 'string') return `${arg} ${taken}`;
  // The run id addresses .ai/knowledge/migration/<run_id>/: one safe segment.
  if (name === 'run-id' && !SAFE_RUN_ID.test(taken.value)) return `${arg} ${taken.value}: unsafe run id`;
  flags.set(name, taken.value);
  return taken.next;
}

function consume(argv: string[], flags: Map<string, string | boolean>, positionals: string[]): string | null {
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === undefined) break;
    if (arg === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const next = consumeLong(argv, arg, index, flags);
      if (typeof next === 'string') return next;
      index = next;
      continue;
    }
    if (arg.startsWith('-')) {
      if (arg !== '-h') return `unknown argument: ${arg}`;
      flags.set('h', true);
      index += 1;
      continue;
    }
    positionals.push(arg);
    index += 1;
  }
  return null;
}

function requireDir(target: string): string | null {
  // macOS tmpdir is reached through a symlink (/var → /private/var). safePath
  // realpaths every candidate, so the inventory root must be that same path
  // or every file is reported as escapes_root.
  try {
    const resolved = realpathSync(resolve(target));
    const stat = lstatSync(resolved);
    if (!stat.isDirectory()) return null;
    return resolved;
  } catch {
    return null;
  }
}

function optionsFrom(flags: Map<string, string | boolean>): Options {
  const runId = flags.get('run-id');
  const repoId = flags.get('repo-id');
  const confirm = flags.get('confirm');
  const confirmFile = flags.get('confirm-file');
  return {
    apply: flags.has('apply'),
    confirm: typeof confirm === 'string' ? confirm : undefined,
    confirmFile: typeof confirmFile === 'string' ? confirmFile : undefined,
    destructive: flags.has('destructive'),
    repoId: typeof repoId === 'string' ? repoId : undefined,
    runId: typeof runId === 'string' ? runId : defaultRunId(),
  };
}

function parseAdoptArgs(argv: string[]): Parsed {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];
  const error = consume(argv, flags, positionals);
  if (error) return { kind: 'usage', detail: error };
  if (flags.has('help') || flags.has('h')) return { kind: 'help' };
  if (positionals.length > 1) return { kind: 'usage', detail: 'too many arguments' };
  if (flags.has('apply') && flags.has('dry-run')) {
    return { kind: 'usage', detail: '--apply and --dry-run are mutually exclusive' };
  }
  const target = positionals[0] ?? process.cwd();
  const root = requireDir(target);
  if (root === null) return { kind: 'usage', detail: `not a directory: ${target}` };
  return { kind: 'ok', root, options: optionsFrom(flags) };
}

function report(error: unknown): number {
  if (error instanceof KnowledgeError) {
    emit({ error: error.error, detail: error.detail });
    return 1;
  }
  emit({ error: 'invalid_map', detail: String((error as Error).message ?? error) });
  return 1;
}

/** Inventory [target] and return the process exit code. Writes nothing. */
export function runAdopt(argv: string[]): number {
  const parsed = parseAdoptArgs(argv);
  if (parsed.kind === 'help') {
    process.stdout.write(`${ADOPT_HELP}\n`);
    return 0;
  }
  if (parsed.kind === 'usage') {
    process.stderr.write(`ai-catapult adopt: ${parsed.detail}\n${ADOPT_HELP}\n`);
    return 2;
  }
  try {
    const map = buildMap(parsed.root, parsed.options);
    assertValid(map);
    if (parsed.options.apply) {
      emit(applyRun(parsed.root, map, parsed.options));
      return 0;
    }
    emit(map);
    return 0;
  } catch (error) {
    return report(error);
  }
}
