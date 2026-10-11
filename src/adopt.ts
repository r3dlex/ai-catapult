/**
 * Dry-run knowledge inventory for `ai-catapult adopt`.
 *
 * Layout and topology are detected from the target tree, not from its path.
 * Migrate is refused unless a per-run confirmation token is bound to every
 * migrate item. Token shape is the example in ai-catapult-init
 * modules/migration.md (`ct-YYYY-MM-DD-NNN`), the same shape archive
 * confirmation already binds. Apply writes (backups, ledger, reference
 * repair) belong to XSKP-P4-05; this module only opens that gate.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  classify,
  compileSecretPattern,
  compareCodePoints,
  CONTRACT_DIR,
  emit,
  KnowledgeError,
  policyMatches,
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

const ADOPT_HELP = `Usage: ai-catapult adopt [target] [options]

dry-run inventory of a repository. Prints a knowledge-migration-map/1 document
and does not write. --apply refuses migrate actions unless a per-run
confirmation token is bound to them (ai-catapult-init modules/migration.md).
Apply writes are not performed here.

Arguments:
  target                 Directory to inventory (default: current directory)

Options:
  --dry-run              Inventory only (default)
  --apply                Refuse unbound migrate actions; do not write
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

function hasSecret(path: string, policy: Policy): boolean {
  let bytes: Buffer;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000) return false;
    bytes = readFileSync(path);
  } catch {
    return false;
  }
  if (bytes.includes(0)) return false;
  const text = bytes.toString('utf8');
  return policy.deny.secret_patterns.some((pattern) => compileSecretPattern(pattern).test(text));
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
  if (hasSecret(join(root, relative), policy)) {
    return blankItem(relative, 'private', 'skip', 'secret pattern match: content is not recorded');
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

function requireConfirmation(root: string, map: MigrationMap, options: Options): void {
  const pending = map.items.filter((item) => item.action === 'migrate');
  if (pending.length === 0) return;
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
    if (parsed.options.apply) requireConfirmation(parsed.root, map, parsed.options);
    emit(map);
    return 0;
  } catch (error) {
    return report(error);
  }
}
