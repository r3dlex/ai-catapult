/**
 * XSKP-P4-04: `ai-catapult adopt` dry-run inventory.
 * XSKP-P4-05: `ai-catapult adopt --apply` writes (backups, run map, ledger
 * events, reference repairs) and the idempotent rerun.
 *
 * The engine is spawned, never imported. Fixtures are copied to a neutral
 * temp directory (`…/adopt-XXXX/repo`) so layout and topology cannot be read
 * off the fixture path. AC-7 wraps every inventory, apply and refusal test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'bin/ai-catapult.ts');
const fixtures = join(root, 'test/fixtures/knowledge-adopt');
const policyPath = join(root, '.ai/knowledge/contract/publication-policy.json');

const LAYOUTS = ['greenfield', 'brownfield', 'partial-v3', 'legacy-agents', 'legacy-ai-sdlc'] as const;
const TOPOLOGIES = ['single', 'monorepo', 'umbrella'] as const;
const MAP_KEYS = ['created_at', 'items', 'layout', 'repo_id', 'run_id', 'schema', 'source_commit', 'topology'];
const ITEM_KEYS = [
  'action', 'broken_links', 'classification', 'conflicts', 'duplicate_of', 'kind',
  'knowledge_id', 'reason', 'sha256', 'source', 'surface', 'target',
];
const ACTIONS = new Set(['adopt', 'copy', 'migrate', 'supersede', 'deprecate', 'reference', 'skip', 'unresolved']);
const CLASSES = new Set(['canonical', 'native', 'native-legacy', 'workspace-convention', 'private', 'unsupported']);
const SURFACES = new Set(['omc', 'omx', 'omo', 'workspace']);
const TOKEN = 'ct-2026-10-11-001';

type MapItem = {
  action: string;
  broken_links: string[];
  classification: string;
  conflicts: string[];
  duplicate_of: string | null;
  kind: string | null;
  knowledge_id: string | null;
  reason: string;
  sha256: string | null;
  source: string;
  surface: string;
  target: string | null;
};

type MigrationMap = {
  created_at: string;
  items: MapItem[];
  layout: string;
  repo_id: string;
  run_id: string;
  schema: string;
  source_commit: string;
  topology: string;
};

type Policy = {
  deny: { paths: string[] };
  immutable: string[];
  unsupported_formats: string[];
};

type Managed = { path: string; depth: number; inherits_assets_from: string; repo_id: string; canonical_origin: string };

type Matrix = {
  topology_type: string;
  max_allowed_depth: number;
  current_depth: number;
  sync_strategy: string;
  repo_id: string;
  managed_repositories: Managed[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const TARGET_FROZEN = [
  '.omc', '.omx', '.omo', '.sisyphus', '.memory',
  '.ai/evidence', '.ai/handoff/readiness-v1', '.ai/workflows/northstar-readiness-v1.json',
];
const ENGINE_OUTPUTS = ['.ai/knowledge/migration/', '.ai/drift/backups/', '.ai/knowledge/.locks/'];

type Preserved = { digest: string; frozen: boolean; rel: string };

function isEngineOutput(rel: string): boolean {
  return ENGINE_OUTPUTS.some((prefix) => rel === prefix.slice(0, -1) || rel.startsWith(prefix));
}

function adoptTarget(args: string[]): string | null {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const arg = args[index];
    if (arg === undefined || arg.startsWith('-')) continue;
    try {
      if (lstatSync(arg).isDirectory()) return arg;
    } catch {
      // A missing positional is not the inventory root.
    }
  }
  return null;
}

function collectFiles(tmp: string, rel: string, found: string[]): void {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(join(tmp, rel));
  } catch {
    return;
  }
  if (info.isSymbolicLink() || info.isFile()) {
    found.push(rel);
    return;
  }
  if (!info.isDirectory()) return;
  for (const name of readdirSync(join(tmp, rel))) collectFiles(tmp, `${rel}/${name}`, found);
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

function gitTestEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  return env;
}

/**
 * Policy glob, matching src/knowledge.ts. The guard classifies the target's
 * private paths itself so a missed deny cannot hide a rewrite.
 */
function policyMatches(path: string, pattern: string): boolean {
  let expression = '';
  let index = 0;
  while (index < pattern.length) {
    if (pattern.startsWith('**/', index)) {
      expression += '(?:.*/)?';
      index += 3;
    } else if (pattern.startsWith('**', index)) {
      expression += '.*';
      index += 2;
    } else if (pattern.charAt(index) === '*') {
      expression += '[^/]*';
      index += 1;
    } else {
      expression += pattern.charAt(index).replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
      index += 1;
    }
  }
  return new RegExp(`^(?:${expression})$`, 's').test(path);
}

function denyPatterns(): string[] {
  const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as Policy;
  return policy.deny.paths;
}

function managedRootsOf(tmp: string): string[] {
  const matrixPath = join(tmp, '.ai/matrix.json');
  if (!existsSync(matrixPath)) return [];
  try {
    const value: unknown = JSON.parse(readFileSync(matrixPath, 'utf8'));
    if (!isRecord(value) || !Array.isArray(value.managed_repositories)) return [];
    const found: string[] = [];
    for (const entry of value.managed_repositories) {
      if (isRecord(entry) && typeof entry.path === 'string' && entry.path !== '') found.push(entry.path);
    }
    return found;
  } catch {
    return [];
  }
}

function isDenied(rel: string, patterns: string[]): boolean {
  return patterns.some((pattern) => policyMatches(rel, pattern) || policyMatches(`${rel}/x`, pattern));
}

function isManagedRel(rel: string, managed: string[]): boolean {
  return managed.some((path) => rel === path || rel.startsWith(`${path}/`));
}

function isGitMetadata(rel: string): boolean {
  return rel === '.git' || rel.startsWith('.git/') || rel.endsWith('/.git') || rel.includes('/.git/');
}

function rememberProtected(rel: string, patterns: string[], managed: string[], found: string[]): void {
  if (rel !== '' && (isDenied(rel, patterns) || isManagedRel(rel, managed))) found.push(rel);
}

function walkProtected(tmp: string, rel: string, patterns: string[], managed: string[], found: string[]): void {
  if (isGitMetadata(rel)) return;
  const abs = rel === '' ? tmp : join(tmp, rel);
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(abs);
  } catch {
    return;
  }
  if (info.isSymbolicLink() || info.isFile()) {
    rememberProtected(rel, patterns, managed, found);
    return;
  }
  if (!info.isDirectory()) return;
  for (const name of readdirSync(abs)) {
    walkProtected(tmp, rel === '' ? name : `${rel}/${name}`, patterns, managed, found);
  }
}

function policyProtected(tmp: string): string[] {
  const found: string[] = [];
  walkProtected(tmp, '', denyPatterns(), managedRootsOf(tmp), found);
  return found;
}

function protectedFiles(tmp: string): string[] {
  const files: string[] = [];
  for (const prefix of TARGET_FROZEN) collectFiles(tmp, prefix, files);
  files.push(...policyProtected(tmp));
  return [...new Set(files)].sort();
}

function dirtyPaths(tmp: string): string[] {
  const env = gitTestEnv();
  const inside = spawnSync('git', ['-C', tmp, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8', env, timeout: 30_000,
  });
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return [];
  const status = spawnSync('git', ['-C', tmp, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    encoding: 'utf8', env, timeout: 30_000,
  });
  if (status.status !== 0) {
    throw new Error(`AC-7: dirty listing failed: ${status.stderr}`);
  }
  return porcelainPaths(status.stdout);
}

function digestOf(tmp: string, rel: string): string {
  try {
    const abs = join(tmp, rel);
    const info = lstatSync(abs);
    if (info.isSymbolicLink()) return `link ${readlinkSync(abs)}`;
    if (!info.isFile()) return 'not-a-file';
    return createHash('sha256').update(readFileSync(abs)).digest('hex');
  } catch {
    return 'missing';
  }
}

function preservationSnapshot(tmp: string): Preserved[] {
  const frozen = new Set(protectedFiles(tmp));
  const files = [...frozen];
  for (const rel of dirtyPaths(tmp)) {
    if (!isEngineOutput(rel)) files.push(rel);
  }
  return [...new Set(files)].sort().map((rel) => ({
    digest: digestOf(tmp, rel), frozen: frozen.has(rel), rel,
  }));
}

function frozenFiles(tmp: string): string[] {
  return protectedFiles(tmp);
}

function assertTargetPreserved(tmp: string, before: Preserved[]): void {
  for (const item of before) {
    const now = digestOf(tmp, item.rel);
    if (now === 'missing') {
      assert.equal(item.frozen, false, `AC-7: ${item.rel} was removed`);
      continue;
    }
    assert.equal(now, item.digest, `AC-7: ${item.rel} was rewritten`);
  }
  const frozenBefore = before.filter((item) => item.frozen).map((item) => item.rel);
  assert.deepEqual(frozenFiles(tmp), frozenBefore, 'AC-7: a native or immutable path was added');
}

function spawnAdopt(args: string[], env?: NodeJS.ProcessEnv) {
  const target = adoptTarget(args);
  const before = target === null ? [] : preservationSnapshot(target);
  const result = spawnSync(process.execPath, [bin, 'adopt', ...args], { encoding: 'utf8', timeout: 30_000, env });
  if (target !== null) assertTargetPreserved(target, before);
  return result;
}

function stage(layout: string, topology: string): string {
  const parent = mkdtempSync(join(tmpdir(), 'adopt-'));
  const dest = join(parent, 'repo');
  cpSync(join(fixtures, layout, topology), dest, { recursive: true });
  return dest;
}

function discard(tmp: string): void {
  rmSync(dirname(tmp), { recursive: true, force: true });
}

/**
 * `git -C <dir>` with an explicit identity, so fixture repos commit without
 * touching the user's global git config.
 */
function gitIn(dir: string, ...args: string[]) {
  return spawnSync('git', ['-C', dir, '-c', 'user.email=test@example.com', '-c', 'user.name=test', ...args], {
    encoding: 'utf8',
    timeout: 30_000,
  });
}

/** Stage a fixture and commit it, so the inventory reads a real source_commit. */
function stageGitRepo(layout: string, topology: string): string {
  const tmp = stage(layout, topology);
  const init = gitIn(tmp, 'init', '-q');
  assert.equal(init.status, 0, init.stderr);
  const add = gitIn(tmp, 'add', '-A');
  assert.equal(add.status, 0, add.stderr);
  const commit = gitIn(tmp, 'commit', '-q', '-m', 'fixture base');
  assert.equal(commit.status, 0, commit.stderr);
  return tmp;
}

function commitAll(tmp: string, message: string): void {
  const add = gitIn(tmp, 'add', '-A');
  assert.equal(add.status, 0, add.stderr);
  const commit = gitIn(tmp, 'commit', '-q', '-m', message);
  assert.equal(commit.status, 0, commit.stderr);
}

function treeDigest(dir: string, skip: (rel: string) => boolean = () => false): string {
  const lines: string[] = [];
  const visit = (rel: string): void => {
    const abs = rel === '' ? dir : join(dir, rel);
    if (rel !== '' && skip(rel)) return;
    const info = lstatSync(abs);
    if (info.isSymbolicLink()) {
      lines.push(`${rel} -> ${readlinkSync(abs)}`);
      return;
    }
    if (info.isDirectory()) {
      if (rel !== '') lines.push(`${rel}/`);
      for (const name of readdirSync(abs).sort()) visit(rel === '' ? name : `${rel}/${name}`);
      return;
    }
    const digest = createHash('sha256').update(readFileSync(abs)).digest('hex');
    lines.push(`${rel} ${digest}`);
  };
  visit('');
  return lines.join('\n');
}

