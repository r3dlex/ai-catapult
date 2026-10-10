/**
 * Knowledge registry verbs (knowledge-registry/1).
 *
 * Read verbs: list, find, show, verify, rebuild [--check], serialize.
 * Write verbs: publish, archive, retire, unlock.
 * Exit 0 ok, 1 contract violation (an error token), 2 usage or unavailable.
 *
 * This is the packaged JS mirror of the umbrella reference implementation
 * (r3dlex/ai-tool-workspace): the read half mirrors scripts/knowledge/registry.py
 * (goal XSKP-P4-02), the write half mirrors scripts/knowledge/publish.py and its
 * classify.py (goal XSKP-P4-03). Read verbs never write an entry: the entry
 * files are the source of truth and rebuild only ever writes the derived
 * aggregate.
 *
 * The frozen contract pack lives at .ai/knowledge/contract in the package
 * itself (package.json files) — schemas resolve relative to this module, the
 * same way registry.py resolves them from its own repository. Write verbs first
 * verify that pack against its pinned contract.lock.json, as publish.py's
 * load_policy() does, so a mutated policy fails closed (D4).
 *
 * Write-half divergences from publish.py, each forced by the runtime or the
 * package layout:
 * - Locking. A per-entry lock is an atomic mkdirSync of
 *   .ai/knowledge/.locks/<entry file>.lock, as the contract specifies.
 *   publish.py also serializes writers of every identity under a repository
 *   flock. Node has no flock, so writers serialize on the entry locks
 *   themselves: take your own, then proceed only if no other writer lock of
 *   this repository exists (see withEntryLock). Contention fails at once with
 *   `locked`. Unlike a flock, nothing is released when a writer is killed: its
 *   entry lock stays, verify reports it as stale_lock, every writer fails
 *   `locked` naming it, and only `unlock <id> --confirm-no-writer` removes it
 *   (claimed by an atomic rename and re-validated first, ledgered). Nothing
 *   removes a lock automatically.
 * - Ledgers. A record is committed by its trailing newline, written whole or
 *   not at all (short writes retried; a failure truncates the uncommitted
 *   bytes before any caller acts). publish.py's ledger_lines fails on any
 *   damaged line; here an interrupted tail is repaired by the next append on
 *   its own line (fragment + knowledge-ledger-repair/1 record, committed by
 *   one newline, so recovery is restartable at every byte), and unlock never
 *   reads the lock-event ledger, so no damaged audit line blocks recovery.
 * - Secret patterns. JavaScript has no leading inline-flag group and Node
 *   rejects the policy's `(?i)`, so compileSecretPattern turns it into the i
 *   flag. Every pattern compiles with u, for Python's code-point semantics.
 * - The pack check expects contract.lock.json inside the copy: this
 *   repository ships the lock in the copy (XSKP-P4-01) and pins the lock's own
 *   sha256 here.
 * - Errors are {error, detail} JSON on stdout, like the read half, not
 *   publish.py's `error: detail` on stderr; the exit codes are the same. Any
 *   other failure under a write verb maps to invalid_publication, as
 *   publish.py main() maps OSError/ValueError/KeyError/TypeError.
 * - Timestamps are ECMAScript ISO strings (…Z), not datetime.isoformat()
 *   (…+00:00); the entry schema accepts both.
 */
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join, posix, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA = 'knowledge-registry/1';
export const ENTRIES_DIR = '.ai/knowledge/entries';
export const REGISTRY_FILE = '.ai/knowledge/registry.json';
export const LOCKS_DIR = '.ai/knowledge/.locks';
// Atomic mkdir locks use this owner metadata convention; future writers share it.
export const LOCK_OWNER_FILE = 'owner.json';
// The frozen pack and its docs twin are contract fixtures, never documents.
export const FIXTURE_PREFIXES = [
  '.ai/knowledge/contract',
  'docs/specifications/ACTIVE/cross-surface-knowledge-publication.contract',
];
export const OK = 0;
export const FAILED = 1;
export const USAGE = 2;
// The contract's own knowledge_id pattern; a caller-supplied id is untrusted input.
export const KNOWLEDGE_ID =
  /^[a-z0-9][a-z0-9-]*:(adr|brd|doc|handoff|learning|plan|prd|research|review|spec|test-spec):[a-z0-9][a-z0-9.-]*$/;

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CONTRACT_DIR = join(__dirname, '..', '.ai/knowledge/contract');

export class KnowledgeError extends Error {
  constructor(error, detail) {
    super(detail);
    this.name = 'KnowledgeError';
    this.error = error;
    this.detail = detail ?? '';
  }
}

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------

/**
 * Compare strings by Unicode code point. JavaScript's default string compare
 * orders by UTF-16 code units, which sorts the U+D83D surrogate of an astral
 * character before U+FF5A — the exact bug fixtures/vectors pins.
 */
export function compareCodePoints(a, b) {
  const left = Array.from(a);
  const right = Array.from(b);
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i += 1) {
    const ca = left[i].codePointAt(0);
    const cb = right[i].codePointAt(0);
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  if (left.length === right.length) return 0;
  return left.length < right.length ? -1 : 1;
}

function dumpJson(value, indent) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string') return JSON.stringify(value);
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new KnowledgeError('malformed_entry', 'non-finite number cannot be serialized to the contract');
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const pad = ' '.repeat(indent + 2);
    return `[\n${value.map((item) => pad + dumpJson(item, indent + 2)).join(',\n')}\n${' '.repeat(indent)}]`;
  }
  if (type === 'object') {
    if (shouldPreserveUndefined(value)) {
      throw new KnowledgeError('malformed_entry', 'value contains undefined and cannot be serialized to the contract');
    }
    const keys = Object.keys(value).sort(compareCodePoints);
    if (keys.length === 0) return '{}';
    const pad = ' '.repeat(indent + 2);
    return `{\n${keys
      .map((key) => `${pad}${JSON.stringify(key)}: ${dumpJson(value[key], indent + 2)}`)
      .join(',\n')}\n${' '.repeat(indent)}}`;
  }
  throw new KnowledgeError('malformed_entry', 'value cannot be serialized to the contract');
}

function shouldPreserveUndefined(value) {
  return Object.keys(value).some((key) => value[key] === undefined);
}

/**
 * The one serialization every reader and writer must agree on.
 *
 * Key order is Unicode code point (Python sort_keys), so U+FF5A sorts before
 * U+1F600. Non-ASCII is written literally (ensure_ascii=False); indent=2 with
 * a trailing newline.
 */
export function canonical(value) {
  return dumpJson(value, 0) + '\n';
}

/** Write canonical bytes of a report to stdout. */
export function emit(value) {
  process.stdout.write(canonical(value));
}

// ---------------------------------------------------------------------------
// Paths and digests
// ---------------------------------------------------------------------------

function digest(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * None/undefined when the path is a plain in-repo file, else why it cannot be
 * trusted. Mirrors registry.py unsafe_reason.
 */
export function unsafeReason(root, relative) {
  if (typeof relative !== 'string' || relative === '' || relative.includes('\0') || relative.startsWith('/')) {
    return 'absolute_or_empty';
  }
  const parts = relative.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    return 'traversal';
  }
  // A symlink anywhere in the chain can redirect the read outside the root,
  // so the chain is walked rather than only the final component.
  let walked = root;
  for (const part of parts) {
    walked = join(walked, part);
    try {
      if (lstatSync(walked).isSymbolicLink()) return 'symlink_component';
    } catch {
      // A missing component cannot be a symlink (Python is_symlink() is False).
    }
  }
  // Path.resolve() analog: follow symlinks that exist, normalize the rest.
  let resolved;
  try {
    resolved = realpathSync(join(root, relative));
  } catch {
    resolved = resolvePath(join(root, relative));
  }
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    return 'escapes_root';
  }
  return null;
}

/** Throw unsafe_path when the relative path cannot be trusted. */
export function safePath(root, relative) {
  const reason = unsafeReason(root, relative);
  if (reason) throw new KnowledgeError('unsafe_path', `${relative}: ${reason}`);
  return join(root, relative);
}

export function entryFile(root, knowledgeId) {
  return join(root, ENTRIES_DIR, `${knowledgeId.replace(/:/g, '__')}.json`);
}

function sameValue(left, right) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftArray = Array.isArray(left);
  const rightArray = Array.isArray(right);
  if (leftArray !== rightArray) return false;
  if (leftArray) {
    return left.length === right.length && left.every((item, i) => sameValue(item, right[i]));
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && sameValue(left[key], right[key]));
}

// ---------------------------------------------------------------------------
// Loading and validation
// ---------------------------------------------------------------------------

function loadSchema(name) {
  return JSON.parse(readFileSync(join(CONTRACT_DIR, name), 'utf8'));
}

/** Read only plain registry files; malformed input is never a placeholder. */
export function loadEntries(root) {
  const base = safePath(root, ENTRIES_DIR);
  if (!existsSync(base)) return [];
  if (!statSync(base).isDirectory()) throw new KnowledgeError('invalid_entries_directory', base);
  const found = [];
  for (const name of readdirSync(base).filter((file) => file.endsWith('.json')).sort(compareCodePoints)) {
    safePath(root, `${ENTRIES_DIR}/${name}`);
    const path = join(base, name);
    let entry;
    try {
      entry = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new KnowledgeError('malformed_entry', String(error.message ?? error));
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new KnowledgeError('malformed_entry', path);
    }
    found.push({ rel: `${ENTRIES_DIR}/${name}`, name, entry });
  }
  return found;
}

/**
 * Validate the finite structural keywords used by the frozen entry schema.
 *
 * Descriptions, titles and schema identifiers are annotations, not constraints.
 * This is deliberately not a general-purpose JSON Schema implementation.
 * (Mirrors registry.py schema_errors.)
 */
