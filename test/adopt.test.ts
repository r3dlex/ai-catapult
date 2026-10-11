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
import { dirname, join } from 'node:path';
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

function spawnAdopt(args: string[]) {
  return spawnSync(process.execPath, [bin, 'adopt', ...args], { encoding: 'utf8', timeout: 30_000 });
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
  assert.match(event.after_sha256 ?? '', /^[0-9a-f]{64}$/);
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
      commitAll(tmp, 'add refs');
      const dry = spawnAdopt(['--dry-run', '--destructive', '--run-id', 'run-5', tmp]);
      const map = parseMap(dry.stdout);
      assert.match(map.source_commit, /^[0-9a-f]{40}$/, 'a committed fixture reads a real HEAD');
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

function errorOfSafe(stdout: string): string {
  const value: unknown = JSON.parse(stdout);
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'error')) return '';
  return String(value.error);
}