function stringArray(value: unknown, label: string): string[] {
  assert.ok(Array.isArray(value), label);
  for (const entry of value) assert.equal(typeof entry, 'string', label);
  return value as string[];
}

function nullableString(value: unknown, label: string): string | null {
  assert.ok(value === null || typeof value === 'string', label);
  return value;
}

function assertItem(value: unknown): MapItem {
  assert.ok(isRecord(value), 'item');
  assert.deepEqual(Object.keys(value).sort(), [...ITEM_KEYS].sort());
  assert.ok(ACTIONS.has(String(value.action)), `action ${String(value.action)}`);
  assert.ok(CLASSES.has(String(value.classification)), `class ${String(value.classification)}`);
  assert.ok(SURFACES.has(String(value.surface)), `surface ${String(value.surface)}`);
  assert.equal(typeof value.reason, 'string');
  assert.ok(String(value.reason).length > 0, 'reason');
  assert.equal(typeof value.source, 'string');
  const sha = nullableString(value.sha256, 'sha256');
  assert.ok(sha === null || /^[0-9a-f]{64}$/.test(sha), 'sha256');
  return {
    action: String(value.action),
    broken_links: stringArray(value.broken_links, 'broken_links'),
    classification: String(value.classification),
    conflicts: stringArray(value.conflicts, 'conflicts'),
    duplicate_of: nullableString(value.duplicate_of, 'duplicate_of'),
    kind: nullableString(value.kind, 'kind'),
    knowledge_id: nullableString(value.knowledge_id, 'knowledge_id'),
    reason: String(value.reason),
    sha256: sha,
    source: String(value.source),
    surface: String(value.surface),
    target: nullableString(value.target, 'target'),
  };
}

function parseMap(stdout: string): MigrationMap {
  const value: unknown = JSON.parse(stdout);
  assert.ok(isRecord(value), 'map');
  assert.deepEqual(Object.keys(value).sort(), [...MAP_KEYS].sort());
  assert.equal(value.schema, 'knowledge-migration-map/1');
  assert.ok(LAYOUTS.includes(value.layout as typeof LAYOUTS[number]), `layout ${String(value.layout)}`);
  assert.ok(TOPOLOGIES.includes(value.topology as typeof TOPOLOGIES[number]), `topology ${String(value.topology)}`);
  assert.equal(typeof value.created_at, 'string');
  assert.equal(typeof value.repo_id, 'string');
  assert.equal(typeof value.run_id, 'string');
  assert.equal(typeof value.source_commit, 'string');
  assert.ok(String(value.repo_id).length > 0 && String(value.source_commit).length > 0);
  assert.ok(Array.isArray(value.items), 'items');
  return {
    created_at: String(value.created_at),
    items: value.items.map((item) => assertItem(item)),
    layout: String(value.layout),
    repo_id: String(value.repo_id),
    run_id: String(value.run_id),
    schema: String(value.schema),
    source_commit: String(value.source_commit),
    topology: String(value.topology),
  };
}

function itemBySource(map: MigrationMap, source: string): MapItem {
  const found = map.items.find((item) => item.source === source);
  assert.ok(found, `missing ${source}`);
  return found;
}

function assertPolicyPlants(map: MigrationMap): void {
  const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as Policy;
  assert.ok(policy.deny.paths.includes('**/.env'));
  assert.ok(policy.immutable.includes('.ai/evidence/**'));
  assert.ok(policy.unsupported_formats.includes('*.pdf'));
  const env = itemBySource(map, '.env');
  assert.equal(env.classification, 'private');
  assert.equal(env.action, 'skip');
  assert.equal(env.sha256, null);
  const pin = itemBySource(map, '.ai/evidence/pin.json');
  assert.equal(pin.action, 'skip');
  assert.match(pin.reason, /immutable/);
  assert.match(pin.sha256 ?? '', /^[0-9a-f]{64}$/);
  const pdf = itemBySource(map, 'docs/figure.pdf');
  assert.equal(pdf.classification, 'unsupported');
  assert.equal(pdf.action, 'skip');
  assert.equal(pdf.sha256, null);
}

function assertNested(map: MigrationMap, tmp: string): void {
  const matrix = JSON.parse(readFileSync(join(tmp, '.ai/matrix.json'), 'utf8')) as Matrix;
  for (const entry of matrix.managed_repositories) {
    const listed = itemBySource(map, entry.path);
    assert.equal(listed.action, 'skip');
    assert.equal(map.items.some((item) => item.source.startsWith(`${entry.path}/`)), false, entry.path);
  }
}

function assertAiToolShape(map: MigrationMap): void {
  const matrix = JSON.parse(readFileSync(join(fixtures, 'partial-v3/umbrella/.ai/matrix.json'), 'utf8')) as Matrix;
  assert.equal(matrix.topology_type, 'umbrella');
  assert.equal(matrix.max_allowed_depth, 3);
  assert.equal(matrix.current_depth, 1);
  assert.equal(matrix.sync_strategy, 'physical-copy');
  assert.equal(matrix.repo_id, 'aitool-root');
  assert.ok(matrix.managed_repositories.length >= 2);
  for (const entry of matrix.managed_repositories) {
    assert.equal(typeof entry.path, 'string');
    assert.equal(typeof entry.depth, 'number');
    assert.equal(entry.inherits_assets_from, '.');
    assert.equal(typeof entry.repo_id, 'string');
    assert.match(entry.canonical_origin, /^https:\/\//);
  }
  assert.equal(map.repo_id, 'aitool-root');
  assert.equal(map.topology, 'umbrella');
  assert.equal(map.layout, 'partial-v3');
}

const GUARDED = ['.omc', '.omx', '.omo', '.sisyphus', '.ai/evidence', '.ai/handoff/readiness-v1', '.ai/workflows/northstar-readiness-v1.json'];

function guardedDigests(): string[] {
  const lines: string[] = [];
  const visit = (rel: string): void => {
    const abs = join(root, rel);
    if (!existsSync(abs)) return;
    const info = lstatSync(abs);
    if (info.isSymbolicLink()) {
      lines.push(`${rel} -> ${readlinkSync(abs)}`);
      return;
    }
    if (info.isDirectory()) {
      for (const name of readdirSync(abs)) visit(`${rel}/${name}`);
      return;
    }
    lines.push(`${rel} ${createHash('sha256').update(readFileSync(abs)).digest('hex')}`);
  };
  for (const prefix of GUARDED) visit(prefix);
  return lines.sort();
}

function checkoutSnapshot() {
  // Porcelain is limited to the native and immutable paths AC-7 names.
  // `npm test` runs files in parallel, and test/dead-refs.test.ts rewrites
  // README.md for the duration of one assertion; a repo-wide status would
  // report that unrelated edit as an adopt mutation.
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--', ...GUARDED], {
    cwd: root, encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(status.status, 0, status.stderr);
  return { status: status.stdout, digests: guardedDigests() };
}

function annotate(failure: unknown, name: string, changed: boolean): Error {
  const error = failure instanceof Error ? failure : new Error(String(failure));
  if (changed) error.message += `\nAC-7: ${name} also changed the checkout`;
  return error;
}

function ac7Guarded(name: string, body: () => void): void {
  const before = checkoutSnapshot();
  let failure: unknown = null;
  try {
    body();
  } catch (error) {
    failure = error;
  }
  const after = checkoutSnapshot();
  if (failure) throw annotate(failure, name, JSON.stringify(after) !== JSON.stringify(before));
  assert.deepEqual(after, before, `AC-7: ${name} changed the checkout`);
}

function inventoryCase(layout: string, topology: string): void {
  const tmp = stage(layout, topology);
  try {
    const before = treeDigest(tmp);
    const result = spawnAdopt(['--dry-run', '--run-id', 'inv', tmp]);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const map = parseMap(result.stdout);
    assert.equal(map.layout, layout);
    assert.equal(map.topology, topology);
    assert.equal(map.source_commit, 'uncommitted');
    assert.equal(map.run_id, 'inv');
    assertPolicyPlants(map);
    if (topology === 'umbrella') assertNested(map, tmp);
    if (layout === 'partial-v3' && topology === 'umbrella') assertAiToolShape(map);
    assert.equal(treeDigest(tmp), before, 'dry-run wrote the fixture');
  } finally {
    discard(tmp);
  }
}

function errorOf(stdout: string): string {
  const value: unknown = JSON.parse(stdout);
  assert.ok(isRecord(value));
  return String(value.error);
}

function confirmFile(tmp: string, map: MigrationMap, runId: string, backup: (source: string) => string): string {
  const actions = map.items.filter((item) => item.action === 'migrate').map((item) => ({
    source: item.source,
    target: item.target,
    backup: backup(item.source),
  }));
  const path = join(dirname(tmp), 'confirm.json');
  writeFileSync(path, JSON.stringify({
    schema: 'knowledge-migration-confirmation/1',
    run_id: runId,
    confirmation_token: TOKEN,
    source_commit: map.source_commit,
    actions,
  }));
  return path;
}

const LEDGER_REL = '.ai/knowledge/migration/ledger.jsonl';

type RefRepair = { file: string; before_sha256: string; after_sha256: string };

type LedgerEvent = {
  action: string;
  after_sha256: string | null;
  at: string;
  backup: string | null;
  before_sha256: string | null;
  refs_repaired: RefRepair[];
  result: string;
  run_id: string;
  schema: string;
  seq: number;
  source: string;
  target: string | null;
};

function readLedger(tmp: string): LedgerEvent[] {
  const path = join(tmp, LEDGER_REL);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as LedgerEvent);
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function assertEventShape(event: LedgerEvent): void {
  assert.equal(event.schema, 'knowledge-migration-event/1');
  assert.ok(['applied', 'noop', 'failed', 'rolled-back'].includes(event.result), event.result);
  assert.equal(typeof event.run_id, 'string');
  assert.equal(typeof event.at, 'string');
  assert.ok(Number.isInteger(event.seq) && event.seq >= 1, `seq ${event.seq}`);
  assert.match(event.before_sha256 ?? '', /^[0-9a-f]{64}$/);
  if (event.after_sha256 !== null) assert.match(event.after_sha256, /^[0-9a-f]{64}$/);
  assert.ok(Array.isArray(event.refs_repaired));
  for (const repair of event.refs_repaired) {
    assert.equal(typeof repair.file, 'string');
    assert.match(repair.before_sha256, /^[0-9a-f]{64}$/);
    assert.match(repair.after_sha256, /^[0-9a-f]{64}$/);
  }
}

function migrateConfirmation(tmp: string, map: MigrationMap, runId: string): string {
  return confirmFile(tmp, map, runId, (source) => `.ai/drift/backups/${runId}/${source}`);
}

void test('test/adopt.test.ts is auto-discovered by node --test under npm test', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: { test: string } };
  assert.match(pkg.scripts.test, /node --test test\/\*\.test\.ts/);
  assert.match(fileURLToPath(import.meta.url), /\/test\/adopt\.test\.ts$/);
});

void test('adopt is a dispatched command', () => {
  ac7Guarded('help', () => {
    const result = spawnAdopt(['--help']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /dry-run inventory/);
  });
});

for (const layout of LAYOUTS) {
  for (const topology of TOPOLOGIES) {
    void test(`dry-run inventory ${layout} × ${topology}`, () => {
      ac7Guarded(`${layout}/${topology}`, () => inventoryCase(layout, topology));
    });
  }
}