export function schemaErrors(value, schema, location = 'entry') {
  if (Object.prototype.hasOwnProperty.call(schema, 'oneOf')) {
    const matches = schema.oneOf
      .reduce((count, option) => count + (schemaErrors(value, option, location).length === 0 ? 1 : 0), 0);
    return matches === 1 ? [] : [`${location}: oneOf`];
  }
  const kind = schema.type;
  const matchesType = (v) => {
    switch (kind) {
      case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
      case 'array': return Array.isArray(v);
      case 'string': return typeof v === 'string';
      case 'boolean': return typeof v === 'boolean';
      case 'integer': return typeof v === 'number' && Number.isInteger(v);
      case 'null': return v === null;
      default: return true; // no type keyword constrains nothing
    }
  };
  if (kind && !matchesType(value)) return [`${location}: expected ${kind}`];
  const errors = [];
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !sameValue(value, schema.const)) {
    errors.push(`${location}: const`);
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'enum') && !schema.enum.some((option) => sameValue(value, option))) {
    errors.push(`${location}: enum`);
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${location}.${key}: required`);
    }
    for (const key of Object.keys(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        errors.push(...schemaErrors(value[key], properties[key], `${location}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${location}.${key}: unexpected`);
      }
    }
  }
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0)) errors.push(`${location}: minItems`);
    const items = schema.items ?? {};
    for (let i = 0; i < value.length; i += 1) {
      errors.push(...schemaErrors(value[i], items, `${location}[${i}]`));
    }
  }
  if (typeof value === 'string') {
    if (value.length < (schema.minLength ?? 0)) errors.push(`${location}: minLength`);
    if (Object.prototype.hasOwnProperty.call(schema, 'pattern')) {
      let pattern;
      try {
        pattern = new RegExp(schema.pattern);
      } catch (error) {
        throw new KnowledgeError('malformed_entry', `schema pattern does not compile: ${schema.pattern}`);
      }
      if (!pattern.test(value)) errors.push(`${location}: pattern`);
    }
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    if (Object.prototype.hasOwnProperty.call(schema, 'minimum') && value < schema.minimum) {
      errors.push(`${location}: minimum`);
    }
  }
  return errors;
}

/** Validation errors of the given entries against entry + canonical reality. */
export function entryErrors(root, entries) {
  const schema = loadSchema('knowledge-entry.schema.json');
  const errors = [];
  const seen = new Set();
  for (const { name, rel, entry } of entries) {
    const identity = entry.knowledge_id;
    const canonicalInfo = entry.canonical;
    if (canonicalInfo !== null && typeof canonicalInfo === 'object'
      && Object.prototype.hasOwnProperty.call(canonicalInfo, 'path')) {
      const reason = unsafeReason(root, canonicalInfo.path);
      if (reason) {
        errors.push({ entry: name, error: 'unsafe_path', detail: reason });
        continue;
      }
    }
    const problems = schemaErrors(entry, schema);
    if (typeof identity === 'string') {
      if (seen.has(identity)) problems.push('duplicate knowledge_id');
      seen.add(identity);
    }
    if (problems.length) {
      errors.push({ entry: name, error: 'invalid_entry', detail: problems.join('; ') });
      continue;
    }
    const revisions = entry.revisions;
    if (identity !== `${entry.repo_id}:${entry.kind}:${identity.split(':').at(-1)}`) {
      problems.push('knowledge_id disagrees with repo_id/kind');
    }
    if (join(root, rel) !== entryFile(root, identity)) {
      problems.push('entry filename disagrees with knowledge_id');
    }
    if (revisions.some((revision, index) => revision.rev !== index + 1)) {
      problems.push('revisions must be contiguous from 1');
    }
    if ((entry.lifecycle === 'retired') !== (entry.tombstone !== null)) {
      problems.push('tombstone must exist iff retired');
    }
    if (entry.tombstone && entry.tombstone.last_sha256 !== revisions.at(-1).sha256) {
      problems.push('tombstone digest disagrees with latest revision');
    }
    if (entry.canonical.immutable && entry.canonical.frontmatter_id) {
      problems.push('immutable canonical cannot have frontmatter_id');
    }
    if (problems.length) {
      errors.push({ entry: identity, error: 'invalid_entry', detail: problems.join('; ') });
      continue;
    }
    const relative = entry.canonical.path;
    const reason = unsafeReason(root, relative);
    if (reason) {
      errors.push({ entry: identity, error: 'unsafe_path', detail: reason });
    } else if (!existsSync(join(root, relative)) || !statSync(join(root, relative)).isFile()) {
      if (entry.tombstone === null) {
        errors.push({ entry: identity, error: 'missing_without_tombstone', detail: relative });
      }
    } else if (digest(join(root, relative)) !== revisions.at(-1).sha256) {
      errors.push({ entry: identity, error: 'hash_mismatch', detail: relative });
    }
  }
  return errors;
}

function aggregateItem(rel, entry) {
  const revisions = entry.revisions ?? [];
  const latest = revisions.length ? revisions.at(-1) : {};
  const canonicalInfo = entry.canonical ?? {};
  const origin = entry.origin ?? {};
  return {
    entry: rel,
    kind: entry.kind ?? null,
    knowledge_id: entry.knowledge_id ?? null,
    lifecycle: entry.lifecycle ?? null,
    path: canonicalInfo.path ?? null,
    rev: latest.rev ?? null,
    sha256: latest.sha256 ?? null,
    surface: origin.surface ?? null,
    title: entry.title ?? null,
  };
}

function repoIdOf(entries) {
  for (const { entry } of entries) {
    if (entry.repo_id) return entry.repo_id;
  }
  return '';
}

export function aggregatePayload(root, entries) {
  const items = entries
    .map((item) => aggregateItem(item.rel, item.entry))
    .sort((left, right) => compareCodePoints(String(left.knowledge_id ?? ''), String(right.knowledge_id ?? '')));
  return canonical({
    entries: items,
    generated_from: ENTRIES_DIR,
    repo_id: repoIdOf(entries),
    schema: SCHEMA,
  });
}

function loadAggregate(root) {
  const target = safePath(root, REGISTRY_FILE);
  let aggregate;
  try {
    aggregate = JSON.parse(readFileSync(target, 'utf8'));
  } catch (error) {
    throw new KnowledgeError('invalid_aggregate', String(error.message ?? error));
  }
  const schema = loadSchema('knowledge-registry.schema.json');
  const errors = schemaErrors(aggregate, schema, 'aggregate');
  if (errors.length) throw new KnowledgeError('invalid_aggregate', errors.join('; '));
  return aggregate.entries;
}

function federatedRegistry(root) {
  const entries = loadAggregate(root);
  for (const entry of entries) {
    safePath(root, entry.entry);
    safePath(root, entry.path);
  }
  return entries;
}

/** Read only explicitly managed registries; never initialize a child. */
function federatedEntries(root) {
  const matrixPath = safePath(root, '.ai/matrix.json');
  let matrix;
  try {
    matrix = JSON.parse(readFileSync(matrixPath, 'utf8'));
  } catch (error) {
    throw new KnowledgeError('invalid_matrix', String(error.message ?? error));
  }
  if (matrix === null || typeof matrix !== 'object' || Array.isArray(matrix)
    || !Array.isArray(matrix.managed_repositories)) {
    throw new KnowledgeError('invalid_matrix', 'managed_repositories must be an array');
  }
  const paths = [];
  for (const repository of matrix.managed_repositories) {
    if (repository === null || typeof repository !== 'object' || Array.isArray(repository)
      || typeof repository.path !== 'string') {
      throw new KnowledgeError('invalid_matrix', 'managed repository requires a string path');
    }
    const relative = repository.path;
    if (paths.includes(relative)) {
      throw new KnowledgeError('invalid_matrix', `duplicate managed path: ${relative}`);
    }
    paths.push(relative);
  }
  const entries = federatedRegistry(root);
  const repositories = [];
  for (const relative of paths) {
    const child = safePath(root, relative);
    if (existsSync(child) && !statSync(child).isDirectory()) {
      throw new KnowledgeError('invalid_child', relative);
    }
    const target = safePath(root, `${relative}/${REGISTRY_FILE}`);
    const present = existsSync(target);
    repositories.push({ path: relative, status: present ? 'present' : 'absent' });
    if (present) entries.push(...federatedRegistry(child));
  }
  return { entries, repositories };
}

function pidAlive(pid) {
  // POSIX pid_t is signed; reject bools, non-positive and oversized input before kill.
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid > 2 ** 31 - 1) {
    return null;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

function cmdList(root, args) {
  const { entries, repositories } = args.federated
    ? federatedEntries(root)
    : { entries: loadAggregate(root), repositories: null };
  const report = {
    entries: entries.filter((entry) => ['kind', 'surface', 'lifecycle']
      .every((key) => args[key] === undefined || args[key] === entry[key])),
    skipped: FIXTURE_PREFIXES
      .filter((prefix) => existsSync(join(root, prefix)))
      .map((prefix) => ({ path: prefix, reason: 'contract-fixture' })),
  };
  if (repositories !== null) report.repositories = repositories;
  emit(report);
  return OK;
}

function cmdFind(root, args) {
  const needle = args.query.toLowerCase();
  const { entries, repositories } = args.federated
    ? federatedEntries(root)
    : { entries: loadAggregate(root), repositories: null };
  const hits = entries.filter((entry) => `${entry.knowledge_id} ${entry.title} ${entry.path}`
    .toLowerCase()
    .includes(needle));
  const report = { entries: hits, query: args.query };
  if (repositories !== null) report.repositories = repositories;
  emit(report);
  return OK;
}

function cmdShow(root, args) {
  if (!KNOWLEDGE_ID.test(args.knowledgeId)) {
    emit({ error: 'unsafe_path', detail: 'knowledge_id fails the contract pattern' });
    return USAGE;
  }
  safePath(root, `${ENTRIES_DIR}/${args.knowledgeId.replace(/:/g, '__')}.json`);
  const entries = loadEntries(root);
  const selected = entries.filter((item) => join(root, item.rel) === entryFile(root, args.knowledgeId));
  if (!selected.length) {
    emit({ error: 'unknown_entry', knowledge_id: args.knowledgeId });
    return FAILED;
  }
  const errors = entryErrors(root, selected);
  if (errors.length) {
    emit({ errors });
    return FAILED;
  }
  emit(selected[0].entry);
  return OK;
}

function cmdVerify(root) {
  const entries = loadEntries(root);
  const errors = entryErrors(root, entries);
  const warnings = [];
  const target = safePath(root, REGISTRY_FILE);
  if (!errors.length) {
    const current = existsSync(target) && statSync(target).isFile() ? readFileSync(target, 'utf8') : null;
    if (current === null || current !== aggregatePayload(root, entries)) {
      errors.push({ error: 'aggregate_stale', path: REGISTRY_FILE });
    }
  }

  const locks = safePath(root, LOCKS_DIR);
  if (existsSync(locks) && statSync(locks).isDirectory()) {
    for (const name of readdirSync(locks).filter((file) => file.endsWith('.lock')).sort(compareCodePoints)) {
      const lockRel = `${LOCKS_DIR}/${name}`;
      const lock = join(root, lockRel);
      safePath(root, lockRel);
      const isDir = statSync(lock).isDirectory();
      const ownerRel = isDir ? `${lockRel}/${LOCK_OWNER_FILE}` : lockRel;
      safePath(root, ownerRel);
      const owner = join(root, ownerRel);
      let info = {};
      try {
        info = JSON.parse(readFileSync(owner, 'utf8'));
      } catch {
        info = {};
      }
      const pid = info !== null && typeof info === 'object' && !Array.isArray(info)
        ? (info.pid === undefined ? null : info.pid)
        : null;
      // Unknown ownership is not proof of a stale lock. Never remove locks.
      const alive = pidAlive(pid);
      if (alive !== true) {
        warnings.push({
          lock: lockRel,
          warning: alive === false ? 'stale_lock' : 'lock_state_unknown',
          pid,
        });
      }
    }
  }

  emit({
    ok: errors.length === 0,
    checked: entries.length,
    errors,
    warnings,
  });
  return errors.length ? FAILED : OK;
}

function cmdRebuild(root, args) {
  const entries = loadEntries(root);
  const errors = entryErrors(root, entries);
  if (errors.length) {
    emit({ errors });
    return FAILED;
  }
  const payload = aggregatePayload(root, entries);
  const target = safePath(root, REGISTRY_FILE);

  if (args.check) {
    const current = existsSync(target) && statSync(target).isFile() ? readFileSync(target, 'utf8') : null;
    if (current !== payload) {
      emit({ error: 'aggregate_stale', path: REGISTRY_FILE });
      return FAILED;
    }
    return OK;
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, payload, 'utf8');
  emit({ rebuilt: REGISTRY_FILE, entries: entries.length });
  return OK;
}

function cmdSerialize(root, args) {
  // Component-wise trust check BEFORE any resolution: resolvePath/realpath
  // normalize away traversal segments and happily follow an in-root symlink
  // that can redirect the read (resolve-first was round-1 review finding F1).
  // unsafeReason is the same component-wise rule verify enforces (C05/C06);
  // registry.py's resolve-first ordering stays a known reference divergence.
  safePath(root, args.source);
  const source = join(root, args.source);
  if (!existsSync(source) || !statSync(source).isFile()) {
    emit({ error: 'source_unavailable', path: String(source) });
    return USAGE;
  }
  emit(JSON.parse(readFileSync(source, 'utf8')));
  return OK;
}

// ---------------------------------------------------------------------------
// Write half: contract pin, policy and classification (publish.py, classify.py)
// ---------------------------------------------------------------------------

// sha256 of the frozen contract.lock.json: the lock cannot pin itself.
export const CONTRACT_LOCK_SHA256 = '9f5d7edfc17554c383b06aa4726dfffe564ecc8d657b16baa89ce72098d5e102';
export const PROFILE_FILE = '.ai/init/repo-profile.json';
export const LOCK_EVENTS = '.ai/knowledge/lock-events.jsonl';
export const MIGRATION_LEDGER = '.ai/knowledge/migration/ledger.jsonl';
export const CONFIRMATIONS = '.ai/knowledge/migration/confirmations.jsonl';
// Operator-supplied archive run manifest (publish.py reads the same variable).
export const ARCHIVE_MANIFEST_ENV = 'AI_KNOWLEDGE_ARCHIVE_MANIFEST';
const CONTRACT_LOCK_FILE = 'contract.lock.json';
const CONTRACT_TWIN = FIXTURE_PREFIXES[1];
const NATIVE_ROOTS = ['.omc', '.omx', '.omo', '.sisyphus'];
const NATIVE_CLASSES = ['native', 'native-legacy', 'workspace-convention'];
const FORMATS = { '.md': 'markdown', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml' };
const WRITE_VERBS = ['publish', 'archive', 'retire', 'unlock'];
// Python bytes.decode('utf-8'): strict, and a BOM is content, not stripped.
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function now() {
  return new Date().toISOString();
}

function packFiles(directory, prefix = '') {
  const found = [];
  for (const item of readdirSync(join(directory, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) found.push(...packFiles(directory, rel));
    else if (item.isFile()) found.push(rel);
    else throw new KnowledgeError('contract_mismatch', `${rel}: not a regular file`);
  }
  return found;
}

/** Fail closed unless the shipped pack is byte-identical to its pinned lock (D4). */
export function verifyContract(directory = CONTRACT_DIR) {
  try {
    const lockBytes = readFileSync(join(directory, CONTRACT_LOCK_FILE));
    if (sha256(lockBytes) !== CONTRACT_LOCK_SHA256) throw new KnowledgeError('contract_mismatch', 'lock fingerprint');
    const files = JSON.parse(lockBytes.toString('utf8')).files;
    const expected = [...Object.keys(files), CONTRACT_LOCK_FILE].sort(compareCodePoints);
    if (!sameValue(packFiles(directory).sort(compareCodePoints), expected)) {
      throw new KnowledgeError('contract_mismatch', 'pack file inventory');
    }
    for (const [rel, want] of Object.entries(files)) {
      if (digest(join(directory, rel)) !== want) throw new KnowledgeError('contract_mismatch', rel);
    }
  } catch (error) {
    if (error instanceof KnowledgeError) throw error;
    throw new KnowledgeError('contract_mismatch', String(error.message ?? error));
  }
}

function loadPolicy() {
  verifyContract();
  return JSON.parse(readFileSync(join(CONTRACT_DIR, 'publication-policy.json'), 'utf8'));
}

/** Policy glob: `*` stays inside one path component; `**\/` spans zero or more directories. */
export function policyMatches(path, pattern) {
  let expression = '';
  let index = 0;
  while (index < pattern.length) {
    if (pattern.startsWith('**/', index)) {
      expression += '(?:.*/)?';
      index += 3;
    } else if (pattern.startsWith('**', index)) {
      expression += '.*';
      index += 2;
    } else if (pattern[index] === '*') {
      expression += '[^/]*';
      index += 1;
    } else {
      expression += pattern[index].replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
      index += 1;
    }
  }
  return new RegExp(`^(?:${expression})$`, 's').test(path);
}

/** classify.py safe_path: the read half's component-wise rule, plus no backslash. */
function writerPath(root, relative) {
  if (typeof relative === 'string' && relative.includes('\\')) {
    throw new KnowledgeError('unsafe_path', `${relative}: backslash`);
  }
  return safePath(root, relative);
}

/** Path-only classification: never reads content. First matching native rule wins. */
export function classify(root, relative, policy) {
  writerPath(root, relative);
  if (policy.deny.paths.some((pattern) => policyMatches(relative, pattern))) return { classification: 'private' };
  if (policy.unsupported_formats.some((pattern) => policyMatches(posix.basename(relative), pattern))) {
    return { classification: 'unsupported' };
  }
  for (const { glob, ...rule } of policy.native_rules) {
    if (policyMatches(relative, glob)) return rule;
  }
  return { classification: 'workspace' };
}

/**
 * Compile one policy secret pattern. Python accepts a leading global inline
 * flag group; JavaScript has none and Node rejects `(?i)` as an invalid group,
 * so it becomes the i flag. Any other inline flag fails closed.
 */
export function compileSecretPattern(pattern) {
  const inline = /^\(\?([a-zA-Z]+)\)/.exec(pattern);
  if (!inline) return new RegExp(pattern, 'u');
  if (inline[1] !== 'i') throw new KnowledgeError('contract_mismatch', `unsupported inline flags: ${inline[0]}`);
  return new RegExp(pattern.slice(inline[0].length), 'iu');
}

function scanSecrets(text, policy) {
  return policy.deny.secret_patterns.some((pattern) => compileSecretPattern(pattern).test(text));
}

// ---------------------------------------------------------------------------
// Write half: frontmatter merge (D9)
// ---------------------------------------------------------------------------

const ASCII_SPACE = ' \t\n\r\x0b\x0c';
const SCALAR_LINE = /^(?:[A-Za-z_][A-Za-z0-9_-]*|'[A-Za-z_][A-Za-z0-9_-]*'|"[A-Za-z_][A-Za-z0-9_-]*")[ \t]*:(?:[ \t]+(.*))?$/s;
const QUOTED_SCALAR = /^(?:'[^']*'(?:[ \t]+#.*)?|"[^"\\]*"(?:[ \t]+#.*)?)$/s;
const IDENTITY_LINE = /^(?:knowledge_id|'knowledge_id'|"knowledge_id")[ \t\n\r\f\v]*:[ \t\n\r\f\v]*(.*?)[ \t\n\r\f\v]*$/s;

/** Python bytes.strip()/lstrip(): ASCII whitespace only. */
function asciiStrip(text, right = true) {
  let start = 0;
  let end = text.length;
  while (start < end && ASCII_SPACE.includes(text[start])) start += 1;
  while (right && end > start && ASCII_SPACE.includes(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

/** Python bytes.splitlines(): \r\n, \r and \n end a line; terminators dropped. */
function splitLines(text) {
  if (text === '') return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (/[\r\n]$/.test(text)) lines.pop();
  return lines;
}

/**
 * The first Markdown frontmatter block as {end, identity}: the closing line's
 * index and the knowledge_id it declares, or nulls without a block. Only flat,
 * simple mappings are understood; general YAML is refused, never rewritten.
 */
function frontmatter(content) {
  const lines = splitLines(UTF8.decode(content));
  if (!lines.length || lines[0] !== '---') return { end: null, identity: null };
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] !== '---' && lines[index] !== '...') continue;
    const identities = [];
    for (const item of lines.slice(1, index)) {
      if (!asciiStrip(item) || asciiStrip(item, false).startsWith('#')) continue;
      const scalar = SCALAR_LINE.exec(item);
      if (!scalar) throw new KnowledgeError('invalid_frontmatter', 'unsupported mapping syntax');
      const value = asciiStrip(scalar[1] ?? '');
      if (value && '{[&*!>|%@`'.includes(value[0])) {
        throw new KnowledgeError('invalid_frontmatter', 'unsupported scalar syntax');
      }
      if ((value.startsWith("'") || value.startsWith('"')) && !QUOTED_SCALAR.test(value)) {
        throw new KnowledgeError('invalid_frontmatter', 'unsupported quoted scalar');
      }
      const match = IDENTITY_LINE.exec(item);
      if (!match) continue;
      let identity = match[1].trim();
      if (identity.startsWith('"') || identity.startsWith("'")) {
        const end = identity.indexOf(identity[0], 1);
        const rest = end < 0 ? '' : identity.slice(end + 1);
        if (end < 0 || (rest.trim() && !rest.trimStart().startsWith('#'))) {
          throw new KnowledgeError('invalid_frontmatter', 'unsupported identity scalar');
        }
        identity = identity.slice(1, end);
      } else {
        identity = identity.split(' #')[0].trim();
      }
      identities.push(identity);
    }
    if (identities.length > 1) throw new KnowledgeError('invalid_frontmatter', 'duplicate knowledge_id');
    return { end: index, identity: identities[0] ?? null };
  }
  throw new KnowledgeError('invalid_frontmatter', 'unterminated first block');
}

