/**
 * Knowledge read half (knowledge-registry/1).
 *
 * Verbs: list, find, show, verify, rebuild [--check], serialize.
 * Exit 0 ok, 1 verification failure, 2 usage or unavailable.
 *
 * This is the packaged JS mirror of the umbrella reference implementation
 * scripts/knowledge/registry.py (r3dlex/ai-tool-workspace). The write half
 * (publish/archive/retire/unlock) is goal XSKP-P4-03. This module never
 * writes an entry: the entry files are the source of truth and rebuild only
 * ever writes the derived aggregate.
 *
 * The frozen contract pack lives at .ai/knowledge/contract in the package
 * itself (package.json files) — schemas resolve relative to this module, the
 * same way registry.py resolves them from its own repository.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve as resolvePath, sep } from 'node:path';
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
// CLI plumbing
// ---------------------------------------------------------------------------

const KNOWLEDGE_HELP = `Usage: ai-catapult knowledge [--root <repo>] <verb> [args]

Read half of the knowledge registry (knowledge-registry/1). The registry root
defaults to the current directory. Exit 0 ok, 1 verification failure, 2 usage
or unavailable.

Verbs:
  list [--kind <kind>] [--surface <surface>] [--lifecycle <lifecycle>] [--federated]
  find <query> [--federated]
  show <knowledge_id>
  verify
  rebuild [--check]
  serialize <source>
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
      default: return writeUsageError(`ai-catapult knowledge: argument verb: invalid choice: '${verb}'`);
    }
  } catch (error) {
    if (error instanceof KnowledgeError) {
      emit({ error: error.error, detail: error.detail });
      return FAILED;
    }
    // OSError/ValueError analogs: unreadable or malformed input is reported, never crashed.
    emit({ error: 'malformed_entry', detail: String(error.message ?? error) });
    return FAILED;
  }
}