void test('a >1MB file is scanned completely: a policy secret classifies it private', () => {
  ac7Guarded('large-secret', () => {
    const tmp = stage('brownfield', 'single');
    try {
      const filler = 'public notes line\n'.repeat(60_000);
      writeFileSync(join(tmp, 'docs/large-notes.md'), `${filler}sk-${'a'.repeat(24)}\n`);
      const result = spawnAdopt(['--dry-run', '--run-id', 'inv', tmp]);
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
      const map = parseMap(result.stdout);
      const item = itemBySource(map, 'docs/large-notes.md');
      assert.equal(item.classification, 'private', item.reason);
      assert.equal(item.action, 'skip');
      assert.equal(item.sha256, null);
    } finally {
      discard(tmp);
    }
  });
});

void test('a NUL-bearing file is never adopted secret-free', () => {
  ac7Guarded('nul-bytes', () => {
    const tmp = stage('brownfield', 'single');
    try {
      writeFileSync(join(tmp, 'docs/nul-notes.md'), Buffer.concat([
        Buffer.from('notes\n'),
        Buffer.from([0x00, 0x00]),
        Buffer.from(`sk-${'b'.repeat(24)}\n`),
      ]));
      const result = spawnAdopt(['--dry-run', '--run-id', 'inv', tmp]);
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
      const map = parseMap(result.stdout);
      const item = itemBySource(map, 'docs/nul-notes.md');
      assert.equal(item.classification, 'unsupported', item.reason);
      assert.equal(item.action, 'skip');
      assert.equal(item.sha256, null);
    } finally {
      discard(tmp);
    }
  });
});

void test('an unreadable file is never adopted secret-free', () => {
  ac7Guarded('unreadable-secret', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    const tmp = stage('brownfield', 'single');
    try {
      const path = join(tmp, 'docs/unreadable-notes.md');
      writeFileSync(path, `sk-${'c'.repeat(24)}\n`);
      chmodSync(path, 0o000);
      const result = spawnAdopt(['--dry-run', '--run-id', 'inv', tmp]);
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
      const map = parseMap(result.stdout);
      const item = itemBySource(map, 'docs/unreadable-notes.md');
      assert.equal(item.classification, 'unsupported', item.reason);
      assert.equal(item.action, 'skip');
      assert.equal(item.sha256, null);
    } finally {
      discard(tmp);
    }
  });
});

void test('migrate actions are refused without the per-run confirmation token', () => {
  ac7Guarded('refuse', () => {
    const tmp = stage('legacy-ai-sdlc', 'single');
    try {
      writeFileSync(join(tmp, '.rules.ts'), 'export const rules: readonly string[] = [];\n');
      const dry = spawnAdopt(['--dry-run', '--destructive', '--run-id', 'run-1', tmp]);
      assert.equal(dry.status, 0, dry.stdout);
      const map = parseMap(dry.stdout);
      assert.equal(itemBySource(map, '.rules.ts').action, 'migrate');
      assert.equal(itemBySource(map, 'docs/adr/0001-init.md').action, 'migrate');
      const before = treeDigest(tmp);
      const refused = spawnAdopt(['--apply', '--destructive', '--run-id', 'run-1', tmp]);
      assert.equal(refused.status, 1);
      assert.equal(errorOf(refused.stdout), 'confirmation_required');
      assert.equal(treeDigest(tmp), before);
    } finally {
      discard(tmp);
    }
  });
});

void test('a malformed confirmation token is refused', () => {
  ac7Guarded('malformed', () => {
    const tmp = stage('legacy-ai-sdlc', 'single');
    try {
      const before = treeDigest(tmp);
      const refused = spawnAdopt(['--apply', '--destructive', '--run-id', 'run-1', '--confirm', 'nope', tmp]);
      assert.equal(refused.status, 1);
      assert.equal(errorOf(refused.stdout), 'invalid_confirmation');
      assert.equal(treeDigest(tmp), before);
    } finally {
      discard(tmp);
    }
  });
});

void test('a token that does not bind this run is refused', () => {
  ac7Guarded('unbound', () => {
    const tmp = stage('legacy-ai-sdlc', 'single');
    try {
      const dry = spawnAdopt(['--dry-run', '--destructive', '--run-id', 'run-1', tmp]);
      const map = parseMap(dry.stdout);
      const file = confirmFile(tmp, map, 'run-1', () => 'nope');
      const before = treeDigest(tmp);
      const refused = spawnAdopt([
        '--apply', '--destructive', '--run-id', 'run-1', '--confirm', TOKEN, '--confirm-file', file, tmp,
      ]);
      assert.equal(refused.status, 1);
      assert.equal(errorOf(refused.stdout), 'invalid_confirmation');
      assert.equal(treeDigest(tmp), before);
    } finally {
      discard(tmp);
    }
  });
});

void test('a token bound to this run applies the migration: backups, run map and ledger events', () => {
  ac7Guarded('bound-apply', () => {
    const tmp = stage('legacy-ai-sdlc', 'single');
    try {
      writeFileSync(join(tmp, '.rules.ts'), 'export const rules: readonly string[] = [];\n');
      const dry = spawnAdopt(['--dry-run', '--destructive', '--run-id', 'run-1', tmp]);
      const map = parseMap(dry.stdout);
      const file = migrateConfirmation(tmp, map, 'run-1');
      const accepted = spawnAdopt([
        '--apply', '--destructive', '--run-id', 'run-1', '--confirm', TOKEN, '--confirm-file', file, tmp,
      ]);
      assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
      assert.equal(errorOfSafe(accepted.stdout), '');

      // The run map is written before the write phase and describes this run.
      const recorded = JSON.parse(
        readFileSync(join(tmp, '.ai/knowledge/migration/run-1/map.json'), 'utf8'),
      ) as MigrationMap;
      assert.equal(recorded.schema, 'knowledge-migration-map/1');
      assert.equal(recorded.run_id, 'run-1');

      const migrations = recorded.items.filter((item) => item.action === 'migrate');
      assert.ok(migrations.length >= 1);
      const events = readLedger(tmp);
      events.forEach(assertEventShape);
      assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index + 1));
      for (const item of migrations) {
        assert.equal(existsSync(join(tmp, item.source)), false, `${item.source} must be removed`);
        const target = item.target as string;
        assert.ok(existsSync(join(tmp, target)), `${target} must be written`);
        const event = events.find((entry) => entry.run_id === 'run-1' && entry.source === item.source);
        assert.ok(event, `no ledger event for ${item.source}`);
        assert.equal(event.result, 'applied');
        assert.equal(event.action, 'migrate');
        assert.equal(event.backup, `.ai/drift/backups/run-1/${item.source}`);
        const backup = event.backup;
        assert.ok(backup, 'a migrate event names its backup');
        assert.equal(sha256File(join(tmp, backup)), event.before_sha256);
        assert.equal(sha256File(join(tmp, target)), event.after_sha256);
      }

      // The per-run token is consumed exactly once, on this run.
      const confirmations = readFileSync(join(tmp, '.ai/knowledge/migration/confirmations.jsonl'), 'utf8');
      const consumed = confirmations.split('\n').filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as { confirmation_token: string; run_id: string });
      assert.ok(consumed.some((entry) => entry.confirmation_token === TOKEN && entry.run_id === 'run-1'));
    } finally {
      discard(tmp);
    }
  });
});

void test('a rerun on the same commit appends only noop events and rewrites nothing', () => {
  ac7Guarded('rerun-noop', () => {
    const tmp = stage('legacy-ai-sdlc', 'single');
    try {
      writeFileSync(join(tmp, '.rules.ts'), 'export const rules: readonly string[] = [];\n');
      const dry = spawnAdopt(['--dry-run', '--destructive', '--run-id', 'run-1', tmp]);
      const map = parseMap(dry.stdout);
      const file = migrateConfirmation(tmp, map, 'run-1');
      const first = spawnAdopt([
        '--apply', '--destructive', '--run-id', 'run-1', '--confirm', TOKEN, '--confirm-file', file, tmp,
      ]);
      assert.equal(first.status, 0, first.stdout);
      const ledgerBefore = readLedger(tmp);
      const applied = ledgerBefore.filter((event) => event.result === 'applied');
      assert.ok(applied.length > 0, 'the first apply must have applied the migration');
      const treeBefore = treeDigest(tmp, (rel) => rel === LEDGER_REL);

      const rerun = spawnAdopt([
        '--apply', '--destructive', '--run-id', 'run-1', '--confirm', TOKEN, '--confirm-file', file, tmp,
      ]);
      assert.equal(rerun.status, 0, `${rerun.stdout}\n${rerun.stderr}`);
      assert.equal(errorOfSafe(rerun.stdout), '');

      const ledgerAfter = readLedger(tmp);
      const added = ledgerAfter.slice(ledgerBefore.length);
      assert.equal(added.length, applied.length, 'the rerun appends one noop per applied event');
      assert.deepEqual(added.map((event) => event.result), added.map(() => 'noop'));
      assert.deepEqual(ledgerAfter.map((event) => event.seq), ledgerAfter.map((_, index) => index + 1));
      for (const event of added) assertEventShape(event);
      assert.equal(treeDigest(tmp, (rel) => rel === LEDGER_REL), treeBefore, 'the rerun rewrites nothing but the ledger');
    } finally {
      discard(tmp);
    }
  });
});

void test('apply copies legacy skill files without a token and keeps the source', () => {
  ac7Guarded('copy-apply', () => {
    const tmp = stage('legacy-agents', 'single');
    try {
      const dry = spawnAdopt(['--dry-run', '--run-id', 'run-2', tmp]);
      const map = parseMap(dry.stdout);
      const copies = map.items.filter((item) => item.action === 'copy');
      assert.equal(copies.length, 2);
      const applied = spawnAdopt(['--apply', '--run-id', 'run-2', tmp]);
      assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
      assert.equal(errorOfSafe(applied.stdout), '');
      for (const item of copies) {
        const target = item.target as string;
        assert.ok(existsSync(join(tmp, target)), `${target} must be written`);
        assert.ok(existsSync(join(tmp, item.source)), `${item.source} must be kept`);
        assert.equal(sha256File(join(tmp, target)), item.sha256);
      }
      const events = readLedger(tmp);
      assert.equal(events.length, copies.length);
      for (const event of events) {
        assertEventShape(event);
        assert.equal(event.action, 'copy');
        assert.equal(event.result, 'applied');
        assert.equal(event.backup, null, 'a copy changes no source bytes');
      }
      assert.equal(existsSync(join(tmp, '.ai/drift/backups/run-2')), false, 'no backup is written for copy');
    } finally {
      discard(tmp);
    }
  });
});

void test('apply never overwrites an existing v3 target: present-not-overwritten is a noop', () => {
  ac7Guarded('present-not-overwritten', () => {
    const tmp = stage('legacy-agents', 'single');
    try {
      const dry = spawnAdopt(['--dry-run', '--run-id', 'run-3', tmp]);
      const map = parseMap(dry.stdout);
      const item = map.items.find((entry) => entry.action === 'copy');
      assert.ok(item, 'the fixture carries a copy item');
      const target = item.target as string;
      mkdirSync(dirname(join(tmp, target)), { recursive: true });
      writeFileSync(join(tmp, target), 'user content that is not the template\n');
      const targetBefore = sha256File(join(tmp, target));
      const applied = spawnAdopt(['--apply', '--run-id', 'run-3', tmp]);
      assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
      assert.equal(sha256File(join(tmp, target)), targetBefore, 'an existing v3 path is never overwritten');
      const event = readLedger(tmp).find((entry) => entry.source === item.source);
      assert.ok(event);
      assert.equal(event.result, 'noop');
      assertEventShape(event);
    } finally {
      discard(tmp);
    }
  });
});