/** Merge `knowledge_id:` into the first block; every other byte is kept. */
function addFrontmatter(content, identity) {
  const { end, identity: existing } = frontmatter(content);
  if (existing !== null) {
    if (existing !== identity) throw new KnowledgeError('id_conflict', 'frontmatter identity differs');
    return content;
  }
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const key = Buffer.from(`knowledge_id: ${identity}${newline}`, 'utf8');
  if (end === null) return Buffer.concat([Buffer.from(`---${newline}`), key, Buffer.from(`---${newline}`), content]);
  const firstEnd = content.indexOf('\n') + 1;
  if (firstEnd === 0) throw new Error('frontmatter opening line has no line feed');
  return Buffer.concat([content.subarray(0, firstEnd), key, content.subarray(firstEnd)]);
}

// ---------------------------------------------------------------------------
// Write half: entries, destinations, locks and ledgers
// ---------------------------------------------------------------------------

function validateEntry(entry, schema) {
  if (schemaErrors(entry, schema).length) throw new KnowledgeError('invalid_entry', 'entry fails frozen schema');
  const [repoId, kind] = entry.knowledge_id.split(':');
  if (repoId !== entry.repo_id || kind !== entry.kind
    || entry.revisions.some((revision, index) => revision.rev !== index + 1)
    || (entry.lifecycle === 'retired') !== (entry.tombstone !== null)
    || (entry.canonical.immutable && entry.canonical.frontmatter_id)) {
    throw new KnowledgeError('invalid_entry', 'entry identity, revisions or lifecycle inconsistent');
  }
}