void test('a replay after the recorded after-state drifted refuses and appends nothing', () => {
  ac7Guarded('replay-mismatch', () => {
    const tmp = stage('legacy-ai-sdlc', 'single');
    try {
      writeFileSync(join(tmp, '.rules.ts'), 'export const rules: readonly string[] = [];\n');
      const dry = spawnAdopt(['--dry-run', '--destructive', '--run-id', 'run-4', tmp]);
      const map = parseMap(dry.stdout);
      const file = migrateConfirmation(tmp, map, 'run-4');
      const first = spawnAdopt([
        '--apply', '--destructive', '--run-id', 'run-4', '--confirm', TOKEN, '--confirm-file', file, tmp,
      ]);
      assert.equal(first.status, 0, first.stdout);
      const ledgerBefore = readLedger(tmp);
      const migrated = map.items.find((item) => item.source === '.rules.ts') as MapItem;
      writeFileSync(join(tmp, migrated.target as string), 'drifted bytes\n');
      const rerun = spawnAdopt([
        '--apply', '--destructive', '--run-id', 'run-4', '--confirm', TOKEN, '--confirm-file', file, tmp,
      ]);
      assert.equal(rerun.status, 1);
      assert.equal(errorOfSafe(rerun.stdout), 'replay_mismatch');
      assert.equal(readLedger(tmp).length, ledgerBefore.length, 'a refused replay appends nothing');
    } finally {
      discard(tmp);
    }
  });
});

void test('apply repairs tracked citations of a migrated source and records them', () => {
  ac7Guarded('reference-repair', () => {
    const tmp = stageGitRepo('legacy-ai-sdlc', 'single');
    try {
      writeFileSync(join(tmp, '.rules.ts'), 'export const rules: readonly string[] = [];\n');
      // A citation inside a document that is itself migrated: its body must be
      // repaired at the new location (the source path is gone after the move).
      writeFileSync(join(tmp, 'docs/adr/0001-init.md'), '# legacy adr\n\nThe rules lived at `.rules.ts`.\n');
      const refs = 'notes/refs.md';
      mkdirSync(dirname(join(tmp, refs)), { recursive: true });
      writeFileSync(join(tmp, refs), [
        '# References',
        '',
        'The rules live at `.rules.ts`.',
        '',
        'See [the ADR](../docs/adr/0001-init.md) for the decision.',
        '',
      ].join('\n'));
      // A link that resolves to the source without naming its full path.
      writeFileSync(join(tmp, 'docs/index.md'), '# Index\n\nSee [the ADR](adr/0001-init.md).\n');
      // A citer whose content classifies private: never rewritten, never hashed
      // into the ledger.
      const secret = 'notes/secret-notes.md';
      writeFileSync(join(tmp, secret), `token sk-${'d'.repeat(24)}\n\nSee .rules.ts\n`);
      commitAll(tmp, 'add refs');
      const dry = spawnAdopt(['--dry-run', '--destructive', '--run-id', 'run-5', tmp]);
      const map = parseMap(dry.stdout);
      assert.match(map.source_commit, /^[0-9a-f]{40}$/, 'a committed fixture reads a real HEAD');
      assert.equal(itemBySource(map, secret).classification, 'private');
      const file = migrateConfirmation(tmp, map, 'run-5');
      const applied = spawnAdopt([
        '--apply', '--destructive', '--run-id', 'run-5', '--confirm', TOKEN, '--confirm-file', file, tmp,
      ]);
      assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);

      const repaired = readFileSync(join(tmp, refs), 'utf8');
      assert.ok(repaired.includes('`.ai/rules/technical-bounds.md`'), repaired);
      assert.ok(repaired.includes('[the ADR](../docs/architecture/adr/0001-init.md)'), repaired);
      assert.ok(!repaired.includes('`.rules.ts`'), repaired);
      assert.ok(!repaired.includes('docs/adr/0001-init.md'), repaired);
      assert.equal(
        readFileSync(join(tmp, 'docs/index.md'), 'utf8'),
        '# Index\n\nSee [the ADR](architecture/adr/0001-init.md).\n',
        'a link that resolves to the source is repaired without naming its full path',
      );
      assert.equal(
        readFileSync(join(tmp, 'docs/architecture/adr/0001-init.md'), 'utf8'),
        '# legacy adr\n\nThe rules lived at `.ai/rules/technical-bounds.md`.\n',
        'a migrated document carries its repaired citations to the new location',
      );
      assert.equal(
        readFileSync(join(tmp, secret), 'utf8'),
        `token sk-${'d'.repeat(24)}\n\nSee .rules.ts\n`,
        'a private citer is never rewritten',
      );

      const events = readLedger(tmp);
      const event = events.find((entry) => entry.source === '.rules.ts');
      assert.ok(event, 'the .rules.ts migration is ledgered');
      assert.ok(
        event.refs_repaired.some((entry) => entry.file === refs),
        'the .rules.ts citation repair rides its event',
      );
      // Both migrate passes repair the same citer; the last recorded after-hash
      // must equal the file's final bytes.
      const allRepairs = events.flatMap((entry) => entry.refs_repaired.filter((repair) => repair.file === refs));
      assert.ok(allRepairs.length >= 2, 'both citations are repaired and recorded');
      const last = allRepairs[allRepairs.length - 1] as RefRepair;
      assert.equal(last.after_sha256, sha256File(join(tmp, refs)));
      for (const repair of allRepairs) assert.notEqual(repair.before_sha256, repair.after_sha256);
      // Every recorded repair after-hash is the run's final bytes, so any
      // recorded hash verifies against the current file.
      for (const repair of events.flatMap((entry) => entry.refs_repaired)) {
        assert.equal(
          repair.after_sha256, sha256File(join(tmp, repair.file)),
          `${repair.file} must record its final bytes`,
        );
      }
      assert.equal(
        events.some((entry) => entry.refs_repaired.some((repair) => repair.file === secret)),
        false,
        'a private citer never enters the ledger',
      );

      // A rerun on the same commit replays: only noop events, nothing rewritten.
      const ledgerBefore = readLedger(tmp);
      const treeBefore = treeDigest(tmp, (rel) => rel === LEDGER_REL);
      const rerun = spawnAdopt([
        '--apply', '--destructive', '--run-id', 'run-5', '--confirm', TOKEN, '--confirm-file', file, tmp,
      ]);
      assert.equal(rerun.status, 0, `${rerun.stdout}\n${rerun.stderr}`);
      const added = readLedger(tmp).slice(ledgerBefore.length);
      assert.equal(added.length, ledgerBefore.filter((entry) => entry.result === 'applied').length);
      assert.deepEqual(added.map((entry) => entry.result), added.map(() => 'noop'));
      assert.equal(treeDigest(tmp, (rel) => rel === LEDGER_REL), treeBefore);

      // A new commit moves source_commit; the replay of the old map refuses.
      commitAll(tmp, 'drift');
      const stale = spawnAdopt([
        '--apply', '--destructive', '--run-id', 'run-5', '--confirm', TOKEN, '--confirm-file', file, tmp,
      ]);
      assert.equal(stale.status, 1);
      assert.equal(errorOfSafe(stale.stdout), 'source_commit_mismatch');
    } finally {
      discard(tmp);
    }
  });
});

void test('apply refuses an interrupted migration-ledger tail before writing anything', () => {
  ac7Guarded('interrupted-tail', () => {
    const tmp = stage('legacy-ai-sdlc', 'single');
    try {
      writeFileSync(join(tmp, '.rules.ts'), 'export const rules: readonly string[] = [];\n');
      const dry = spawnAdopt(['--dry-run', '--destructive', '--run-id', 'run-8', tmp]);
      const map = parseMap(dry.stdout);
      const file = migrateConfirmation(tmp, map, 'run-8');
      mkdirSync(dirname(join(tmp, LEDGER_REL)), { recursive: true });
      writeFileSync(join(tmp, LEDGER_REL), '{"schema": "knowledge-migration-event/1", "truncated', 'utf8');
      const before = treeDigest(tmp);
      const refused = spawnAdopt([
        '--apply', '--destructive', '--run-id', 'run-8', '--confirm', TOKEN, '--confirm-file', file, tmp,
      ]);
      assert.equal(refused.status, 1);
      assert.equal(errorOf(refused.stdout), 'invalid_ledger');
      assert.equal(treeDigest(tmp), before, 'an interrupted ledger refuses before any write');
      assert.equal(existsSync(join(tmp, '.ai/knowledge/migration/run-8/map.json')), false);
      assert.equal(existsSync(join(tmp, '.ai/drift/backups/run-8')), false);
    } finally {
      discard(tmp);
    }
  });
});

void test('apply refuses a malformed committed ledger line before writing anything', () => {
  ac7Guarded('malformed-ledger', () => {
    const tmp = stage('legacy-ai-sdlc', 'single');
    try {
      writeFileSync(join(tmp, '.rules.ts'), 'export const rules: readonly string[] = [];\n');
      const dry = spawnAdopt(['--dry-run', '--destructive', '--run-id', 'run-12', tmp]);
      const map = parseMap(dry.stdout);
      const file = migrateConfirmation(tmp, map, 'run-12');
      mkdirSync(dirname(join(tmp, LEDGER_REL)), { recursive: true });
      writeFileSync(join(tmp, LEDGER_REL), '{"not": "a migration event"}\n', 'utf8');
      const before = treeDigest(tmp);
      const refused = spawnAdopt([
        '--apply', '--destructive', '--run-id', 'run-12', '--confirm', TOKEN, '--confirm-file', file, tmp,
      ]);
      assert.equal(refused.status, 1);
      assert.equal(errorOf(refused.stdout), 'invalid_ledger');
      assert.equal(treeDigest(tmp), before, 'a malformed ledger refuses before any write');
      assert.equal(existsSync(join(tmp, '.ai/knowledge/migration/run-12/map.json')), false);
      assert.equal(existsSync(join(tmp, '.rules.ts')), true, 'the source is never removed');
    } finally {
      discard(tmp);
    }
  });
});

void test('apply refuses a conflicting backup before writing anything', () => {
  ac7Guarded('backup-conflict', () => {
    const tmp = stage('legacy-ai-sdlc', 'single');
    try {
      writeFileSync(join(tmp, '.rules.ts'), 'export const rules: readonly string[] = [];\n');
      const dry = spawnAdopt(['--dry-run', '--destructive', '--run-id', 'run-9', tmp]);
      const map = parseMap(dry.stdout);
      const file = migrateConfirmation(tmp, map, 'run-9');
      const backup = join(tmp, '.ai/drift/backups/run-9/.rules.ts');
      mkdirSync(dirname(backup), { recursive: true });
      writeFileSync(backup, 'different bytes\n');
      const before = treeDigest(tmp);
      const refused = spawnAdopt([
        '--apply', '--destructive', '--run-id', 'run-9', '--confirm', TOKEN, '--confirm-file', file, tmp,
      ]);
      assert.equal(refused.status, 1);
      assert.equal(errorOf(refused.stdout), 'backup_conflict');
      assert.equal(treeDigest(tmp), before, 'a conflicting backup refuses before any write');
      assert.equal(existsSync(join(tmp, '.ai/knowledge/migration/run-9/map.json')), false);
    } finally {
      discard(tmp);
    }
  });
});