/** Metadata only: a benign spelling may alias denied or native content. */
function rejectHardlink(path) {
  if (existsSync(path) && lstatSync(path).nlink > 1 && statSync(path).isFile()) {
    throw new KnowledgeError('unsafe_hardlink', 'multiply-linked files are forbidden');
  }
}

/** Reject predictable output-shape errors before any write. */
function checkDestination(root, path) {
  rejectHardlink(path);
  if (existsSync(path) && !statSync(path).isFile()) throw new KnowledgeError('unsafe_target', 'output is not a regular file');
  for (let parent = dirname(path); parent !== root && parent !== dirname(parent); parent = dirname(parent)) {
    if (existsSync(parent) && !statSync(parent).isDirectory()) {
      throw new KnowledgeError('unsafe_target', 'output parent is not a directory');
    }
  }
}

/** publish.py holds its repository guard on .ai/knowledge: writes need an initialized registry. */
function requireRegistry(root) {
  const directory = writerPath(root, '.ai/knowledge');
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new KnowledgeError('invalid_publication', '.ai/knowledge: registry directory is required');
  }
}

function profileRepoId(root) {
  const profile = JSON.parse(readFileSync(writerPath(root, PROFILE_FILE), 'utf8'));
  if (profile === null || typeof profile !== 'object' || typeof profile.repo_id !== 'string') {
    throw new KnowledgeError('invalid_publication', `${PROFILE_FILE}: repo_id must be a string`);
  }
  return profile.repo_id;
}

function identityPattern(policy) {
  return new RegExp(`^[a-z0-9][a-z0-9-]*:(?:${Object.keys(policy.canonical_targets).join('|')}):[a-z0-9][a-z0-9.-]*$`);
}

function validateIdentity(root, identity, policy) {
  const pattern = identityPattern(policy);
  const repoId = profileRepoId(root);
  if (!pattern.test(identity) || identity.split(':')[0] !== repoId) {
    throw new KnowledgeError('invalid_identity', 'expected this repository:kind:slug');
  }
}

function entryRel(identity) {
  return `${ENTRIES_DIR}/${identity.replace(/:/g, '__')}.json`;
}

const ENTRY_LOCKED = 'entry lock already exists; explicit unlock required';
const SERIALIZED = 'held by another writer; writers are serialized (unlock it if stale)';
const LOCK_CHANGED = 'the lock was removed or replaced during unlock';
const LOCK_DISPLACED = 'the lock changed since inspection; it is kept under this claim for an explicit unlock';

function entryLockRel(identity) {
  return `${LOCKS_DIR}/${identity.replace(/:/g, '__')}.json.lock`;
}

// An unlock claim: <entry file>.unlocking-<claimer pid>-<uuid>.lock. Unique per
// claim, so no other process can ever produce the same name.
const CLAIM_SUFFIX = '\\.unlocking-([0-9]+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** A fresh, exclusively owned claim name for one lock this unlock removes. */
function claimLockRel(identity) {
  return `${LOCKS_DIR}/${identity.replace(/:/g, '__')}.json.unlocking-${process.pid}-${randomUUID()}.lock`;
}

/** Entry locks (and unlock claims) a writer of this repository can create. */
function writerLockPattern(policy, repoId) {
  const kinds = Object.keys(policy.canonical_targets).join('|');
  return new RegExp(`^${repoId}__(?:${kinds})__[a-z0-9][a-z0-9.-]*\\.json(?:${CLAIM_SUFFIX})?\\.lock$`);
}

/** Strict load for writers: every entry must pass the frozen schema and its own identity. */
function loadWriterEntries(root, schema) {
  const directory = writerPath(root, ENTRIES_DIR);
  if (!existsSync(directory)) return [];
  const entries = [];
  for (const name of readdirSync(directory).filter((file) => file.endsWith('.json')).sort(compareCodePoints)) {
    const path = writerPath(root, `${ENTRIES_DIR}/${name}`);
    rejectHardlink(path);
    const entry = JSON.parse(UTF8.decode(readFileSync(path)));
    validateEntry(entry, schema);
    if (join(root, ENTRIES_DIR, name) !== join(root, entryRel(entry.knowledge_id))) {
      throw new KnowledgeError('invalid_entry', 'entry identity/revisions malformed');
    }
    entries.push(entry);
  }
  return entries;
}

function selectedEntry(root, identity, schema) {
  const entries = loadWriterEntries(root, schema);
  if (entries.some((entry) => entry.repo_id !== identity.split(':')[0])) {
    throw new KnowledgeError('invalid_entry', 'foreign repository identity');
  }
  const entry = entries.find((item) => item.knowledge_id === identity);
  if (!entry) throw new KnowledgeError('unknown_identity', 'entry does not exist');
  return { entries, entry };
}

function writerAggregate(root, entries) {
  return aggregatePayload(root, entries.map((entry) => ({ rel: entryRel(entry.knowledge_id), entry })));
}

function entryOutputs(root, entries, entry, schema) {
  validateEntry(entry, schema);
  const entryPath = writerPath(root, entryRel(entry.knowledge_id));
  const registryPath = writerPath(root, REGISTRY_FILE);
  for (const path of [entryPath, registryPath]) checkDestination(root, path);
  const others = entries.filter((item) => item.knowledge_id !== entry.knowledge_id);
  return [[entryPath, canonical(entry)], [registryPath, writerAggregate(root, [...others, entry])]];
}

/** A lifecycle verb only ever moves or reads mutable, public canonical content. */
function mutableDocument(root, relative, policy) {
  const info = classify(root, relative, policy);
  if (info.classification !== 'workspace'
    || NATIVE_ROOTS.includes(relative.split('/')[0])
    || !Object.values(policy.canonical_targets).some((prefix) => relative.startsWith(prefix))
    || relative.startsWith('.ai/knowledge/')
    || relative.startsWith(`${CONTRACT_TWIN}/`)
    || policy.immutable.some((pattern) => policyMatches(relative, pattern))) {
    throw new KnowledgeError('unsafe_target', 'lifecycle target must be mutable public canonical content');
  }
  const path = writerPath(root, relative);
  checkDestination(root, path);
  return path;
}