void test('apply refuses a regular file occupying a destination parent path before writing anything', () => {
  ac7Guarded('blocked-parent', () => {
    const tmp = stage('legacy-agents', 'single');
    try {
      // A regular file where the first target's parent directory belongs: the
      // preflight refuses before the map, the ledger or any move.
      writeFileSync(join(tmp, 'docs/learning'), 'not a directory\n');
      const dry = spawnAdopt(['--dry-run', '--run-id', 'run-10', tmp]);
      const map = parseMap(dry.stdout);
      const first = map.items.find((item) => item.source === '.agents/skills/researcher/REFERENCE.md');
      assert.ok(first, 'the fixture carries the REFERENCE copy');
      const before = treeDigest(tmp);
      const refused = spawnAdopt(['--apply', '--run-id', 'run-10', tmp]);
      assert.equal(refused.status, 1);
      assert.equal(errorOf(refused.stdout), 'target_conflict');
      assert.equal(treeDigest(tmp), before, 'a blocked destination parent refuses before any write');
      assert.equal(existsSync(join(tmp, '.ai/knowledge/migration/run-10/map.json')), false);
      assert.equal(existsSync(join(tmp, LEDGER_REL)), false, 'no ledger is created');
      assert.ok(existsSync(join(tmp, first.source)), 'the source is kept');
    } finally {
      discard(tmp);
    }
  });
});