function publicBytes(path, policy) {
  const content = readFileSync(path);
  if (scanSecrets(UTF8.decode(content), policy)) {
    throw new KnowledgeError('secret_detected', 'document contains a secret-shaped value');
  }
  return content;
}

/**
 * Hold one atomic mkdirSync lock around body(marker). The lock survives a
 * killed writer; contention fails at once with `locked`; nothing here removes
 * a lock it did not create. body may clear marker.release to keep the marker
 * for manual recovery.
 */
function holdLock(root, relative, ownerInfo, lockedDetail, body) {
  const lock = writerPath(root, relative);
  mkdirSync(dirname(lock), { recursive: true });
  try {
    mkdirSync(lock);
  } catch (error) {
    if (error.code === 'EEXIST') throw new KnowledgeError('locked', lockedDetail);
    throw error;
  }
  const inode = lstatSync(lock, { bigint: true }).ino;
  const owner = join(lock, LOCK_OWNER_FILE);
  try {
    writeFileSync(owner, canonical(ownerInfo), { encoding: 'utf8', flag: 'wx' });
    const ownerInode = lstatSync(owner, { bigint: true }).ino;
    const marker = { release: true };
    let result;
    let failure = null;
    try {
      result = body(marker);
    } catch (error) {
      failure = error;
    }
    // Never remove a replacement marker or unexpected files.
    const info = lstatSync(owner, { bigint: true });
    if (lstatSync(lock, { bigint: true }).ino !== inode || info.ino !== ownerInode
      || info.isSymbolicLink() || statSync(owner).nlink !== 1) {
      throw new KnowledgeError('lock_changed', 'entry marker changed during operation');
    }
    if (marker.release) unlinkSync(owner);
    if (failure) throw failure;
    return result;
  } finally {
    if (existsSync(lock) && lstatSync(lock, { bigint: true }).ino === inode && readdirSync(lock).length === 0) {
      rmdirSync(lock);
    }
  }
}

/**
 * Hold this identity's entry lock around body(marker), serialized against
 * writers of every identity, as publish.py's repository flock serializes them.
 * Node has no flock, so serialization uses the entry locks themselves:
 * announce (atomic mkdirSync of our own lock), then check that no other
 * writer lock of this repository exists, else back out with `locked`. Of two
 * overlapping writers, the later announcer always sees the earlier one, so at
 * most one is ever inside body; both backing out is possible and safe. A killed
 * writer leaves only its entry lock: verify reports it, every writer fails
 * locked naming it, and `unlock <id> --confirm-no-writer` alone removes it.
 */
function withEntryLock(root, identity, policy, body) {
  const own = posix.basename(entryLockRel(identity));
  const writerLock = writerLockPattern(policy, identity.split(':')[0]);
  // The token makes each lock incarnation's owner bytes unique, so unlock can
  // tell the lock it inspected from a replacement even across pid reuse.
  const owner = { pid: process.pid, token: randomUUID() };
  return holdLock(root, entryLockRel(identity), owner, ENTRY_LOCKED, (marker) => {
    const held = readdirSync(writerPath(root, LOCKS_DIR))
      .filter((name) => name !== own && writerLock.test(name))
      .sort(compareCodePoints)
      .map((name) => `${LOCKS_DIR}/${name}`);
    if (held.length) throw new KnowledgeError('locked', `${held.join(', ')}: ${SERIALIZED}`);
    return body(marker);
  });
}

// Ledger line commit marker: a record is committed once its newline is written.
const LEDGER_REPAIR = 'knowledge-ledger-repair/1';

function ledgerPath(root, relative) {
  const path = writerPath(root, relative);
  checkDestination(root, path);
  return path;
}