void test('an interrupted run records a failed event and is recovered only under a fresh run id', () => {
  ac7Guarded('failed-run', () => {
    const tmp = stage('legacy-agents', 'single');
    try {
      // The fault is injected after preflight succeeds, so the map is recorded
      // and the failure is an execution-time event rather than a permission refusal.
      const dry = spawnAdopt(['--dry-run', '--run-id', 'run-10', tmp]);
      const map = parseMap(dry.stdout);
      const first = map.items.find((item) => item.source === '.agents/skills/researcher/REFERENCE.md');
      assert.ok(first, 'the fixture carries the REFERENCE copy');
      const fault = { ...process.env, AI_CATAPULT_ADOPT_FAULT: 'execute' };

      const failedRun = spawnAdopt(['--apply', '--run-id', 'run-10', tmp], fault);
      assert.equal(failedRun.status, 1);
      const events = readLedger(tmp);
      assert.equal(events.length, 1, 'the interrupted run records exactly its failure');
      assertEventShape(events[0] as LedgerEvent);
      assert.equal(events[0]?.result, 'failed');
      assert.equal(events[0]?.source, first.source);
      assert.ok(existsSync(join(tmp, first.source)), 'the failed run kept every source');

      const rerun = spawnAdopt(['--apply', '--run-id', 'run-10', tmp]);
      assert.equal(rerun.status, 1);
      assert.equal(errorOf(rerun.stdout), 'replay_mismatch', 'a failed run is never replayed as a success');

      const recovered = spawnAdopt(['--apply', '--run-id', 'run-10b', tmp]);
      assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`);
      const after = readLedger(tmp);
      assert.equal(after.filter((event) => event.result === 'applied').length, 2, 'a fresh run id completes the run');
    } finally {
      discard(tmp);
    }
  });
});

void test('a native promotion item does not abort the apply of legacy relocations', () => {
  ac7Guarded('native-disposition', () => {
    const tmp = stage('legacy-agents', 'single');
    try {
      mkdirSync(join(tmp, '.omx/plans'), { recursive: true });
      writeFileSync(join(tmp, '.omx/plans/sample.md'), '# plan\n');
      const dry = spawnAdopt(['--dry-run', '--run-id', 'run-11', tmp]);
      const map = parseMap(dry.stdout);
      const native = map.items.find((item) => item.source === '.omx/plans/sample.md');
      assert.ok(native, 'the native plan is inventoried');
      assert.equal(native.action, 'copy');
      assert.equal(native.target, null, 'a native promotion has no relocation target');

      const applied = spawnAdopt(['--apply', '--run-id', 'run-11', tmp]);
      assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
      assert.equal(
        readLedger(tmp).some((event) => event.source === '.omx/plans/sample.md'),
        false,
        'a promotion is a publish decision, not a relocation',
      );
      assert.equal(readFileSync(join(tmp, '.omx/plans/sample.md'), 'utf8'), '# plan\n');
      assert.ok(existsSync(join(tmp, '.ai/system-prompts/researcher.md')), 'the legacy relocation still applies');
    } finally {
      discard(tmp);
    }
  });
});

void test('a replay refuses a drifted preserved target when every relocation was a noop', () => {
  ac7Guarded('all-noop-drift', () => {
    const tmp = stage('legacy-agents', 'single');
    try {
      const dry = spawnAdopt(['--dry-run', '--run-id', 'run-14', tmp]);
      const map = parseMap(dry.stdout);
      const copies = map.items.filter((item) => item.action === 'copy');
      assert.equal(copies.length, 2);
      for (const item of copies) {
        const target = item.target as string;
        mkdirSync(dirname(join(tmp, target)), { recursive: true });
        writeFileSync(join(tmp, target), `user content for ${item.source}\n`);
      }
      const applied = spawnAdopt(['--apply', '--run-id', 'run-14', tmp]);
      assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
      const events = readLedger(tmp);
      assert.equal(events.length, 2);
      assert.deepEqual(events.map((event) => event.result), ['noop', 'noop']);

      const changed = copies[0] as MapItem;
      writeFileSync(join(tmp, changed.target as string), 'the preserved target changed\n');
      const ledgerBefore = readLedger(tmp);
      const rerun = spawnAdopt(['--apply', '--run-id', 'run-14', tmp]);
      assert.equal(rerun.status, 1);
      assert.equal(errorOf(rerun.stdout), 'replay_mismatch');
      assert.equal(readLedger(tmp).length, ledgerBefore.length, 'a refused replay appends nothing');
    } finally {
      discard(tmp);
    }
  });
});

void test('a replay verifies a preserved target after-state too', () => {
  ac7Guarded('noop-drift', () => {
    const tmp = stage('legacy-agents', 'single');
    try {
      const dry = spawnAdopt(['--dry-run', '--run-id', 'run-13', tmp]);
      const map = parseMap(dry.stdout);
      const item = map.items.find((entry) => entry.action === 'copy');
      assert.ok(item, 'the fixture carries a copy item');
      const target = item.target as string;
      mkdirSync(dirname(join(tmp, target)), { recursive: true });
      writeFileSync(join(tmp, target), 'user content that is not the template\n');
      const applied = spawnAdopt(['--apply', '--run-id', 'run-13', tmp]);
      assert.equal(applied.status, 0, applied.stdout);
      const noop = readLedger(tmp).find((event) => event.source === item.source);
      assert.ok(noop);
      assert.equal(noop.result, 'noop');

      writeFileSync(join(tmp, target), 'the preserved target changed\n');
      const ledgerBefore = readLedger(tmp);
      const rerun = spawnAdopt(['--apply', '--run-id', 'run-13', tmp]);
      assert.equal(rerun.status, 1);
      assert.equal(errorOf(rerun.stdout), 'replay_mismatch');
      assert.equal(readLedger(tmp).length, ledgerBefore.length, 'a refused replay appends nothing');
    } finally {
      discard(tmp);
    }
  });
});

const CONFIRMATIONS_REL = '.ai/knowledge/migration/confirmations.jsonl';
const REFERENCE = '.agents/skills/researcher/REFERENCE.md';
const SKILL = '.agents/skills/researcher/SKILL.md';
const RELATIVE_LINKS = [
  '# reference',
  '',
  'See [skill](SKILL.md) and [usage](SKILL.md#usage).',
  '',
  '[skill]: SKILL.md',
  '',
].join('\n');

function renderedFrom(fromFile: string, toFile: string): string {
  return posix.relative(posix.dirname(fromFile), toFile);
}

function assertRelativeRepair(tmp: string, referenceTarget: string, skillTarget: string): void {
  const expected = renderedFrom(referenceTarget, skillTarget);
  const copied = readFileSync(join(tmp, referenceTarget), 'utf8');
  assert.ok(copied.includes(`[skill](${expected})`), copied);
  assert.ok(copied.includes(`[usage](${expected}#usage)`), copied);
  assert.ok(copied.includes(`[skill]: ${expected}`), copied);
  assert.equal(copied.includes('(SKILL.md)'), false, copied);
}

void test('a copied document repairs relative links from its original location', () => {
  ac7Guarded('copied-links', () => {
    const tmp = stageGitRepo('legacy-agents', 'single');
    try {
      writeFileSync(join(tmp, REFERENCE), RELATIVE_LINKS);
      commitAll(tmp, 'relative links');
      const dry = spawnAdopt(['--dry-run', '--run-id', 'run-15', tmp]);
      const map = parseMap(dry.stdout);
      const referenceItem = itemBySource(map, REFERENCE);
      const skillItem = itemBySource(map, SKILL);
      assert.equal(referenceItem.action, 'copy');
      assert.equal(skillItem.action, 'copy');
      const referenceTarget = referenceItem.target as string;
      const skillTarget = skillItem.target as string;
      const applied = spawnAdopt(['--apply', '--run-id', 'run-15', tmp]);
      assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
      assertRelativeRepair(tmp, referenceTarget, skillTarget);
      assert.equal(readFileSync(join(tmp, REFERENCE), 'utf8'), RELATIVE_LINKS, 'a copy source keeps its original links');
      assert.equal(existsSync(join(tmp, SKILL)), true);
    } finally {
      discard(tmp);
    }
  });
});

void test('a migrated document repairs relative links from its original location', () => {
  ac7Guarded('migrated-links', () => {
    const tmp = stageGitRepo('legacy-agents', 'single');
    try {
      writeFileSync(join(tmp, REFERENCE), RELATIVE_LINKS);
      commitAll(tmp, 'relative links');
      const dry = spawnAdopt(['--dry-run', '--destructive', '--run-id', 'run-16', tmp]);
      const map = parseMap(dry.stdout);
      const referenceItem = itemBySource(map, REFERENCE);
      const skillItem = itemBySource(map, SKILL);
      assert.equal(referenceItem.action, 'migrate');
      assert.equal(skillItem.action, 'migrate');
      const file = migrateConfirmation(tmp, map, 'run-16');
      const applied = spawnAdopt([
        '--apply', '--destructive', '--run-id', 'run-16', '--confirm', TOKEN, '--confirm-file', file, tmp,
      ]);
      assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
      assertRelativeRepair(tmp, referenceItem.target as string, skillItem.target as string);
      assert.equal(existsSync(join(tmp, REFERENCE)), false, 'the migrated source is removed');
      assert.equal(existsSync(join(tmp, SKILL)), false, 'the migrated sibling is removed');
    } finally {
      discard(tmp);
    }
  });
});

const NATIVE_CITERS = [
  '.omx/plans/check.md',
  '.omc/plans/check.md',
  '.omo/plans/check.md',
  '.sisyphus/plans/check.md',
];
const CITATION = 'See `.rules.ts` before the move.\n';

void test('apply does not rewrite native or pre-existing dirty paths', () => {
  ac7Guarded('protected-citers', () => {
    const tmp = stageGitRepo('legacy-ai-sdlc', 'single');
    try {
      writeFileSync(join(tmp, '.rules.ts'), 'export const rules: readonly string[] = [];\n');
      for (const rel of NATIVE_CITERS) {
        mkdirSync(dirname(join(tmp, rel)), { recursive: true });
        writeFileSync(join(tmp, rel), CITATION);
      }
      const immutable = '.ai/evidence/pin.json';
      writeFileSync(join(tmp, immutable), `${readFileSync(join(tmp, immutable), 'utf8')}\nSee .rules.ts\n`);
      const dirty = 'notes/dirty.md';
      mkdirSync(dirname(join(tmp, dirty)), { recursive: true });
      writeFileSync(join(tmp, dirty), 'clean base\n');
      commitAll(tmp, 'protected citers');
      writeFileSync(join(tmp, dirty), CITATION);
      const untracked = 'notes/untracked.md';
      writeFileSync(join(tmp, untracked), CITATION);
      const dry = spawnAdopt(['--dry-run', '--destructive', '--run-id', 'run-17', tmp]);
      const map = parseMap(dry.stdout);
      const file = migrateConfirmation(tmp, map, 'run-17');
      const applied = spawnAdopt([
        '--apply', '--destructive', '--run-id', 'run-17', '--confirm', TOKEN, '--confirm-file', file, tmp,
      ]);
      assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
      for (const rel of NATIVE_CITERS) assert.equal(readFileSync(join(tmp, rel), 'utf8'), CITATION, rel);
      assert.equal(readFileSync(join(tmp, dirty), 'utf8'), CITATION, 'a pre-existing dirty citer is not rewritten');
      assert.equal(readFileSync(join(tmp, untracked), 'utf8'), CITATION, 'a pre-existing untracked citer is not rewritten');
      assert.ok(readFileSync(join(tmp, immutable), 'utf8').includes('See .rules.ts'), 'an immutable citer is not rewritten');
      const repaired = readLedger(tmp).flatMap((event) => event.refs_repaired.map((repair) => repair.file));
      for (const rel of [...NATIVE_CITERS, dirty, untracked, immutable]) {
        assert.equal(repaired.includes(rel), false, `${rel} must not enter the ledger`);
      }
      assert.equal(existsSync(join(tmp, '.rules.ts')), false, 'the confirmed migration still applies');
    } finally {
      discard(tmp);
    }
  });
});

function stageAllNoop(runId: string): string {
  const tmp = stage('legacy-agents', 'single');
  const dry = spawnAdopt(['--dry-run', '--run-id', runId, tmp]);
  const map = parseMap(dry.stdout);
  const copies = map.items.filter((item) => item.action === 'copy' && item.target !== null);
  assert.equal(copies.length, 2);
  for (const item of copies) {
    const target = item.target as string;
    mkdirSync(dirname(join(tmp, target)), { recursive: true });
    writeFileSync(join(tmp, target), `kept ${item.source}\n`);
  }
  const applied = spawnAdopt(['--apply', '--run-id', runId, tmp]);
  assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
  assert.deepEqual(readLedger(tmp).map((event) => event.result), ['noop', 'noop']);
  return tmp;
}

void test('replay refuses an interrupted ledger tail before the all-noop return', () => {
  ac7Guarded('replay-tail', () => {
    const tmp = stageAllNoop('run-18');
    try {
      const ledger = join(tmp, LEDGER_REL);
      const tailed = `${readFileSync(ledger, 'utf8')}{"schema":"knowledge-migration-event/1"`;
      writeFileSync(ledger, tailed);
      const rerun = spawnAdopt(['--apply', '--run-id', 'run-18', tmp]);
      assert.equal(rerun.status, 1);
      assert.equal(errorOf(rerun.stdout), 'invalid_ledger');
      assert.equal(readFileSync(ledger, 'utf8'), tailed, 'a refused replay appends nothing');
    } finally {
      discard(tmp);
    }
  });
});

void test('replay refuses a contiguous foreign-schema ledger record before the all-noop return', () => {
  ac7Guarded('replay-foreign', () => {
    const tmp = stageAllNoop('run-19');
    try {
      const ledger = join(tmp, LEDGER_REL);
      const foreign = `${readFileSync(ledger, 'utf8')}${JSON.stringify({ schema: 'foreign/1', seq: 3 })}\n`;
      writeFileSync(ledger, foreign);
      const rerun = spawnAdopt(['--apply', '--run-id', 'run-19', tmp]);
      assert.equal(rerun.status, 1);
      assert.equal(errorOf(rerun.stdout), 'invalid_ledger');
      assert.equal(readFileSync(ledger, 'utf8'), foreign, 'a refused replay appends nothing');
    } finally {
      discard(tmp);
    }
  });
});

void test('replay refuses a recorded map whose replacement target does not exist', () => {
  ac7Guarded('replay-target', () => {
    const tmp = stageAllNoop('run-20');
    try {
      const mapPath = join(tmp, '.ai/knowledge/migration/run-20/map.json');
      const recorded = JSON.parse(readFileSync(mapPath, 'utf8')) as MigrationMap;
      const item = recorded.items.find((entry) => entry.action === 'copy' && entry.target !== null);
      assert.ok(item, 'the recorded map has a copy');
      item.target = 'docs/missing-replacement.md';
      writeFileSync(mapPath, `${JSON.stringify(recorded)}\n`);
      const ledgerBefore = readFileSync(join(tmp, LEDGER_REL), 'utf8');
      const rerun = spawnAdopt(['--apply', '--run-id', 'run-20', tmp]);
      assert.equal(rerun.status, 1);
      assert.equal(errorOf(rerun.stdout), 'replay_mismatch');
      assert.equal(existsSync(join(tmp, 'docs/missing-replacement.md')), false);
      assert.equal(readFileSync(join(tmp, LEDGER_REL), 'utf8'), ledgerBefore, 'a refused replay appends nothing');
    } finally {
      discard(tmp);
    }
  });
});

void test('replay refuses a malformed recorded map before the all-noop return', () => {
  ac7Guarded('replay-map', () => {
    const tmp = stageAllNoop('run-21');
    try {
      const mapPath = join(tmp, '.ai/knowledge/migration/run-21/map.json');
      const recorded = JSON.parse(readFileSync(mapPath, 'utf8')) as { items: Array<Record<string, unknown>> };
      const item = recorded.items.find((entry) => entry.action === 'copy');
      assert.ok(item, 'the recorded map has a copy');
      delete item.reason;
      writeFileSync(mapPath, `${JSON.stringify(recorded)}\n`);
      const ledgerBefore = readFileSync(join(tmp, LEDGER_REL), 'utf8');
      const rerun = spawnAdopt(['--apply', '--run-id', 'run-21', tmp]);
      assert.equal(rerun.status, 1);
      assert.equal(errorOf(rerun.stdout), 'invalid_map');
      assert.equal(readFileSync(join(tmp, LEDGER_REL), 'utf8'), ledgerBefore, 'a refused replay appends nothing');
    } finally {
      discard(tmp);
    }
  });
});

function assertMigrateRefused(label: string, ledger: string): void {
  const tmp = stage('legacy-ai-sdlc', 'single');
  try {
    writeFileSync(join(tmp, '.rules.ts'), 'export const rules: readonly string[] = [];\n');
    const dry = spawnAdopt(['--dry-run', '--destructive', '--run-id', 'run-22', tmp]);
    const map = parseMap(dry.stdout);
    const file = migrateConfirmation(tmp, map, 'run-22');
    mkdirSync(dirname(join(tmp, CONFIRMATIONS_REL)), { recursive: true });
    writeFileSync(join(tmp, CONFIRMATIONS_REL), ledger);
    const before = treeDigest(tmp);
    const refused = spawnAdopt([
      '--apply', '--destructive', '--run-id', 'run-22', '--confirm', TOKEN, '--confirm-file', file, tmp,
    ]);
    assert.equal(refused.status, 1, label);
    assert.equal(errorOf(refused.stdout), 'invalid_ledger', label);
    assert.equal(treeDigest(tmp), before, `${label}: a bad confirmation ledger refuses before any write`);
    assert.equal(existsSync(join(tmp, '.ai/knowledge/migration/run-22/map.json')), false, label);
    assert.equal(existsSync(join(tmp, '.rules.ts')), true, label);
  } finally {
    discard(tmp);
  }
}

void test('a committed empty confirmation record refuses migration before any write', () => {
  ac7Guarded('empty-confirmation', () => {
    assertMigrateRefused('empty object', '{}\n');
    assertMigrateRefused('foreign confirmation', '{"schema":"nope/1","confirmation_token":"ct-2026-10-11-009"}\n');
    assertMigrateRefused('missing required fields', '{"confirmation_token":"ct-2026-10-11-001","result":"consumed"}\n');
  });
});

void test('a schema-valid confirmation for another token still permits this migration', () => {
  ac7Guarded('other-confirmation', () => {
    const tmp = stage('legacy-ai-sdlc', 'single');
    try {
      writeFileSync(join(tmp, '.rules.ts'), 'export const rules: readonly string[] = [];\n');
      const dry = spawnAdopt(['--dry-run', '--destructive', '--run-id', 'run-23', tmp]);
      const map = parseMap(dry.stdout);
      const file = migrateConfirmation(tmp, map, 'run-23');
      mkdirSync(dirname(join(tmp, CONFIRMATIONS_REL)), { recursive: true });
      writeFileSync(join(tmp, CONFIRMATIONS_REL), `${JSON.stringify({
        at: '2026-10-11T00:00:00.000Z',
        confirmation_token: 'ct-2026-10-11-002',
        result: 'consumed',
        run_id: 'other',
        schema: 'knowledge-migration-confirmation-event/1',
        source_commit: 'uncommitted',
      })}\n`);
      const applied = spawnAdopt([
        '--apply', '--destructive', '--run-id', 'run-23', '--confirm', TOKEN, '--confirm-file', file, tmp,
      ]);
      assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
      assert.equal(existsSync(join(tmp, '.rules.ts')), false, 'a valid other-token record does not block this run');
    } finally {
      discard(tmp);
    }
  });
});

function errorOfSafe(stdout: string): string {
  const value: unknown = JSON.parse(stdout);
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'error')) return '';
  return String(value.error);
}

const GUIDE = '.agents/skills/researcher/guide.md';
const NOTES = '.agents/skills/notes/extra.md';
const STAY = 'docs/stay.md';
const LOCAL_LINKS = [
  '# reference',
  '',
  'See [asset](guide.md) and [self](REFERENCE.md#intro).',
  'Also [dot](./guide.md), [notes](../notes/extra.md) and [out](../../outside.md).',
  'Query [raw](guide.md?raw=1) and image ![fig](guide.md).',
  'Absolute [abs](/.agents/skills/researcher/guide.md) and [selfabs](/.agents/skills/researcher/REFERENCE.md#intro).',
  'Wrapped [wrap](<guide.md>) and titled [titled](guide.md "keep").',
  'Label [guide.md](guide.md) and spaced [spaced](<guide file.md>) [spacedfrag](<guide file.md#intro>).',
  'Paren title [paren](guide.md (keep)).',
  'Keep [web](https://example.com/guide.md) and [here](#intro).',
  '',
  '[asset]: guide.md',
  '[guide.md]: guide.md',
  '[spaced]: <guide file.md>',
  '[selfdef]: REFERENCE.md#intro',
  '',
].join('\n');

function assertLocalLinksRebased(text: string, referenceTarget: string): void {
  const from = posix.dirname(referenceTarget);
  const guide = posix.relative(from, GUIDE);
  const spaced = posix.relative(from, '.agents/skills/researcher/guide file.md');
  const notes = posix.relative(from, NOTES);
  const outside = posix.relative(from, '.agents/outside.md');
  const self = `${posix.relative(from, referenceTarget)}#intro`;
  assert.ok(text.includes(`[asset](${guide})`), text);
  assert.ok(text.includes(`[self](${self})`), text);
  assert.ok(text.includes(`[dot](${guide})`), text);
  assert.ok(text.includes(`[notes](${notes})`), text);
  assert.ok(text.includes(`[out](${outside})`), text);
  assert.ok(text.includes(`[raw](${guide}?raw=1)`), text);
  assert.ok(text.includes(`![fig](${guide})`), text);
  assert.ok(text.includes(`[asset]: ${guide}`), text);
  assert.ok(text.includes(`[wrap](<${guide}>)`), text);
  assert.ok(text.includes(`[titled](${guide} "keep")`), text);
  assert.ok(text.includes(`[guide.md](${guide})`), text);
  assert.ok(text.includes(`[paren](${guide} (keep))`), text);
  assert.ok(text.includes(`[guide.md]: ${guide}`), text);
  assert.ok(text.includes(`[spaced](<${spaced}>)`), text);
  assert.ok(text.includes(`[spacedfrag](<${spaced}#intro>)`), text);
  assert.ok(text.includes(`[spaced]: <${spaced}>`), text);
  assert.equal(text.includes(`[${guide}](guide.md)`), false, text);
  assert.ok(text.includes(`[selfdef]: ${self}`), text);
  assert.ok(text.includes('[abs](/.agents/skills/researcher/guide.md)'), text);
  assert.ok(text.includes('[selfabs](/docs/learning/concept-maps/researcher.md#intro)'), text);
  assert.ok(text.includes('[web](https://example.com/guide.md)'), text);
  assert.ok(text.includes('[here](#intro)'), text);
  assert.equal(text.includes('(guide.md)'), false, text);
  assert.equal(text.includes('(./guide.md)'), false, text);
  assert.equal(text.includes('(REFERENCE.md'), false, text);
  assert.equal(text.includes('(../notes/extra.md)'), false, text);
  assert.equal(text.includes('(../../outside.md)'), false, text);
}

function plantLocalLinks(tmp: string): void {
  mkdirSync(dirname(join(tmp, GUIDE)), { recursive: true });
  mkdirSync(dirname(join(tmp, NOTES)), { recursive: true });
  mkdirSync(dirname(join(tmp, STAY)), { recursive: true });
  writeFileSync(join(tmp, GUIDE), 'guide stays\n');
  writeFileSync(join(tmp, NOTES), 'notes stay\n');
  writeFileSync(join(tmp, REFERENCE), LOCAL_LINKS);
  writeFileSync(join(tmp, STAY), 'See [asset](guide.md) and `.agents/skills/researcher/REFERENCE.md`.\n');
  commitAll(tmp, 'local links');
}

void test('a relocated document rebases every local link, including unmoved destinations and self-links', () => {
  ac7Guarded('rebase-links', () => {
    const tmp = stageGitRepo('legacy-agents', 'single');
    try {
      plantLocalLinks(tmp);
      const dry = spawnAdopt(['--dry-run', '--run-id', 'run-24', tmp]);
      const map = parseMap(dry.stdout);
      const referenceItem = itemBySource(map, REFERENCE);
      assert.equal(referenceItem.action, 'copy');
      const referenceTarget = referenceItem.target as string;
      const applied = spawnAdopt(['--apply', '--run-id', 'run-24', tmp]);
      assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
      const rebased = readFileSync(join(tmp, referenceTarget), 'utf8');
      assertLocalLinksRebased(rebased, referenceTarget);
      const recorded = readLedger(tmp).flatMap((event) => event.refs_repaired)
        .find((repair) => repair.file === referenceTarget);
      assert.ok(recorded, 'the relocated document rebase is recorded');
      assert.equal(recorded.after_sha256, sha256File(join(tmp, referenceTarget)));
      const rerun = spawnAdopt(['--apply', '--run-id', 'run-24', tmp]);
      assert.equal(rerun.status, 0, `${rerun.stdout}\n${rerun.stderr}`);
      assert.equal(readFileSync(join(tmp, referenceTarget), 'utf8'), rebased, 'a rerun does not rebase again');
      assert.ok(readLedger(tmp).some((event) => event.result === 'noop'), 'a rerun appends noop events');
      assert.equal(readFileSync(join(tmp, REFERENCE), 'utf8'), LOCAL_LINKS, 'a copy source keeps its original links');
      assert.equal(readFileSync(join(tmp, GUIDE), 'utf8'), 'guide stays\n', 'an unmoved destination is not rewritten');
      assert.equal(
        readFileSync(join(tmp, STAY), 'utf8'),
        'See [asset](guide.md) and `.agents/skills/researcher/REFERENCE.md`.\n',
        'an unmoved document does not rebase links whose destination stayed',
      );
    } finally {
      discard(tmp);
    }
  });
});

void test('a migrated document rebases unmoved and self links and still retargets sibling links', () => {
  ac7Guarded('rebase-migrate', () => {
    const tmp = stageGitRepo('legacy-agents', 'single');
    try {
      plantLocalLinks(tmp);
      writeFileSync(join(tmp, REFERENCE), `${LOCAL_LINKS}See [skill](SKILL.md) and [usage](SKILL.md#usage).\n`);
      commitAll(tmp, 'migrate local links');
      const dry = spawnAdopt(['--dry-run', '--destructive', '--run-id', 'run-25', tmp]);
      const map = parseMap(dry.stdout);
      const referenceItem = itemBySource(map, REFERENCE);
      const skillItem = itemBySource(map, SKILL);
      assert.equal(referenceItem.action, 'migrate');
      const referenceTarget = referenceItem.target as string;
      const skillTarget = skillItem.target as string;
      const file = migrateConfirmation(tmp, map, 'run-25');
      const applied = spawnAdopt([
        '--apply', '--destructive', '--run-id', 'run-25', '--confirm', TOKEN, '--confirm-file', file, tmp,
      ]);
      assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
      const moved = readFileSync(join(tmp, referenceTarget), 'utf8');
      assertLocalLinksRebased(moved, referenceTarget);
      const skill = posix.relative(posix.dirname(referenceTarget), skillTarget);
      assert.ok(moved.includes(`[skill](${skill})`), moved);
      assert.ok(moved.includes(`[usage](${skill}#usage)`), moved);
      assert.equal(existsSync(join(tmp, REFERENCE)), false, 'the migrated source is removed');
      assert.equal(readFileSync(join(tmp, GUIDE), 'utf8'), 'guide stays\n');
      assert.equal(
        readFileSync(join(tmp, STAY), 'utf8'),
        'See [asset](guide.md) and `docs/learning/concept-maps/researcher.md`.\n',
        'a migrate still retargets a citation in an unmoved document',
      );
      assert.ok(readFileSync(join(tmp, STAY), 'utf8').includes('[asset](guide.md)'), 'an unmoved link is not rebased');
    } finally {
      discard(tmp);
    }
  });
});

void test('the target AC-7 guard snapshots private and managed paths', () => {
  ac7Guarded('guard-private-managed', () => {
    const tmp = stageGitRepo('legacy-agents', 'single');
    try {
      writeFileSync(join(tmp, '.env'), 'SECRET=1\n');
      mkdirSync(join(tmp, 'nested'), { recursive: true });
      writeFileSync(join(tmp, 'nested/.env'), 'SECRET=2\n');
      mkdirSync(join(tmp, 'skills/nested'), { recursive: true });
      writeFileSync(join(tmp, 'skills/nested/SKILL.md'), '# managed\n');
      writeFileSync(join(tmp, '.ai/matrix.json'), `${JSON.stringify({
        managed_repositories: [{ path: 'skills' }],
      })}\n`);
      commitAll(tmp, 'private and managed');
      const snap = preservationSnapshot(tmp);
      const rels = snap.map((item) => item.rel);
      assert.ok(rels.includes('.env'), `private path missing: ${rels.join(', ')}`);
      assert.ok(rels.includes('nested/.env'), `nested private path missing: ${rels.join(', ')}`);
      assert.ok(rels.includes('skills/nested/SKILL.md'), `managed path missing: ${rels.join(', ')}`);
      assert.equal(snap.find((item) => item.rel === '.env')?.frozen, true);
      assert.equal(snap.find((item) => item.rel === 'skills/nested/SKILL.md')?.frozen, true);
      const before = preservationSnapshot(tmp);
      mkdirSync(join(tmp, 'added'), { recursive: true });
      writeFileSync(join(tmp, 'added/.env'), 'NEW=1\n');
      writeFileSync(join(tmp, 'skills/nested/extra.md'), 'added\n');
      assert.throws(() => assertTargetPreserved(tmp, before), /AC-7/);
    } finally {
      discard(tmp);
    }
  });
});

void test('a markdown label that names a relocated path is not rewritten', () => {
  ac7Guarded('label-not-token', () => {
    const tmp = stageGitRepo('legacy-agents', 'single');
    try {
      const body = '[.agents/skills/researcher/REFERENCE.md](REFERENCE.md)\n';
      writeFileSync(join(tmp, REFERENCE), body);
      commitAll(tmp, 'label');
      const dry = spawnAdopt(['--dry-run', '--run-id', 'run-26', tmp]);
      const target = itemBySource(parseMap(dry.stdout), REFERENCE).target as string;
      const applied = spawnAdopt(['--apply', '--run-id', 'run-26', tmp]);
      assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
      const copied = readFileSync(join(tmp, target), 'utf8');
      assert.equal(copied, '[.agents/skills/researcher/REFERENCE.md](researcher.md)\n', copied);
      assert.equal(readFileSync(join(tmp, REFERENCE), 'utf8'), body, 'a copy source keeps its label');
    } finally {
      discard(tmp);
    }
  });
});

void test('a destination with balanced or escaped parentheses is rebased whole', () => {
  ac7Guarded('paren-destination', () => {
    const tmp = stageGitRepo('legacy-ai-sdlc', 'single');
    try {
      mkdirSync(join(tmp, 'docs/adr'), { recursive: true });
      writeFileSync(join(tmp, 'docs/adr/decision(v1).md'), '# decision\n');
      writeFileSync(
        join(tmp, 'docs/adr/overview.md'),
        'See [decision](decision(v1).md) and [esc](decision\\(v1\\).md).\n',
      );
      commitAll(tmp, 'paren adr');
      const dry = spawnAdopt(['--dry-run', '--destructive', '--run-id', 'run-27', tmp]);
      const map = parseMap(dry.stdout);
      const overview = itemBySource(map, 'docs/adr/overview.md');
      const decision = itemBySource(map, 'docs/adr/decision(v1).md');
      assert.equal(overview.action, 'migrate');
      assert.equal(decision.action, 'migrate');
      const file = migrateConfirmation(tmp, map, 'run-27');
      const applied = spawnAdopt([
        '--apply', '--destructive', '--run-id', 'run-27', '--confirm', TOKEN, '--confirm-file', file, tmp,
      ]);
      assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
      const moved = readFileSync(join(tmp, overview.target as string), 'utf8');
      assert.equal(moved.includes('../'), false, moved);
      assert.equal(moved.includes('docs/adr'), false, moved);
      assert.match(moved, /\[decision\]\(<?decision\(v1\)\.md>?\)/);
      assert.match(moved, /\[esc\]\(<?decision\(v1\)\.md>?\)/);
      assert.equal(existsSync(join(tmp, 'docs/adr/decision(v1).md')), false, 'the parenthesized source moved');
      assert.equal(existsSync(join(tmp, decision.target as string)), true);
    } finally {
      discard(tmp);
    }
  });
});

void test('replay refuses a corrupt confirmation ledger before returning', () => {
  ac7Guarded('replay-confirmation', () => {
    const tmp = stageAllNoop('run-28');
    try {
      const ledger = join(tmp, LEDGER_REL);
      const before = readFileSync(ledger, 'utf8');
      mkdirSync(dirname(join(tmp, CONFIRMATIONS_REL)), { recursive: true });
      writeFileSync(join(tmp, CONFIRMATIONS_REL), '{}\n');
      const empty = spawnAdopt(['--apply', '--run-id', 'run-28', tmp]);
      assert.equal(empty.status, 1);
      assert.equal(errorOf(empty.stdout), 'invalid_ledger');
      assert.equal(readFileSync(ledger, 'utf8'), before, 'a refused replay appends nothing');
      writeFileSync(join(tmp, CONFIRMATIONS_REL), '{"schema":"knowledge-migration-confirmation-event/1"');
      const tailed = spawnAdopt(['--apply', '--run-id', 'run-28', tmp]);
      assert.equal(tailed.status, 1);
      assert.equal(errorOf(tailed.stdout), 'invalid_ledger');
      assert.equal(readFileSync(ledger, 'utf8'), before, 'an interrupted confirmation tail appends nothing');
    } finally {
      discard(tmp);
    }
  });
});

void test('a preserved target is not rewritten when it cites a migrated source', () => {
  ac7Guarded('preserved-target-citer', () => {
    const tmp = stageGitRepo('legacy-agents', 'single');
    const kept = '.ai/system-prompts/researcher.md';
    const citation = 'See .agents/skills/researcher/REFERENCE.md in the preserved target.\n';
    try {
      mkdirSync(dirname(join(tmp, kept)), { recursive: true });
      writeFileSync(join(tmp, kept), citation);
      commitAll(tmp, 'preserved target');
      const dry = spawnAdopt(['--dry-run', '--destructive', '--run-id', 'run-34', tmp]);
      const map = parseMap(dry.stdout);
      assert.equal(itemBySource(map, SKILL).target, kept);
      assert.equal(itemBySource(map, REFERENCE).action, 'migrate');
      const file = migrateConfirmation(tmp, map, 'run-34');
      const applied = spawnAdopt([
        '--apply', '--destructive', '--run-id', 'run-34', '--confirm', TOKEN, '--confirm-file', file, tmp,
      ]);
      assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
      assert.equal(readFileSync(join(tmp, kept), 'utf8'), citation, 'a preserved target is not repaired');
      assert.equal(existsSync(join(tmp, REFERENCE)), false, 'the confirmed migration still applies');
    } finally {
      discard(tmp);
    }
  });
});

void test('a destination directory without search permission refuses before any write', () => {
  ac7Guarded('unsearchable-parent', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    const tmp = stage('legacy-agents', 'single');
    const parent = join(tmp, 'docs/learning/concept-maps');
    try {
      mkdirSync(parent, { recursive: true });
      chmodSync(parent, 0o666);
      const before = treeDigest(tmp);
      const refused = spawnAdopt(['--apply', '--run-id', 'run-36', tmp]);
      assert.equal(refused.status, 1);
      assert.equal(errorOf(refused.stdout), 'target_conflict');
      assert.equal(existsSync(join(tmp, '.ai/knowledge/migration/run-36/map.json')), false);
      assert.equal(treeDigest(tmp), before, 'an unsearchable destination refuses before any write');
    } finally {
      try {
        chmodSync(parent, 0o755);
      } catch {
        // The directory may not exist if staging failed.
      }
      discard(tmp);
    }
  });
});

void test('a multiline reference definition is rebased', () => {
  ac7Guarded('multiline-definition', () => {
    const tmp = stageGitRepo('legacy-agents', 'single');
    try {
      writeFileSync(join(tmp, REFERENCE), '[ref]:\n  guide.md\n');
      writeFileSync(join(tmp, GUIDE), 'guide stays\n');
      commitAll(tmp, 'multiline definition');
      const dry = spawnAdopt(['--dry-run', '--run-id', 'run-37', tmp]);
      const target = itemBySource(parseMap(dry.stdout), REFERENCE).target as string;
      const applied = spawnAdopt(['--apply', '--run-id', 'run-37', tmp]);
      assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
      const guide = posix.relative(posix.dirname(target), GUIDE);
      assert.equal(readFileSync(join(tmp, target), 'utf8'), `[ref]:\n  ${guide}\n`);
    } finally {
      discard(tmp);
    }
  });
});

void test('a newline around an inline destination is preserved and rebased', () => {
  ac7Guarded('newline-destination', () => {
    const tmp = stageGitRepo('legacy-agents', 'single');
    try {
      writeFileSync(join(tmp, REFERENCE), '[skill](\nSKILL.md\n)\n');
      commitAll(tmp, 'newline destination');
      const dry = spawnAdopt(['--dry-run', '--run-id', 'run-35', tmp]);
      const map = parseMap(dry.stdout);
      const referenceTarget = itemBySource(map, REFERENCE).target as string;
      const skillTarget = itemBySource(map, SKILL).target as string;
      const applied = spawnAdopt(['--apply', '--run-id', 'run-35', tmp]);
      assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
      const skill = posix.relative(posix.dirname(referenceTarget), skillTarget);
      const copied = readFileSync(join(tmp, referenceTarget), 'utf8');
      assert.equal(copied, `[skill](\n${skill}\n)\n`, copied);
    } finally {
      discard(tmp);
    }
  });
});

void test('escaped reference labels and spaced destinations are rebased', () => {
  ac7Guarded('escaped-label-space', () => {
    const tmp = stageGitRepo('legacy-agents', 'single');
    try {
      writeFileSync(join(tmp, REFERENCE), '[a\\]b]: guide.md\n[space]( guide.md )\n');
      writeFileSync(join(tmp, GUIDE), 'guide stays\n');
      commitAll(tmp, 'escaped and spaced');
      const dry = spawnAdopt(['--dry-run', '--run-id', 'run-33', tmp]);
      const target = itemBySource(parseMap(dry.stdout), REFERENCE).target as string;
      const applied = spawnAdopt(['--apply', '--run-id', 'run-33', tmp]);
      assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
      const guide = posix.relative(posix.dirname(target), GUIDE);
      const copied = readFileSync(join(tmp, target), 'utf8');
      assert.ok(copied.includes(`[a\\]b]: ${guide}`), copied);
      assert.ok(copied.includes(`[space]( ${guide} )`), copied);
    } finally {
      discard(tmp);
    }
  });
});

void test('reference-link identifiers are not rewritten', () => {
  ac7Guarded('reference-identifiers', () => {
    const tmp = stageGitRepo('legacy-agents', 'single');
    try {
      const body = [
        '[see][.agents/skills/researcher/REFERENCE.md]',
        '[.agents/skills/researcher/REFERENCE.md][]',
        '[.agents/skills/researcher/REFERENCE.md]',
        '',
        '[.agents/skills/researcher/REFERENCE.md]: guide.md',
        '',
      ].join('\n');
      writeFileSync(join(tmp, REFERENCE), body);
      writeFileSync(join(tmp, GUIDE), 'guide stays\n');
      commitAll(tmp, 'reference identifiers');
      const dry = spawnAdopt(['--dry-run', '--run-id', 'run-29', tmp]);
      const target = itemBySource(parseMap(dry.stdout), REFERENCE).target as string;
      const applied = spawnAdopt(['--apply', '--run-id', 'run-29', tmp]);
      assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
      const copied = readFileSync(join(tmp, target), 'utf8');
      const guide = posix.relative(posix.dirname(target), GUIDE);
      assert.ok(copied.includes('[see][.agents/skills/researcher/REFERENCE.md]'), copied);
      assert.ok(copied.includes('[.agents/skills/researcher/REFERENCE.md][]'), copied);
      assert.ok(copied.includes('[.agents/skills/researcher/REFERENCE.md]\n'), copied);
      assert.ok(copied.includes(`[.agents/skills/researcher/REFERENCE.md]: ${guide}`), copied);
      assert.equal(copied.includes('docs/learning'), false, copied);
    } finally {
      discard(tmp);
    }
  });
});

void test('a nested link label still rebases its destination', () => {
  ac7Guarded('nested-label', () => {
    const tmp = stageGitRepo('legacy-agents', 'single');
    try {
      writeFileSync(join(tmp, REFERENCE), 'See [nested [label]](guide.md) and [esc \\[x\\]](guide.md).\n');
      writeFileSync(join(tmp, GUIDE), 'guide stays\n');
      commitAll(tmp, 'nested label');
      const dry = spawnAdopt(['--dry-run', '--run-id', 'run-30', tmp]);
      const target = itemBySource(parseMap(dry.stdout), REFERENCE).target as string;
      const applied = spawnAdopt(['--apply', '--run-id', 'run-30', tmp]);
      assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
      const guide = posix.relative(posix.dirname(target), GUIDE);
      const copied = readFileSync(join(tmp, target), 'utf8');
      assert.ok(copied.includes(`[nested [label]](${guide})`), copied);
      assert.ok(copied.includes(`[esc \\[x\\]](${guide})`), copied);
    } finally {
      discard(tmp);
    }
  });
});

void test('a read-only citer that would be repaired refuses before any write', () => {
  ac7Guarded('readonly-citer', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    const tmp = stageGitRepo('legacy-agents', 'single');
    const citer = 'notes/cite.md';
    try {
      mkdirSync(dirname(join(tmp, citer)), { recursive: true });
      writeFileSync(join(tmp, citer), 'See .agents/skills/researcher/REFERENCE.md before the move.\n');
      commitAll(tmp, 'citer');
      chmodSync(join(tmp, citer), 0o444);
      const refused = spawnAdopt(['--apply', '--run-id', 'run-32', tmp]);
      assert.equal(refused.status, 1);
      assert.equal(errorOf(refused.stdout), 'target_conflict');
      assert.equal(existsSync(join(tmp, '.ai/knowledge/migration/run-32/map.json')), false);
      assert.equal(readFileSync(join(tmp, citer), 'utf8').includes('REFERENCE.md'), true);
    } finally {
      try {
        chmodSync(join(tmp, citer), 0o644);
      } catch {
        // The citer may not exist if staging failed.
      }
      discard(tmp);
    }
  });
});

void test('a read-only destination directory refuses before any write', () => {
  ac7Guarded('readonly-parent', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    const tmp = stage('legacy-agents', 'single');
    const parent = join(tmp, 'docs/learning/concept-maps');
    try {
      mkdirSync(parent, { recursive: true });
      chmodSync(parent, 0o555);
      const before = treeDigest(tmp);
      const refused = spawnAdopt(['--apply', '--run-id', 'run-31', tmp]);
      assert.equal(refused.status, 1);
      assert.equal(errorOf(refused.stdout), 'target_conflict');
      assert.equal(treeDigest(tmp), before, 'a read-only destination refuses before any write');
      assert.equal(existsSync(join(tmp, '.ai/knowledge/migration/run-31/map.json')), false);
      assert.equal(existsSync(join(tmp, LEDGER_REL)), false);
    } finally {
      try {
        chmodSync(parent, 0o755);
      } catch {
        // The directory may not exist if staging failed.
      }
      discard(tmp);
    }
  });
});

void test('the target AC-7 guard does not treat a failed dirty listing as empty', () => {
  ac7Guarded('guard-dirty-listing', () => {
    const tmp = stageGitRepo('legacy-agents', 'single');
    try {
      writeFileSync(join(tmp, 'notes-dirty.md'), 'dirty\n');
      rmSync(join(tmp, '.git/index'));
      mkdirSync(join(tmp, '.git/index'));
      assert.throws(() => preservationSnapshot(tmp), /AC-7: dirty listing failed/);
    } finally {
      discard(tmp);
    }
  });
});