function parseLedgerLine(bytes) {
  try {
    const value = JSON.parse(UTF8.decode(bytes));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// A repair record always starts with these bytes (sorted keys, ledgerLine).
const REPAIR_HEAD = Buffer.from('{"action": "terminate_interrupted_record"');

/**
 * The repair record a committed line ends with, when the line is exactly an
 * interrupted fragment followed by the repair that names it (same size, same
 * sha256); null otherwise.
 */
function repairedFragment(line) {
  for (let at = line.lastIndexOf(REPAIR_HEAD); at >= 0; at = at > 0 ? line.lastIndexOf(REPAIR_HEAD, at - 1) : -1) {
    const fragment = line.subarray(0, at);
    const repair = parseLedgerLine(line.subarray(at));
    if (fragment.length && repair && repair.schema === LEDGER_REPAIR
      && repair.fragment_bytes === fragment.length && repair.fragment_sha256 === sha256(fragment)) {
      return repair;
    }
  }
  return null;
}

/**
 * The committed records of an append-only JSONL ledger. An unterminated final
 * line is an interrupted append, not a record, and is ignored. The next
 * append repairs it on the same line (fragment, then a repair record naming
 * its size and sha256, then the committing newline), so a committed line is
 * either a JSON object or a fragment with its matching repair; anything else
 * fails closed.
 */
function ledgerLines(root, relative) {
  const path = ledgerPath(root, relative);
  if (!existsSync(path)) return { path, values: [] };
  const data = readFileSync(path);
  const lines = [];
  for (let start = 0, end = data.indexOf(0x0a); end >= 0; start = end + 1, end = data.indexOf(0x0a, start)) {
    lines.push(data.subarray(start, end));
  }
  const values = lines.map((line, index) => {
    const value = parseLedgerLine(line) ?? repairedFragment(line);
    if (!value) throw new KnowledgeError('invalid_ledger', `${relative}:${index + 1}: ledger lines must be objects`);
    return value;
  });
  return { path, values };
}

/** json.dumps(value, sort_keys=True, ensure_ascii=False): the root writer's ledger line shape. */
function ledgerLine(value) {
  if (Array.isArray(value)) return `[${value.map(ledgerLine).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort(compareCodePoints)
      .map((key) => `${JSON.stringify(key)}: ${ledgerLine(value[key])}`).join(', ')}}`;
  }
  return dumpJson(value, 0);
}

/**
 * Append one record, durably and whole. An interrupted record left at the
 * tail is repaired first, on its own line: the repair record is written right
 * after the fragment and the newline that follows commits both at once, so a
 * crash at any byte leaves either an uncommitted tail (repaired by the next
 * append) or a fully repaired line, never a malformed committed one. A short
 * or failed write is retried until complete or fails; on failure the
 * uncommitted bytes are truncated away when nothing else was appended since,
 * and the error propagates before any caller acts on it.
 */
function appendEvent(path, event) {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a+');
  try {
    const size = fstatSync(fd).size;
    let text = '';
    if (size > 0) {
      const existing = Buffer.alloc(size);
      readSync(fd, existing, 0, size, 0);
      const fragment = existing.subarray(existing.lastIndexOf(0x0a) + 1);
      if (fragment.length) {
        text += `${ledgerLine({
          schema: LEDGER_REPAIR,
          at: now(),
          action: 'terminate_interrupted_record',
          fragment_bytes: fragment.length,
          fragment_sha256: sha256(fragment),
        })}\n`;
      }
    }
    const bytes = Buffer.from(`${text}${ledgerLine(event)}\n`, 'utf8');
    let written = 0;
    try {
      while (written < bytes.length) {
        const count = writeSync(fd, bytes, written, bytes.length - written);
        if (count <= 0) throw new Error(`short ledger write: ${written} of ${bytes.length} bytes`);
        written += count;
      }
      fsyncSync(fd);
    } catch (error) {
      try {
        if (written > 0 && fstatSync(fd).size === size + written) ftruncateSync(fd, size);
      } catch {
        // Left as an interrupted tail: the next append terminates and ledgers it.
      }
      throw error;
    }
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Write verbs
// ---------------------------------------------------------------------------

function cmdPublish(root, args) {
  const policy = loadPolicy();
  requireRegistry(root);
  const info = classify(root, args.path, policy);
  if (info.classification === 'private') throw new KnowledgeError('denied_private', 'source is private');
  if (info.classification === 'unsupported') throw new KnowledgeError('unsupported_format', 'source format unsupported');
  if (['.ai/knowledge', CONTRACT_TWIN].some((prefix) => args.path === prefix || args.path.startsWith(`${prefix}/`))) {
    throw new KnowledgeError('contract_fixture', 'registry and frozen fixtures are not publications');
  }
  const native = NATIVE_CLASSES.includes(info.classification);
  if (NATIVE_ROOTS.includes(args.path.split('/')[0]) && !native) {
    throw new KnowledgeError('unsupported_source', 'native path is not allowlisted');
  }
  const repoId = profileRepoId(root);
  const sourcePath = writerPath(root, args.path);
  rejectHardlink(sourcePath);
  rejectHardlink(writerPath(root, REGISTRY_FILE));
  const source = readFileSync(sourcePath);
  if (scanSecrets(UTF8.decode(source), policy)) {
    throw new KnowledgeError('secret_detected', 'source contains a secret-shaped value');
  }
  const extension = posix.extname(args.path).toLowerCase();
  const format = FORMATS[extension] ?? 'text';
  const existingId = format === 'markdown' ? frontmatter(source).identity : null;
  const supplied = args.id || existingId;
  const parts = supplied ? supplied.split(':') : [];
  const kind = args.kind || (parts.length === 3 ? parts[1] : (info.kind ?? 'doc'));
  const stem = posix.basename(args.path, posix.extname(args.path));
  const identity = args.id || existingId || `${repoId}:${kind}:${stem}`;
  if (!identityPattern(policy).test(identity)) throw new KnowledgeError('invalid_identity', 'expected repository:kind:slug');
  const [identityRepo, identityKind, slug] = identity.split(':');
  if (identityRepo !== repoId || kind !== identityKind) {
    throw new KnowledgeError('invalid_identity', 'repository or kind mismatch');
  }
  if (existingId !== null && existingId !== identity) {
    throw new KnowledgeError('id_conflict', 'frontmatter identity differs');
  }
  return withEntryLock(root, identity, policy, () => {
    const schema = loadSchema('knowledge-entry.schema.json');
    const entries = loadWriterEntries(root, schema);
    if (entries.some((entry) => entry.repo_id !== identityRepo)) {
      throw new KnowledgeError('invalid_entry', 'foreign repository identity');
    }
    const old = entries.find((entry) => entry.knowledge_id === identity) ?? null;
    if (old && !args.id && !existingId) {
      const known = new Set([
        old.canonical.path,
        ...old.revisions.flatMap((revision) => revision.derived_from.map((item) => item.path)),
      ]);
      if (!known.has(args.path)) {
        throw new KnowledgeError('id_collision', 'derived default identity already belongs to another source');
      }
    }
    if (old && (old.tombstone !== null || old.lifecycle === 'retired')) {
      throw new KnowledgeError('id_reused', 'retired identity cannot be reused');
    }
    let immutable = policy.immutable.some((pattern) => policyMatches(args.path, pattern));
    const prefix = policy.canonical_targets[kind];
    let target = immutable || (!native && args.path.startsWith(prefix)) ? args.path : `${prefix}${slug}${extension}`;
    if (old) {
      if (old.repo_id !== identityRepo || old.kind !== kind) throw new KnowledgeError('invalid_entry', 'entry identity mismatch');
      if (old.canonical.format !== format) throw new KnowledgeError('invalid_publication', 'revision format differs');
      target = old.canonical.path;
      immutable = old.canonical.immutable;
    }
    const targetInfo = classify(root, target, policy);
    if (['private', 'unsupported', ...NATIVE_CLASSES].includes(targetInfo.classification)
      || NATIVE_ROOTS.includes(target.split('/')[0])
      || target.startsWith('.ai/knowledge/')
      || target.startsWith(`${CONTRACT_TWIN}/`)
      || (policy.immutable.some((pattern) => policyMatches(target, pattern)) && !immutable)
      || (!immutable && !target.startsWith(prefix))) {
      throw new KnowledgeError('unsafe_target', 'canonical destination is forbidden');
    }
    if (entries.some((entry) => entry.knowledge_id !== identity && entry.canonical.path === target)) {
      throw new KnowledgeError('canonical_collision', 'canonical belongs to another identity');
    }
    const destination = writerPath(root, target);
    rejectHardlink(destination);
    if (existsSync(destination) && target !== args.path
      && (!old || digest(destination) !== old.revisions.at(-1).sha256)) {
      throw new KnowledgeError('canonical_collision', 'destination already exists or was edited');
    }
    if (immutable && target !== args.path) {
      throw new KnowledgeError('immutable_target', 'immutable publication must be in place');
    }
    if (args.title === '' || args.producer === '') {
      throw new KnowledgeError('invalid_publication', 'title and producer must not be empty');
    }
    const content = immutable || format !== 'markdown' ? source : addFrontmatter(source, identity);
    const entry = old ? { ...old } : {
      schema: SCHEMA,
      knowledge_id: identity,
      repo_id: identityRepo,
      kind,
      title: args.title || slug,
      lifecycle: info.lifecycle ?? 'active',
      canonical: { path: target, format, immutable, frontmatter_id: format === 'markdown' && !immutable },
      origin: {
        surface: info.surface ?? 'workspace',
        host: info.host ?? 'none',
        native: native && info.classification !== 'workspace-convention',
        producer: args.producer || 'manual',
      },
      relations: [],
      tombstone: null,
      revisions: [],
    };
    entry.canonical = { ...entry.canonical, frontmatter_id: format === 'markdown' && !immutable };
    if (args.title !== undefined) entry.title = args.title;
    entry.revisions = [...entry.revisions, {
      rev: entry.revisions.length + 1,
      sha256: sha256(content),
      published_at: now(),
      evidence_class: 'imported-historical',
      derived_from: [{
        path: args.path,
        sha256: sha256(source),
        surface: info.surface ?? 'workspace',
        classification: native ? info.classification : 'canonical',
      }],
    }];
    validateEntry(entry, schema);
    const registryContent = writerAggregate(root, [...entries.filter((item) => item.knowledge_id !== identity), entry]);
    const entryPath = writerPath(root, entryRel(identity));
    const registryPath = writerPath(root, REGISTRY_FILE);
    for (const path of [destination, entryPath, registryPath]) checkDestination(root, path);
    if (!immutable && (target !== args.path || !content.equals(source))) {
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, content);
    }
    mkdirSync(dirname(entryPath), { recursive: true });
    writeFileSync(entryPath, canonical(entry), 'utf8');
    writeFileSync(registryPath, registryContent, 'utf8');
    return entry;
  });
}

function cmdRetire(root, args) {
  const policy = loadPolicy();
  requireRegistry(root);
  validateIdentity(root, args.id, policy);
  if (scanSecrets(args.reason, policy)) throw new KnowledgeError('secret_detected', 'reason contains a secret-shaped value');
  if (!args.reason.trim()) throw new KnowledgeError('invalid_reason', 'retirement requires a reason');
  return withEntryLock(root, args.id, policy, () => {
    const schema = loadSchema('knowledge-entry.schema.json');
    const { entries, entry } = selectedEntry(root, args.id, schema);
    const source = mutableDocument(root, entry.canonical.path, policy);
    if (entry.canonical.immutable) throw new KnowledgeError('immutable_target', 'immutable entry cannot be retired');
    if (entry.lifecycle === 'retired') return entry;
    const latest = entry.revisions.at(-1).sha256;
    if (sha256(publicBytes(source, policy)) !== latest) {
      throw new KnowledgeError('canonical_changed', 'canonical bytes differ from current revision');
    }
    const updated = {
      ...entry,
      lifecycle: 'retired',
      tombstone: { reason: args.reason, last_sha256: latest, retired_at: now() },
    };
    for (const [path, data] of entryOutputs(root, entries, updated, schema)) writeFileSync(path, data, 'utf8');
    return updated;
  });
}

function lockChanged(error) {
  if (error instanceof KnowledgeError) return error;
  return ['ENOENT', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR'].includes(error.code)
    ? new KnowledgeError('lock_changed', LOCK_CHANGED)
    : error;
}

/**
 * Snapshot a lock directory as {ino, owner}, or null when there is none. Only
 * an owner.json (or nothing: a writer killed before writing it) may be inside.
 */
function inspectLock(root, relative) {
  const path = writerPath(root, relative);
  try {
    const info = lstatSync(path, { bigint: true });
    if (!info.isDirectory()) return null;
    const owner = writerPath(root, `${relative}/${LOCK_OWNER_FILE}`);
    checkDestination(root, owner);
    if (readdirSync(path).some((name) => name !== LOCK_OWNER_FILE)) {
      throw new KnowledgeError('unknown_lock_contents', 'refusing recursive lock removal');
    }
    return { ino: info.ino, owner: existsSync(owner) ? readFileSync(owner) : null };
  } catch (error) {
    if (error.code === 'ENOENT' && !existsSync(path)) return null;
    throw lockChanged(error);
  }
}

/**
 * Take exclusive ownership of the inspected lock incarnation: atomically
 * rename it to a fresh claim name only this process knows, then prove the
 * claimed object is the snapshot (same inode, same owner bytes). Deletion then
 * only ever happens under the claim name. A mismatch (the lock was replaced
 * since the snapshot) is never renamed back: a rename onto the original path
 * would replace a lock a new writer created there meanwhile. The displaced
 * incarnation stays under its claim name, which still blocks writers, and the
 * claim fails lock_changed naming it; an explicit unlock recovers it once this
 * process has exited.
 */
function claimLock(root, relative, claimRelative, snapshot) {
  const from = writerPath(root, relative);
  const to = writerPath(root, claimRelative);
  try {
    renameSync(from, to);
  } catch (error) {
    throw lockChanged(error);
  }
  let claimed = null;
  try {
    claimed = inspectLock(root, claimRelative);
  } catch {
    claimed = null;
  }
  const owners = (left, right) => (left === null ? right === null : right !== null && left.equals(right));
  if (!claimed || claimed.ino !== snapshot.ino || !owners(claimed.owner, snapshot.owner)) {
    throw new KnowledgeError('lock_changed', `${claimRelative}: ${LOCK_DISPLACED}`);
  }
}

/**
 * Everything one confirmed unlock may remove for identity, snapshotted before
 * anything is removed: claims left by unlocks that died, then the entry lock.
 * A lock that appears later is never adopted. A claim whose unlock is still
 * running (or cannot be shown dead) is refused as locked, never touched.
 * Exported, with executeUnlock, for the conformance probe.
 */
export function planUnlock(root, identity) {
  const file = identity.replace(/:/g, '__');
  const leftover = new RegExp(`^${file.replace(/\./g, '\\.')}\\.json${CLAIM_SUFFIX}\\.lock$`);
  const locks = writerPath(root, LOCKS_DIR);
  const targets = [];
  const names = existsSync(locks) ? readdirSync(locks).sort(compareCodePoints) : [];
  for (const name of names) {
    const match = leftover.exec(name);
    if (!match) continue;
    const relative = `${LOCKS_DIR}/${name}`;
    if (pidAlive(Number(match[1])) !== false) {
      throw new KnowledgeError('locked', `${relative}: claimed by an unlock that is still running`);
    }
    const snapshot = inspectLock(root, relative);
    if (snapshot) targets.push({ relative, snapshot });
  }
  const snapshot = inspectLock(root, entryLockRel(identity));
  if (snapshot) targets.push({ relative: entryLockRel(identity), snapshot });
  return targets;
}

/**
 * Remove exactly the planned lock incarnations, each claimed exclusively
 * first: prepared is ledgered before, applied after; a lost race ledgers
 * failed and fails lock_changed.
 */
export function executeUnlock(root, identity, targets) {
  if (!targets.length) throw new KnowledgeError('not_locked', 'entry lock directory does not exist');
  // Unlock only appends: it never needs the audit's content, so a damaged
  // ledger line can never block lock recovery.
  const ledger = ledgerPath(root, LOCK_EVENTS);
  const runId = randomUUID();
  let applied = null;
  for (const { relative, snapshot } of targets) {
    const prepared = {
      schema: 'knowledge-lock-event/1',
      at: now(),
      run_id: runId,
      knowledge_id: identity,
      action: 'unlock',
      lock_path: relative,
      confirm_no_writer: true,
      result: 'prepared',
    };
    // A durable intent precedes removal.
    appendEvent(ledger, prepared);
    const claimRelative = claimLockRel(identity);
    try {
      claimLock(root, relative, claimRelative, snapshot);
      const claim = writerPath(root, claimRelative);
      if (snapshot.owner !== null) unlinkSync(join(claim, LOCK_OWNER_FILE));
      rmdirSync(claim);
    } catch (error) {
      const failed = { ...prepared, at: now(), result: 'failed' };
      if (existsSync(writerPath(root, claimRelative))) failed.claim_path = claimRelative;
      appendEvent(ledger, failed);
      throw lockChanged(error);
    }
    applied = { ...prepared, at: now(), result: 'applied' };
    try {
      appendEvent(ledger, applied);
    } catch (error) {
      // A failed final audit restores the marker where it was.
      const restored = writerPath(root, relative);
      mkdirSync(restored);
      if (snapshot.owner !== null) writeFileSync(join(restored, LOCK_OWNER_FILE), snapshot.owner);
      throw error;
    }
  }
  return applied;
}

/**
 * Manual stale-lock recovery, run only after the operator confirmed no writer
 * remains (C19). Never automatic, and ledgered.
 */
function cmdUnlock(root, args) {
  const policy = loadPolicy();
  requireRegistry(root);
  validateIdentity(root, args.id, policy);
  return executeUnlock(root, args.id, planUnlock(root, args.id));
}

const ARCHIVE_MANIFEST = /^\.ai\/knowledge\/migration\/([a-z0-9][a-z0-9-]*)\/archive-confirmation\.json$/;
const CONFIRMATION_TOKEN = /^ct-\d{4}-\d{2}-\d{2}-\d{3}$/;

function archiveTarget(source) {
  const prefix = 'docs/specifications/ACTIVE/';
  if (source.startsWith(prefix)) return `docs/specifications/ARCHIVED/${source.slice(prefix.length)}`;
  return posix.join(posix.dirname(source), 'ARCHIVED', posix.basename(source));
}

/** Read an operator-supplied run receipt; never create approval. */
function archiveConfirmation(root, entry, content, target) {
  const selector = process.env[ARCHIVE_MANIFEST_ENV];
  if (!selector) throw new KnowledgeError('archive_confirmation_required', 'explicit run manifest is required');
  const match = ARCHIVE_MANIFEST.exec(selector);
  if (!match) throw new KnowledgeError('invalid_confirmation', 'unsupported manifest path');
  const manifestPath = writerPath(root, selector);
  checkDestination(root, manifestPath);
  const manifestBytes = readFileSync(manifestPath);
  const receipt = JSON.parse(UTF8.decode(manifestBytes));
  const source = entry.canonical.path;
  const runId = match[1];
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (head.error || head.status !== 0) {
    throw new Error(`git rev-parse --verify HEAD failed: ${head.error?.message ?? head.stderr.trim()}`);
  }
  const required = {
    schema: 'knowledge-archive-confirmation/1',
    repo_id: entry.repo_id,
    repo_root: root,
    knowledge_id: entry.knowledge_id,
    run_id: runId,
    source_commit: head.stdout.trim(),
    source,
    target,
    sha256: sha256(content),
    backup: `.ai/drift/backups/${runId}/${source}`,
    confirmed: true,
  };
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)
    || Object.entries(required).some(([key, value]) => receipt[key] !== value)
    || typeof receipt.confirmation_token !== 'string' || !CONFIRMATION_TOKEN.test(receipt.confirmation_token)
    || !Array.isArray(receipt.references)) {
    throw new KnowledgeError('invalid_confirmation', 'receipt does not bind this exact archive run');
  }
  const backup = writerPath(root, receipt.backup);
  checkDestination(root, backup);
  if (!existsSync(backup) || !statSync(backup).isFile() || digest(backup) !== sha256(content)) {
    throw new KnowledgeError('invalid_backup', 'confirmed backup is absent or differs');
  }
  const { path: consumed, values } = ledgerLines(root, CONFIRMATIONS);
  if (values.some((event) => event.confirmation_token === receipt.confirmation_token)) {
    throw new KnowledgeError('confirmation_consumed', 'retry requires fresh confirmation');
  }
  return { receipt, consumed, manifestHash: sha256(manifestBytes) };
}

/** Rewrite only simple inline Markdown links in an explicitly bound document. */
function repairedReference(content, reference, source, target) {
  const text = UTF8.decode(content);
  if (/[`\\<>]/.test(text)
    || /^(?: {4}|\t|\s*~~~|\s*\[[^\]]+\]:)/m.test(text)
    || /\]\([^)]*\s+[^)]*\)/.test(text)) {
    throw new KnowledgeError('unsupported_reference', 'code, HTML, definitions and complex links are not supported');
  }
  const base = posix.dirname(reference);
  const replaced = [];
  const updated = text.replace(/\]\(([^\s()]+)\)/g, (whole, value, offset) => {
    const hash = value.indexOf('#');
    const path = hash < 0 ? value : value.slice(0, hash);
    const fragment = hash < 0 ? '' : value.slice(hash);
    if (path.includes('%') && !path.includes(':')) {
      throw new KnowledgeError('unsupported_reference', 'encoded local links are not supported');
    }
    if (path.includes(':') || path.startsWith('/')) return whole;
    if (posix.normalize(posix.join(base, path)) !== source) return whole;
    replaced.push(offset, offset + whole.length);
    return `](${posix.relative(base, target)}${fragment})`;
  });
  if (updated === text) {
    throw new KnowledgeError('unsupported_reference', 'listed file has no supported inline reference');
  }
  // Check only untouched spans: a repaired link legitimately keeps the basename.
  const bounds = [0, ...replaced, text.length];
  let untouched = '';
  for (let i = 0; i < bounds.length; i += 2) untouched += text.slice(bounds[i], bounds[i + 1]);
  if (untouched.includes(source) || untouched.includes(posix.relative(base, source))) {
    throw new KnowledgeError('unsupported_reference', 'unrepaired source citation remains');
  }
  return Buffer.from(updated, 'utf8');
}

function cmdArchive(root, args) {
  const policy = loadPolicy();
  requireRegistry(root);
  validateIdentity(root, args.id, policy);
  return withEntryLock(root, args.id, policy, (marker) => {
    const schema = loadSchema('knowledge-entry.schema.json');
    const { entries, entry } = selectedEntry(root, args.id, schema);
    const sourceName = entry.canonical.path;
    const source = mutableDocument(root, sourceName, policy);
    if (entry.canonical.immutable || entry.lifecycle === 'retired') {
      throw new KnowledgeError('invalid_lifecycle', 'immutable or retired entry cannot be archived');
    }
    const content = publicBytes(source, policy);
    const contentSha = sha256(content);
    if (contentSha !== entry.revisions.at(-1).sha256) {
      throw new KnowledgeError('canonical_changed', 'canonical bytes differ from current revision');
    }
    if (entry.lifecycle === 'archived') {
      const { values } = ledgerLines(root, MIGRATION_LEDGER);
      if (!values.some((event) => event.schema === 'knowledge-migration-event/1' && event.action === 'migrate'
        && event.result === 'applied' && event.target === sourceName && event.after_sha256 === contentSha)) {
        throw new KnowledgeError('archive_incomplete', 'no matching successful migration audit; operator recovery required');
      }
      return entry;
    }
    // Moving relative outgoing links needs a larger Markdown transport; do not
    // claim to repair unsupported structures or unlisted references.
    const text = UTF8.decode(content);
    if (text.includes('<') || text.includes('>') || /\]\(|^\s*\[[^\]]+\]:/m.test(text)) {
      throw new KnowledgeError('unsupported_reference', 'source with outgoing links requires separate preparation');
    }
    const targetName = archiveTarget(sourceName);
    const target = mutableDocument(root, targetName, policy);
    if (existsSync(target) || entries.some((item) => item.canonical.path === targetName)) {
      throw new KnowledgeError('canonical_collision', 'archive destination already exists');
    }
    const { receipt, consumed, manifestHash } = archiveConfirmation(root, entry, content, targetName);
    const registered = new Set(entries.map((item) => item.canonical.path));
    const repairs = [];
    for (const reference of receipt.references) {
      if (reference === null || typeof reference !== 'object' || Array.isArray(reference)
        || !sameValue(Object.keys(reference).sort(), ['path', 'sha256'])
        || typeof reference.path !== 'string' || registered.has(reference.path)
        || repairs.some((repair) => repair.name === reference.path)
        || !reference.path.startsWith('docs/') || !reference.path.endsWith('.md')) {
        throw new KnowledgeError('invalid_reference', 'reference must be a distinct unregistered Markdown document');
      }
      const path = mutableDocument(root, reference.path, policy);
      const before = publicBytes(path, policy);
      if (sha256(before) !== reference.sha256) {
        throw new KnowledgeError('reference_changed', 'reference hash differs from confirmation');
      }
      repairs.push({ name: reference.path, path, before, after: repairedReference(before, reference.path, sourceName, targetName) });
    }
    const { path: ledger, values: events } = ledgerLines(root, MIGRATION_LEDGER);
    const updated = { ...entry, lifecycle: 'archived', canonical: { ...entry.canonical, path: targetName } };
    const outputs = entryOutputs(root, entries, updated, schema);
    const event = {
      schema: 'knowledge-migration-event/1',
      at: now(),
      run_id: receipt.run_id,
      seq: events.length + 1,
      action: 'migrate',
      source: sourceName,
      target: targetName,
      before_sha256: contentSha,
      after_sha256: contentSha,
      backup: receipt.backup,
      refs_repaired: repairs.map(({ name, before, after }) => ({
        file: name, before_sha256: sha256(before), after_sha256: sha256(after),
      })),
      result: 'applied',
    };
    // An ambiguous append/fsync failure may already have spent the token: keep
    // the marker until the final audit succeeds; recovery is then manual.
    marker.release = false;
    appendEvent(consumed, {
      schema: 'knowledge-archive-confirmation-event/1',
      at: now(),
      run_id: receipt.run_id,
      confirmation_token: receipt.confirmation_token,
      manifest_sha256: manifestHash,
      result: 'consumed',
    });
    mkdirSync(dirname(target), { recursive: true });
    renameSync(source, target);
    for (const { path, after } of repairs) writeFileSync(path, after);
    for (const [path, data] of outputs) writeFileSync(path, data, 'utf8');
    appendEvent(ledger, event);
    marker.release = true;
    return updated;
  });
}

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

const KNOWLEDGE_HELP = `Usage: ai-catapult knowledge [--root <repo>] <verb> [args]

The knowledge registry (knowledge-registry/1). The registry root defaults to
the current directory. Exit 0 ok, 1 contract violation, 2 usage or unavailable.

Read verbs:
  list [--kind <kind>] [--surface <surface>] [--lifecycle <lifecycle>] [--federated]
  find <query> [--federated]
  show <knowledge_id>
  verify
  rebuild [--check]
  serialize <source>

Write verbs (need .ai/knowledge/ and ${PROFILE_FILE}):
  publish <path> [--id <knowledge_id>] [--kind <kind>] [--title <title>] [--producer <producer>]
  archive <knowledge_id>                 (${ARCHIVE_MANIFEST_ENV}=<run confirmation manifest>)
  retire <knowledge_id> --reason <reason>
  unlock <knowledge_id> --confirm-no-writer
`;

/** Tiny per-verb token parser: known value flags, known boolean flags, positionals. */
function parseVerbTokens(tokens, valueFlags = [], boolFlags = []) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (valueFlags.includes(token)) {
      const value = tokens[i + 1];
      if (value === undefined) return { usage: `missing value for ${token}` };
      flags[token.slice(2)] = value;
      i += 1;
    } else if (boolFlags.includes(token)) {
      flags[token.slice(2)] = true;
    } else if (token.startsWith('-')) {
      return { usage: `unrecognized argument: ${token}` };
    } else {
      positionals.push(token);
    }
  }
  return { flags, positionals };
}

function writeUsageError(message) {
  process.stderr.write(`${message}\n${KNOWLEDGE_HELP}`);
  return USAGE;
}

/** Parse `--root` before the verb, exactly like registry.py's global option. */
function parseRoot(argv) {
  const rest = [];
  let rootArg = join('.');
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token === '--root') {
      const value = argv[i + 1];
      if (value === undefined) return { rootArg: null, rest, usage: 'argument --root: expected one argument' };
      rootArg = value;
      i += 2;
    } else if (token === '-h' || token === '--help') {
      process.stdout.write(KNOWLEDGE_HELP);
      return { helped: true };
    } else if (token === '--') {
      rest.push(...argv.slice(i + 1));
      break;
    } else {
      rest.push(token);
      i += 1;
    }
  }
  return { rootArg, rest };
}

/**
 * Run `knowledge` argv (everything after the verb word) and return the
 * process exit code. Mirrors registry.py main().
 */
export function runKnowledge(argv) {
  const parsed = parseRoot(argv);
  if (parsed.helped) return OK;
  if (parsed.usage) return writeUsageError(`ai-catapult knowledge: ${parsed.usage}`);
  const rest = parsed.rest;
  const verb = rest[0];
  const tokens = rest.slice(1);

  let args;
  switch (verb) {
    case 'list': {
      const { flags, positionals, usage } = parseVerbTokens(
        tokens, ['--kind', '--surface', '--lifecycle'], ['--federated'],
      );
      if (usage || positionals.length) return writeUsageError(`ai-catapult knowledge: ${usage ?? 'unrecognized arguments'}`);
      args = flags;
      break;
    }
    case 'find': {
      const { flags, positionals, usage } = parseVerbTokens(tokens, [], ['--federated']);
      if (usage) return writeUsageError(`ai-catapult knowledge: ${usage}`);
      if (positionals.length !== 1) return writeUsageError('ai-catapult knowledge: the following arguments are required: query');
      args = { ...flags, query: positionals[0] };
      break;
    }
    case 'show': {
      const { flags, positionals, usage } = parseVerbTokens(tokens);
      if (usage || flags.check !== undefined) return writeUsageError(`ai-catapult knowledge: ${usage ?? 'unrecognized arguments'}`);
      if (positionals.length !== 1) return writeUsageError('ai-catapult knowledge: the following arguments are required: knowledge_id');
      args = { ...flags, knowledgeId: positionals[0] };
      break;
    }
    case 'verify': {
      const { flags, positionals, usage } = parseVerbTokens(tokens);
      if (usage || Object.keys(flags).length || positionals.length) {
        return writeUsageError(`ai-catapult knowledge: ${usage ?? 'unrecognized arguments'}`);
      }
      args = flags;
      break;
    }
    case 'rebuild': {
      const { flags, positionals, usage } = parseVerbTokens(tokens, [], ['--check']);
      if (usage || positionals.length) return writeUsageError(`ai-catapult knowledge: ${usage ?? 'unrecognized arguments'}`);
      args = flags;
      break;
    }
    case 'serialize': {
      const { flags, positionals, usage } = parseVerbTokens(tokens);
      if (usage || Object.keys(flags).length) return writeUsageError(`ai-catapult knowledge: ${usage ?? 'unrecognized arguments'}`);
      if (positionals.length !== 1) return writeUsageError('ai-catapult knowledge: the following arguments are required: source');
      args = { ...flags, source: positionals[0] };
      break;
    }
    case 'publish': {
      const { flags, positionals, usage } = parseVerbTokens(tokens, ['--id', '--kind', '--title', '--producer']);
      if (usage) return writeUsageError(`ai-catapult knowledge: ${usage}`);
      if (!positionals.length) return writeUsageError('ai-catapult knowledge: the following arguments are required: path');
      if (positionals.length > 1) {
        return writeUsageError(`ai-catapult knowledge: unrecognized arguments: ${positionals.slice(1).join(' ')}`);
      }
      args = { ...flags, path: positionals[0] };
      break;
    }
    case 'archive':
    case 'retire':
    case 'unlock': {
      const { flags, positionals, usage } = parseVerbTokens(
        tokens,
        verb === 'retire' ? ['--reason'] : [],
        verb === 'unlock' ? ['--confirm-no-writer'] : [],
      );
      if (usage) return writeUsageError(`ai-catapult knowledge: ${usage}`);
      if (positionals.length > 1) {
        return writeUsageError(`ai-catapult knowledge: unrecognized arguments: ${positionals.slice(1).join(' ')}`);
      }
      // argparse required=True: unlock is never implied, only confirmed.
      const missing = [];
      if (!positionals.length) missing.push('id');
      if (verb === 'retire' && flags.reason === undefined) missing.push('--reason');
      if (verb === 'unlock' && flags['confirm-no-writer'] !== true) missing.push('--confirm-no-writer');
      if (missing.length) {
        return writeUsageError(`ai-catapult knowledge: the following arguments are required: ${missing.join(', ')}`);
      }
      args = { ...flags, id: positionals[0] };
      break;
    }
    case undefined:
      return writeUsageError('ai-catapult knowledge: the following arguments are required: verb');
    default:
      return writeUsageError(`ai-catapult knowledge: argument verb: invalid choice: '${verb}'`);
  }

  // Path(args.root).resolve() analog: follow symlinks that exist.
  let root;
  try {
    root = realpathSync(resolvePath(parsed.rootArg));
  } catch {
    root = resolvePath(parsed.rootArg);
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    emit({ error: 'root_unavailable', root: String(root) });
    return USAGE;
  }
  try {
    switch (verb) {
      case 'list': return cmdList(root, args);
      case 'find': return cmdFind(root, args);
      case 'show': return cmdShow(root, args);
      case 'verify': return cmdVerify(root, args);
      case 'rebuild': return cmdRebuild(root, args);
      case 'serialize': return cmdSerialize(root, args);
      case 'publish': emit(cmdPublish(root, args)); return OK;
      case 'archive': emit(cmdArchive(root, args)); return OK;
      case 'retire': emit(cmdRetire(root, args)); return OK;
      case 'unlock': emit(cmdUnlock(root, args)); return OK;
      default: return writeUsageError(`ai-catapult knowledge: argument verb: invalid choice: '${verb}'`);
    }
  } catch (error) {
    if (error instanceof KnowledgeError) {
      emit({ error: error.error, detail: error.detail });
      return FAILED;
    }
    // OSError/ValueError analogs: unreadable or malformed input is reported, never
    // crashed. Write verbs report invalid_publication, as publish.py main() does.
    const token = WRITE_VERBS.includes(verb) ? 'invalid_publication' : 'malformed_entry';
    emit({ error: token, detail: String(error.message ?? error) });
    return FAILED;
  }
}