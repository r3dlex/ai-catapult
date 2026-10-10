/**
 * Knowledge registry verbs (knowledge-registry/1).
 *
 * Read verbs: list, find, show, verify, rebuild [--check], serialize.
 * Write verbs: publish, archive, retire, unlock.
 * Exit 0 ok, 1 contract violation (an error token), 2 usage or unavailable.
 *
 * This is the packaged TS port of the umbrella reference implementation
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
 * - Ledgers. publish.py appends every audit to a JSONL file. Here the
 *   contract's archive ledgers (.ai/knowledge/migration/*.jsonl) stay JSONL;
 *   they have one appender at a time (archive runs serialized), a record is
 *   committed by its trailing newline and written whole, and an interrupted
 *   tail is repaired by the next append on its own line (fragment +
 *   knowledge-ledger-repair/1 record under one newline), so recovery restarts
 *   at any byte. Lock events, whose writers (unlocks) run concurrently, are
 *   one file each under .ai/knowledge/lock-events/, published atomically by
 *   link(): no shared tail, no partial record. Unlock never reads them, so no
 *   damaged audit blocks lock recovery.
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
  linkSync,
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
import { moduleDir } from './paths.ts';

export const SCHEMA = 'knowledge-registry/1';
export const ENTRIES_DIR = '.ai/knowledge/entries';
export const REGISTRY_FILE = '.ai/knowledge/registry.json';
export const LOCKS_DIR = '.ai/knowledge/.locks';
// Atomic mkdir locks use this owner metadata convention; future writers share it.
export const LOCK_OWNER_FILE = 'owner.json';
// The frozen pack and its docs twin are contract fixtures, never documents.
export const FIXTURE_PREFIXES: readonly [string, string] = [
  '.ai/knowledge/contract',
  'docs/specifications/ACTIVE/cross-surface-knowledge-publication.contract',
];
export const OK = 0;
export const FAILED = 1;
export const USAGE = 2;
// The contract's own knowledge_id pattern; a caller-supplied id is untrusted input.
export const KNOWLEDGE_ID =
  /^[a-z0-9][a-z0-9-]*:(adr|brd|doc|handoff|learning|plan|prd|research|review|spec|test-spec):[a-z0-9][a-z0-9.-]*$/;

export const CONTRACT_DIR = join(moduleDir(import.meta.url), '..', '.ai/knowledge/contract');

export class KnowledgeError extends Error {
  error: string;
  detail: string;

  constructor(error: string, detail?: string) {
    super(detail);
    this.name = 'KnowledgeError';
    this.error = error;
    this.detail = detail ?? '';
  }
}

// ---------------------------------------------------------------------------
// Contract-shape types (loose duck-types over untrusted JSON)
// ---------------------------------------------------------------------------

/** Minimal structural subset of the JSON Schema keywords the pack uses. */
export type JsonSchema = {
  type?: string;
  oneOf?: JsonSchema[];
  const?: unknown;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  minItems?: number;
  minLength?: number;
  pattern?: string;
  minimum?: number;
};

/** Loose entry shape: fields exist post-validation; values stay unknown. */
export type EntryRecord = {
  knowledge_id?: unknown;
  repo_id?: unknown;
  kind?: unknown;
  lifecycle?: unknown;
  title?: unknown;
  canonical?: unknown;
  revisions?: unknown;
  tombstone?: unknown;
  origin?: unknown;
};

/** A loaded entry file: its directory-relative path, filename, and parsed body. */
export type LoadedEntry = { rel: string; name: string; entry: EntryRecord };

/** One revision of an entry (rev/sha256 are schema-validated integers/strings). */
export type RevisionRecord = { rev?: unknown; sha256?: unknown };

/** A parsed registry.json entry (all values unknown until validated). */
export type RegistryEntry = Record<string, unknown>;

/** Aggregate item shape emitted by list/find and rebuilt into registry.json. */
type AggregateItem = {
  entry: string;
  kind: unknown;
  knowledge_id: unknown;
  lifecycle: unknown;
  path: unknown;
  rev: unknown;
  sha256: unknown;
  surface: unknown;
  title: unknown;
};

/** Errors reported by verify/rebuild/show (mixed entry-level and aggregate). */
export type KnowledgeErrorReport = { entry?: string; error: string; detail?: string; path?: string };

type LockWarning = { lock: string; warning: string; pid: unknown };

type RepositoryStatus = { path: string; status: string };

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------

/**
 * Compare strings by Unicode code point. JavaScript's default string compare
 * orders by UTF-16 code units, which sorts the U+D83D surrogate of an astral
 * character before U+FF5A — the exact bug fixtures/vectors pins.
 */
export function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i += 1) {
    const ca = left[i]?.codePointAt(0);
    const cb = right[i]?.codePointAt(0);
    if (ca !== cb) return ca !== undefined && cb !== undefined && ca < cb ? -1 : 1;
  }
  if (left.length === right.length) return 0;
  return left.length < right.length ? -1 : 1;
}

function shouldPreserveUndefined(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((key) => value[key] === undefined);
}

function dumpJsonNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new KnowledgeError('malformed_entry', 'non-finite number cannot be serialized to the contract');
  }
  return String(value);
}

function dumpJsonArray(items: unknown[], indent: number): string {
  if (items.length === 0) return '[]';
  const pad = ' '.repeat(indent + 2);
  return `[\n${items.map((item) => pad + dumpJson(item, indent + 2)).join(',\n')}\n${' '.repeat(indent)}]`;
}

function dumpJsonObject(record: Record<string, unknown>, indent: number): string {
  if (shouldPreserveUndefined(record)) {
    throw new KnowledgeError('malformed_entry', 'value contains undefined and cannot be serialized to the contract');
  }
  const keys = Object.keys(record).sort(compareCodePoints);
  if (keys.length === 0) return '{}';
  const pad = ' '.repeat(indent + 2);
  return `{\n${keys
    .map((key) => `${pad}${JSON.stringify(key)}: ${dumpJson(record[key], indent + 2)}`)
    .join(',\n')}\n${' '.repeat(indent)}}`;
}

function dumpJson(value: unknown, indent: number): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return dumpJsonNumber(value);
  if (Array.isArray(value)) return dumpJsonArray(value, indent);
  if (typeof value === 'object') return dumpJsonObject(value as Record<string, unknown>, indent);
  throw new KnowledgeError('malformed_entry', 'value cannot be serialized to the contract');
}

/**
 * The one serialization every reader and writer must agree on.
 *
 * Key order is Unicode code point (Python sort_keys), so U+FF5A sorts before
 * U+1F600. Non-ASCII is written literally (ensure_ascii=False); indent=2 with
 * a trailing newline.
 */
export function canonical(value: unknown): string {
  return `${dumpJson(value, 0)}\n`;
}

/** Write canonical bytes of a report to stdout. */
export function emit(value: unknown): void {
  process.stdout.write(canonical(value));
}

// ---------------------------------------------------------------------------
// Paths and digests
// ---------------------------------------------------------------------------

function digest(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function shapeReason(relative: unknown): string | null {
  if (typeof relative !== 'string' || relative === '' || relative.includes('\0') || relative.startsWith('/')) {
    return 'absolute_or_empty';
  }
  const parts = relative.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    return 'traversal';
  }
  return null;
}

function chainHasSymlink(root: string, parts: string[]): boolean {
  // A symlink anywhere in the chain can redirect the read outside the root,
  // so the chain is walked rather than only the final component.
  let walked = root;
  for (const part of parts) {
    walked = join(walked, part);
    try {
      if (lstatSync(walked).isSymbolicLink()) return true;
    } catch {
      // A missing component cannot be a symlink (Python is_symlink() is False).
    }
  }
  return false;
}

function resolvesUnderRoot(root: string, relative: string): boolean {
  // Path.resolve() analog: follow symlinks that exist, normalize the rest.
  let resolved: string;
  try {
    resolved = realpathSync(join(root, relative));
  } catch {
    resolved = resolvePath(join(root, relative));
  }
  return resolved === root || resolved.startsWith(root + sep);
}

/**
 * None/undefined when the path is a plain in-repo file, else why it cannot be
 * trusted. Mirrors registry.py unsafe_reason.
 *
 * `relative` stays unknown on purpose: callers pass untrusted JSON field
 * values, and a non-string returns the same reason a malformed string would.
 */
export function unsafeReason(root: string, relative: unknown): string | null {
  const shape = shapeReason(relative);
  if (shape) return shape;
  const parts = (relative as string).split('/');
  if (chainHasSymlink(root, parts)) return 'symlink_component';
  if (!resolvesUnderRoot(root, relative as string)) return 'escapes_root';
  return null;
}

/** Throw unsafe_path when the relative path cannot be trusted. */
export function safePath(root: string, relative: unknown): string {
  const reason = unsafeReason(root, relative);
  if (reason) throw new KnowledgeError('unsafe_path', `${String(relative)}: ${reason}`);
  // unsafeReason only passes plain in-root strings, so this cast is sound.
  return join(root, relative as string);
}

export function entryFile(root: string, knowledgeId: string): string {
  return join(root, ENTRIES_DIR, `${knowledgeId.replace(/:/g, '__')}.json`);
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftArray = Array.isArray(left);
  const rightArray = Array.isArray(right);
  if (leftArray !== rightArray) return false;
  if (leftArray) {
    const leftItems = left as unknown[];
    const rightItems = right as unknown[];
    return leftItems.length === rightItems.length
      && leftItems.every((item, i) => sameValue(item, rightItems[i]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key) && sameValue(leftRecord[key], rightRecord[key]));
}

// ---------------------------------------------------------------------------
// Loading and validation
// ---------------------------------------------------------------------------

function loadSchema(name: string): JsonSchema {
  return JSON.parse(readFileSync(join(CONTRACT_DIR, name), 'utf8')) as JsonSchema;
}

/** Read only plain registry files; malformed input is never a placeholder. */
export function loadEntries(root: string): LoadedEntry[] {
  const base = safePath(root, ENTRIES_DIR);
  if (!existsSync(base)) return [];
  if (!statSync(base).isDirectory()) throw new KnowledgeError('invalid_entries_directory', base);
  const found: LoadedEntry[] = [];
  for (const name of readdirSync(base).filter((file) => file.endsWith('.json')).sort(compareCodePoints)) {
    safePath(root, `${ENTRIES_DIR}/${name}`);
    const path = join(base, name);
    let entry: unknown;
    try {
      entry = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new KnowledgeError('malformed_entry', String((error as Error).message ?? error));
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new KnowledgeError('malformed_entry', path);
    }
    found.push({ rel: `${ENTRIES_DIR}/${name}`, name, entry });
  }
  return found;
}

const JSON_TYPE_MATCH: Record<string, (value: unknown) => boolean> = {
  object: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  array: (value) => Array.isArray(value),
  string: (value) => typeof value === 'string',
  boolean: (value) => typeof value === 'boolean',
  integer: (value) => typeof value === 'number' && Number.isInteger(value),
  null: (value) => value === null,
};

function matchJsonType(kind: string | undefined, value: unknown): boolean {
  if (kind === undefined) return true;
  return JSON_TYPE_MATCH[kind]?.(value) ?? true; // no type keyword constrains nothing
}

function schemaScalarErrors(value: unknown, schema: JsonSchema, location: string, errors: string[]): void {
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !sameValue(value, schema.const)) {
    errors.push(`${location}: const`);
  }
  const enumOptions = schema.enum;
  if (Object.prototype.hasOwnProperty.call(schema, 'enum')
    && !(enumOptions as unknown[]).some((option) => sameValue(value, option))) {
    errors.push(`${location}: enum`);
  }
}

function pushRequiredKeyErrors(schema: JsonSchema, record: Record<string, unknown>, location: string, errors: string[]): void {
  for (const key of schema.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) errors.push(`${location}.${key}: required`);
  }
}

function schemaObjectErrors(value: unknown, schema: JsonSchema, location: string, errors: string[]): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  pushRequiredKeyErrors(schema, record, location, errors);
  const properties = schema.properties ?? {};
  for (const key of Object.keys(record)) {
    const property = properties[key];
    if (property !== undefined) {
      errors.push(...schemaErrors(record[key], property, `${location}.${key}`));
    } else if (schema.additionalProperties === false) {
      errors.push(`${location}.${key}: unexpected`);
    }
  }
}

function schemaArrayErrors(value: unknown, schema: JsonSchema, location: string, errors: string[]): void {
  if (!Array.isArray(value)) return;
  const items = value as unknown[];
  const minItems = schema.minItems ?? 0;
  if (items.length < minItems) errors.push(`${location}: minItems`);
  const itemSchema: JsonSchema = schema.items ?? {};
  for (let i = 0; i < items.length; i += 1) {
    errors.push(...schemaErrors(items[i], itemSchema, `${location}[${i}]`));
  }
}

function schemaStringErrors(value: unknown, schema: JsonSchema, location: string, errors: string[]): void {
  if (typeof value !== 'string') return;
  const minLength = schema.minLength ?? 0;
  if (value.length < minLength) errors.push(`${location}: minLength`);
  if (Object.prototype.hasOwnProperty.call(schema, 'pattern')) {
    const patternSource = schema.pattern as string; // JSON never holds undefined under a present key
    let pattern: RegExp;
    try {
      pattern = new RegExp(patternSource);
    } catch {
      throw new KnowledgeError('malformed_entry', `schema pattern does not compile: ${patternSource}`);
    }
    if (!pattern.test(value)) errors.push(`${location}: pattern`);
  }
}

function schemaNumberErrors(value: unknown, schema: JsonSchema, location: string, errors: string[]): void {
  if (typeof value !== 'number' || !Number.isInteger(value)) return;
  const minimum = schema.minimum;
  if (minimum !== undefined && value < minimum) errors.push(`${location}: minimum`);
}

/**
 * Validate the finite structural keywords used by the frozen entry schema.
 *
 * Descriptions, titles and schema identifiers are annotations, not constraints.
 * This is deliberately not a general-purpose JSON Schema implementation.
 * (Mirrors registry.py schema_errors.)
 */
export function schemaErrors(value: unknown, schema: JsonSchema, location = 'entry'): string[] {
  if (Object.prototype.hasOwnProperty.call(schema, 'oneOf')) {
    const oneOf = schema.oneOf as JsonSchema[];
    const matches = oneOf.reduce<number>(
      (count, option) => count + (schemaErrors(value, option, location).length === 0 ? 1 : 0),
      0,
    );
    return matches === 1 ? [] : [`${location}: oneOf`];
  }
  if (schema.type !== undefined && !matchJsonType(schema.type, value)) {
    return [`${location}: expected ${schema.type}`];
  }
  const errors: string[] = [];
  schemaScalarErrors(value, schema, location, errors);
  schemaObjectErrors(value, schema, location, errors);
  schemaArrayErrors(value, schema, location, errors);
  schemaStringErrors(value, schema, location, errors);
  schemaNumberErrors(value, schema, location, errors);
  return errors;
}

/** Validation errors of the given entries against entry + canonical reality. */
function preSchemaUnsafeReason(root: string, entry: EntryRecord): string | null {
  const canonicalInfo = entry.canonical;
  if (canonicalInfo !== null && typeof canonicalInfo === 'object'
    && Object.prototype.hasOwnProperty.call(canonicalInfo, 'path')) {
    return unsafeReason(root, (canonicalInfo as Record<string, unknown>).path);
  }
  return null;
}

function tombstoneOf(entry: EntryRecord): Record<string, unknown> | null {
  return entry.tombstone !== null && typeof entry.tombstone === 'object' && !Array.isArray(entry.tombstone)
    ? (entry.tombstone as Record<string, unknown>)
    : null;
}

/**
 * Contract consistency checks on a schema-valid entry.
 */
function consistencyProblems(
  root: string,
  rel: string,
  entry: EntryRecord,
  id: string,
  latestRevision: RevisionRecord,
): string[] {
  const problems: string[] = [];
  // The entry passed the frozen schema: knowledge_id/repo_id/kind are
  // contract strings; the casts mirror registry.py's direct derefs.
  const repoId = entry.repo_id as string;
  const kind = entry.kind as string;
  const revisions = entry.revisions as RevisionRecord[];
  if (id !== `${repoId}:${kind}:${id.split(':').at(-1)}`) {
    problems.push('knowledge_id disagrees with repo_id/kind');
  }
  if (join(root, rel) !== entryFile(root, id)) {
    problems.push('entry filename disagrees with knowledge_id');
  }
  if (revisions.some((revision, index) => revision.rev !== index + 1)) {
    problems.push('revisions must be contiguous from 1');
  }
  if ((entry.lifecycle === 'retired') !== (entry.tombstone !== null)) {
    problems.push('tombstone must exist iff retired');
  }
  const tombstone = tombstoneOf(entry);
  if (entry.tombstone && latestRevision.sha256 !== tombstone?.last_sha256) {
    problems.push('tombstone digest disagrees with latest revision');
  }
  const canonicalObj = entry.canonical as Record<string, unknown>;
  if (canonicalObj.immutable && canonicalObj.frontmatter_id) {
    problems.push('immutable canonical cannot have frontmatter_id');
  }
  return problems;
}

/** Existence/digest verification of the canonical file against the latest revision. */
function canonicalFileErrors(
  root: string,
  entry: EntryRecord,
  id: string,
  relative: string,
  latestRevision: RevisionRecord,
): KnowledgeErrorReport[] {
  const absolute = join(root, relative);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    if (entry.tombstone === null) {
      return [{ entry: id, error: 'missing_without_tombstone', detail: relative }];
    }
    return [];
  }
  if (digest(absolute) !== latestRevision.sha256) {
    return [{ entry: id, error: 'hash_mismatch', detail: relative }];
  }
  return [];
}

export function entryErrors(root: string, entries: LoadedEntry[]): KnowledgeErrorReport[] {
  const schema = loadSchema('knowledge-entry.schema.json');
  const errors: KnowledgeErrorReport[] = [];
  const seen = new Set<string>();
  for (const { name, rel, entry } of entries) {
    // canonical.path is checked before schema validation so an unsafe path is
    // reported under the filename even when the entry itself is invalid.
    const preReason = preSchemaUnsafeReason(root, entry);
    if (preReason) {
      errors.push({ entry: name, error: 'unsafe_path', detail: preReason });
      continue;
    }
    const problems = schemaErrors(entry, schema);
    const identity = entry.knowledge_id;
    if (typeof identity === 'string') {
      if (seen.has(identity)) problems.push('duplicate knowledge_id');
      seen.add(identity);
    }
    if (problems.length) {
      errors.push({ entry: name, error: 'invalid_entry', detail: problems.join('; ') });
      continue;
    }
    const id = identity as string;
    const revisions = entry.revisions as RevisionRecord[];
    const latestRevision = revisions.at(-1) as RevisionRecord;
    const canonicalObj = entry.canonical as Record<string, unknown>;
    problems.push(...consistencyProblems(root, rel, entry, id, latestRevision));
    if (problems.length) {
      errors.push({ entry: id, error: 'invalid_entry', detail: problems.join('; ') });
      continue;
    }
    // unsafeReason only passes plain in-root strings, so this cast is sound.
    const relative = canonicalObj.path as string;
    const reason = unsafeReason(root, relative);
    if (reason) {
      errors.push({ entry: id, error: 'unsafe_path', detail: reason });
    } else {
      errors.push(...canonicalFileErrors(root, entry, id, relative, latestRevision));
    }
  }
  return errors;
}

const orNull = (value: unknown): unknown => value ?? null;

function latestRevisionOf(entry: EntryRecord): RevisionRecord {
  const revisions = (entry.revisions ?? []) as RevisionRecord[];
  return revisions.length ? (revisions.at(-1) as RevisionRecord) : {};
}

function aggregateItem(rel: string, entry: EntryRecord): AggregateItem {
  const latest = latestRevisionOf(entry);
  const canonicalInfo = (entry.canonical ?? {}) as Record<string, unknown>;
  const origin = (entry.origin ?? {}) as Record<string, unknown>;
  return {
    entry: rel,
    kind: orNull(entry.kind),
    knowledge_id: orNull(entry.knowledge_id),
    lifecycle: orNull(entry.lifecycle),
    path: orNull(canonicalInfo.path),
    rev: orNull(latest.rev),
    sha256: orNull(latest.sha256),
    surface: orNull(origin.surface),
    title: orNull(entry.title),
  };
}

function repoIdOf(entries: ReadonlyArray<{ rel: string; entry: EntryRecord }>): unknown {
  for (const { entry } of entries) {
    if (entry.repo_id) return entry.repo_id;
  }
  return '';
}

/** knowledge_id sorts as a string; null/absent sort as '', as String(x ?? '') did. */
function knowledgeIdString(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

/** Aggregate items only ever consume rel + entry, whatever produced the list. */
export function aggregatePayload(root: string, entries: ReadonlyArray<{ rel: string; entry: EntryRecord }>): string {
  const items: AggregateItem[] = entries
    .map((item) => aggregateItem(item.rel, item.entry))
    .sort((left, right) => compareCodePoints(knowledgeIdString(left.knowledge_id), knowledgeIdString(right.knowledge_id)));
  return canonical({
    entries: items,
    generated_from: ENTRIES_DIR,
    repo_id: repoIdOf(entries),
    schema: SCHEMA,
  });
}

function loadAggregate(root: string): RegistryEntry[] {
  const target = safePath(root, REGISTRY_FILE);
  let aggregate: unknown;
  try {
    aggregate = JSON.parse(readFileSync(target, 'utf8'));
  } catch (error) {
    throw new KnowledgeError('invalid_aggregate', String((error as Error).message ?? error));
  }
  const schema = loadSchema('knowledge-registry.schema.json');
  const errors = schemaErrors(aggregate, schema, 'aggregate');
  if (errors.length) throw new KnowledgeError('invalid_aggregate', errors.join('; '));
  // The registry schema validated; entries is a plain array of record objects.
  return (aggregate as { entries: RegistryEntry[] }).entries;
}

function federatedRegistry(root: string): RegistryEntry[] {
  const entries = loadAggregate(root);
  for (const entry of entries) {
    safePath(root, entry.entry);
    safePath(root, entry.path);
  }
  return entries;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function managedRepositoryPath(seen: string[], repository: unknown): string {
  const record = asRecord(repository);
  if (record === null || typeof record.path !== 'string') {
    throw new KnowledgeError('invalid_matrix', 'managed repository requires a string path');
  }
  const relative = record.path;
  if (seen.includes(relative)) {
    throw new KnowledgeError('invalid_matrix', `duplicate managed path: ${relative}`);
  }
  return relative;
}

/**
 * Parse managed_repositories into checked, deduplicated relative paths.
 * Fails closed on malformed matrix structures.
 */
function parseMatrixPaths(matrix: unknown): string[] {
  const matrixObj = asRecord(matrix);
  if (matrixObj === null || !Array.isArray(matrixObj.managed_repositories)) {
    throw new KnowledgeError('invalid_matrix', 'managed_repositories must be an array');
  }
  const paths: string[] = [];
  for (const repository of matrixObj.managed_repositories as unknown[]) {
    const relative = managedRepositoryPath(paths, repository);
    paths.push(relative);
  }
  return paths;
}

function parseMatrix(root: string): unknown {
  const matrixPath = safePath(root, '.ai/matrix.json');
  let matrix: unknown;
  try {
    matrix = JSON.parse(readFileSync(matrixPath, 'utf8'));
  } catch (error) {
    throw new KnowledgeError('invalid_matrix', String((error as Error).message ?? error));
  }
  return matrix;
}

/** Read only explicitly managed registries; never initialize a child. */
function federatedEntries(root: string): { entries: RegistryEntry[]; repositories: RepositoryStatus[] } {
  const matrix = parseMatrix(root);
  const paths = parseMatrixPaths(matrix);
  const entries = federatedRegistry(root);
  const repositories: RepositoryStatus[] = [];
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

function pidAlive(pid: unknown): boolean | null {
  // POSIX pid_t is signed; reject bools, non-positive and oversized input before kill.
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid > 2 ** 31 - 1) {
    return null;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

function cmdList(root: string, args: VerbFlags): number {
  const { entries, repositories } = args.federated
    ? federatedEntries(root)
    : { entries: loadAggregate(root), repositories: null };
  const report: {
    entries: RegistryEntry[];
    skipped: { path: string; reason: string }[];
    repositories?: RepositoryStatus[];
  } = {
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

function cmdFind(root: string, args: VerbFlags): number {
  const needle = String(args.query ?? '').toLowerCase();
  const { entries, repositories } = args.federated
    ? federatedEntries(root)
    : { entries: loadAggregate(root), repositories: null };
  const hits = entries.filter((entry) => `${String(entry.knowledge_id)} ${String(entry.title)} ${String(entry.path)}`
    .toLowerCase()
    .includes(needle));
  const report: {
    entries: RegistryEntry[];
    query: unknown;
    repositories?: RepositoryStatus[];
  } = { entries: hits, query: args.query };
  if (repositories !== null) report.repositories = repositories;
  emit(report);
  return OK;
}

function cmdShow(root: string, args: VerbFlags): number {
  const knowledgeId = String(args.knowledgeId ?? '');
  if (!KNOWLEDGE_ID.test(knowledgeId)) {
    emit({ error: 'unsafe_path', detail: 'knowledge_id fails the contract pattern' });
    return USAGE;
  }
  safePath(root, `${ENTRIES_DIR}/${knowledgeId.replace(/:/g, '__')}.json`);
  const entries = loadEntries(root);
  const selected = entries.filter((item) => join(root, item.rel) === entryFile(root, knowledgeId));
  if (!selected.length) {
    emit({ error: 'unknown_entry', knowledge_id: knowledgeId });
    return FAILED;
  }
  const errors = entryErrors(root, selected);
  if (errors.length) {
    emit({ errors });
    return FAILED;
  }
  emit(selected[0]?.entry);
  return OK;
}

/** Verify leg: staleness of the derived aggregate, checked only when entries pass. */
function aggregateStaleness(root: string, entries: LoadedEntry[], found: KnowledgeErrorReport[]): KnowledgeErrorReport[] {
  const errors = [...found];
  const target = safePath(root, REGISTRY_FILE);
  if (!errors.length) {
    const current = existsSync(target) && statSync(target).isFile() ? readFileSync(target, 'utf8') : null;
    if (current === null || current !== aggregatePayload(root, entries)) {
      errors.push({ error: 'aggregate_stale', path: REGISTRY_FILE });
    }
  }
  return errors;
}

function lockWarning(root: string, lockRel: string): LockWarning | null {
  safePath(root, lockRel);
  const lock = join(root, lockRel);
  const ownerRel = statSync(lock).isDirectory() ? `${lockRel}/${LOCK_OWNER_FILE}` : lockRel;
  safePath(root, ownerRel);
  const owner = join(root, ownerRel);
  const info = readLockOwner(owner);
  const pid: unknown = info === null || info.pid === undefined ? null : info.pid;
  // Unknown ownership is not proof of a stale lock. Never remove locks.
  const alive = pidAlive(pid);
  if (alive === true) return null;
  return { lock: lockRel, warning: alive === false ? 'stale_lock' : 'lock_state_unknown', pid };
}

function lockWarnings(root: string): LockWarning[] {
  const warnings: LockWarning[] = [];
  const locks = safePath(root, LOCKS_DIR);
  if (existsSync(locks) && statSync(locks).isDirectory()) {
    for (const name of readdirSync(locks).filter((file) => file.endsWith('.lock')).sort(compareCodePoints)) {
      const warning = lockWarning(root, `${LOCKS_DIR}/${name}`);
      if (warning) warnings.push(warning);
    }
  }
  return warnings;
}

function cmdVerify(root: string): number {
  const entries = loadEntries(root);
  const errors = aggregateStaleness(root, entries, entryErrors(root, entries));
  const warnings = lockWarnings(root);

  emit({
    ok: errors.length === 0,
    checked: entries.length,
    errors,
    warnings,
  });
  return errors.length ? FAILED : OK;
}

/**
 * Read a lock owner file; unparseable or unreadable input degrades to an
 * unknown-owner record ({}) rather than a crash.
 */
function readLockOwner(owner: string): Record<string, unknown> {
  let info: unknown;
  try {
    info = JSON.parse(readFileSync(owner, 'utf8'));
  } catch {
    info = {};
  }
  return info !== null && typeof info === 'object' && !Array.isArray(info)
    ? (info as Record<string, unknown>)
    : {};
}

function cmdRebuild(root: string, args: VerbFlags): number {
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

function cmdSerialize(root: string, args: VerbFlags): number {
  // Component-wise trust check BEFORE any resolution: resolvePath/realpath
  // normalize away traversal segments and happily follow an in-root symlink
  // that can redirect the read (resolve-first was round-1 review finding F1).
  // unsafeReason is the same component-wise rule verify enforces (C05/C06);
  // registry.py's resolve-first ordering stays a known reference divergence.
  safePath(root, args.source);
  const source = join(root, String(args.source ?? ''));
  if (!existsSync(source) || !statSync(source).isFile()) {
    emit({ error: 'source_unavailable', path: String(source) });
    return USAGE;
  }
  emit(JSON.parse(readFileSync(source, 'utf8')));
  return OK;
}

// ---------------------------------------------------------------------------
// Write half: contract-shape types
// ---------------------------------------------------------------------------

/** The frozen publication policy, loadPolicy()-proven byte-identical (D4). */
type PublicationPolicy = {
  canonical_targets: Record<string, string>;
  deny: { paths: string[]; secret_patterns: string[] };
  immutable: string[];
  native_rules: NativeRule[];
  unsupported_formats: string[];
};

/** One native path rule: first matching glob wins (see publication-policy.json). */
type NativeRule = {
  classification: string;
  glob: string;
  host?: string;
  kind?: string;
  lifecycle?: string;
  surface?: string;
};

/** What classify decided for one path: always a classification, maybe more. */
type ClassInfo = {
  classification: string;
  host?: string;
  kind?: string;
  lifecycle?: string;
  surface?: string;
};

/** canonical of a schema-valid entry (additionalProperties: false). */
type ValidatedCanonical = { format: string; frontmatter_id: boolean; immutable: boolean; path: string };

/** origin of a schema-valid entry (additionalProperties: false). */
type ValidatedOrigin = { host: string; native: boolean; producer: string; surface: string };

/** One derived_from item of a schema-valid revision (additionalProperties: false). */
type ValidatedDerivedFrom = { classification: string; path: string; sha256: string; surface: string };

/** One schema-valid revision (additionalProperties: false; note optional). */
type ValidatedRevision = {
  derived_from: ValidatedDerivedFrom[];
  evidence_class: string;
  note?: string;
  published_at: string;
  rev: number;
  sha256: string;
};

/** The current revision of a schema-valid entry: the schema pins revisions minItems 1. */
function lastRevision(entry: ValidatedEntry): ValidatedRevision {
  const revision = entry.revisions.at(-1);
  if (!revision) throw new KnowledgeError('invalid_publication', 'entry revisions must not be empty');
  return revision;
}

/** The tombstone object of a retired entry (additionalProperties: false). */
type ValidatedTombstone = { last_sha256: string; reason: string; retired_at: string };

/**
 * A registry entry validateEntry proved against the frozen schema: the top
 * level is additionalProperties: true, so unknown keys stay reachable through
 * the index signature and are never dropped.
 */
type ValidatedEntry = {
  canonical: ValidatedCanonical;
  kind: string;
  knowledge_id: string;
  lifecycle: string;
  origin: ValidatedOrigin;
  relations: Record<string, unknown>[];
  repo_id: string;
  revisions: ValidatedRevision[];
  schema: string;
  title: string;
  tombstone: ValidatedTombstone | null;
  [key: string]: unknown;
};

/** A lock directory snapshot: {ino, owner, fd}, or null when there is none. */
type LockSnapshot = { ino: bigint; owner: Buffer | null; fd: number | null };

/** Everything one confirmed unlock may remove, snapshotted before removal. */
type UnlockTarget = { relative: string; snapshot: LockSnapshot };

/** One knowledge-lock-event/1 audit record (result: prepared|applied|failed). */
type LockEvent = { at: string; run_id: string } & Record<string, unknown>;

/** The operator receipt, after requireBoundReceipt proved its bound values. */
type ArchiveReceipt = {
  backup: string;
  confirmation_token: string;
  references: unknown[];
  run_id: string;
  [key: string]: unknown;
};

/** One reference document an archive repairs, with its before/after bytes. */
type ArchiveRepair = { name: string; path: string; before: Buffer; after: Buffer };

/** The publish identity inputs, all resolved before the entry lock. */
type PublishIdentity = {
  existingId: string | null;
  explicitId: string | undefined;
  extension: string;
  format: string;
  identity: string;
  identityRepo: string;
  kind: string;
  slug: string;
};

/** The first frontmatter block: closing line index and its knowledge_id. */
type FrontmatterBlock = { end: number | null; identity: string | null };

/** The canonical write slot a publish settles on (the old entry wins over the default). */
type PublishSlot = { target: string; immutable: boolean };

/** publish's source-side facts, all settled before any identity is resolved. */
type PublishSource = { info: ClassInfo; native: boolean; repoId: string; source: Buffer };

/** One operator-listed reference in a bound receipt (its sha256 stays untrusted). */
type ReceiptReference = { path: string; sha256: unknown };

/** archiveConfirmation's result: the bound receipt, the consumed-ledger path, manifest hash. */
type ArchiveConfirmation = { consumed: string; manifestHash: string; receipt: ArchiveReceipt };

// ---------------------------------------------------------------------------
// Write half: contract pin, policy and classification (publish.py, classify.py)
// ---------------------------------------------------------------------------

// sha256 of the frozen contract.lock.json: the lock cannot pin itself.
export const CONTRACT_LOCK_SHA256 = '9f5d7edfc17554c383b06aa4726dfffe564ecc8d657b16baa89ce72098d5e102';
export const PROFILE_FILE = '.ai/init/repo-profile.json';
// One file per lock event (see recordLockEvent), not a shared JSONL tail.
export const LOCK_EVENTS_DIR = '.ai/knowledge/lock-events';
export const MIGRATION_LEDGER = '.ai/knowledge/migration/ledger.jsonl';
export const CONFIRMATIONS = '.ai/knowledge/migration/confirmations.jsonl';
// Operator-supplied archive run manifest (publish.py reads the same variable).
export const ARCHIVE_MANIFEST_ENV = 'AI_KNOWLEDGE_ARCHIVE_MANIFEST';
const CONTRACT_LOCK_FILE = 'contract.lock.json';
const CONTRACT_TWIN = FIXTURE_PREFIXES[1];
const NATIVE_ROOTS = ['.omc', '.omx', '.omo', '.sisyphus'];
const NATIVE_CLASSES = ['native', 'native-legacy', 'workspace-convention'];
const FORMATS: Record<string, string> = { '.md': 'markdown', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml' };
const WRITE_VERBS = ['publish', 'archive', 'retire', 'unlock'];

/** Write verbs are the ones whose fall-through failure reports invalid_publication. */
function isWriteVerb(verb: string): boolean {
  return WRITE_VERBS.includes(verb);
}
// Python bytes.decode('utf-8'): strict, and a BOM is content, not stripped.
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function now(): string {
  return new Date().toISOString();
}

function packFiles(directory: string, prefix = ''): string[] {
  const found: string[] = [];
  for (const item of readdirSync(join(directory, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) found.push(...packFiles(directory, relative));
    else if (item.isFile()) found.push(relative);
    else throw new KnowledgeError('contract_mismatch', `${relative}: not a regular file`);
  }
  return found;
}

/** Fail closed unless the shipped pack is byte-identical to its pinned lock (D4). */
export function verifyContract(directory = CONTRACT_DIR): void {
  try {
    const lockBytes = readFileSync(join(directory, CONTRACT_LOCK_FILE));
    if (sha256(lockBytes) !== CONTRACT_LOCK_SHA256) throw new KnowledgeError('contract_mismatch', 'lock fingerprint');
    const files = (JSON.parse(lockBytes.toString('utf8')) as { files: Record<string, string> }).files;
    const expected = [...Object.keys(files), CONTRACT_LOCK_FILE].sort(compareCodePoints);
    if (!sameValue(packFiles(directory).sort(compareCodePoints), expected)) {
      throw new KnowledgeError('contract_mismatch', 'pack file inventory');
    }
    for (const [relative, want] of Object.entries(files)) {
      if (digest(join(directory, relative)) !== want) throw new KnowledgeError('contract_mismatch', relative);
    }
  } catch (error) {
    if (error instanceof KnowledgeError) throw error;
    throw new KnowledgeError('contract_mismatch', String((error as Error).message ?? error));
  }
}

function loadPolicy(): PublicationPolicy {
  // The pinned pack guarantees the policy shape; see contract.lock.json.
  verifyContract();
  return JSON.parse(readFileSync(join(CONTRACT_DIR, 'publication-policy.json'), 'utf8')) as PublicationPolicy;
}

/** Policy glob: `*` stays inside one path component; `**\/` spans zero or more directories. */
export function policyMatches(path: string, pattern: string): boolean {
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

/** classify.py safe_path: the read half's component-wise rule, plus no backslash. */
function writerPath(root: string, relative: string): string {
  if (relative.includes('\\')) {
    throw new KnowledgeError('unsafe_path', `${relative}: backslash`);
  }
  return safePath(root, relative);
}

/** Path-only classification: never reads content. First matching native rule wins. */
export function classify(root: string, relative: string, policy: PublicationPolicy): ClassInfo {
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
export function compileSecretPattern(pattern: string): RegExp {
  const inline = /^\(\?([a-zA-Z]+)\)/.exec(pattern);
  if (!inline) return new RegExp(pattern, 'u');
  if (inline[1] !== 'i') throw new KnowledgeError('contract_mismatch', `unsupported inline flags: ${String(inline[0])}`);
  return new RegExp(pattern.slice(String(inline[0]).length), 'iu');
}

function scanSecrets(text: string, policy: PublicationPolicy): boolean {
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
function asciiStrip(text: string, right = true): string {
  let start = 0;
  let end = text.length;
  while (start < end && ASCII_SPACE.includes(text.charAt(start))) start += 1;
  while (right && end > start && ASCII_SPACE.includes(text.charAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

/** Python bytes.splitlines(): \r\n, \r and \n end a line; terminators dropped. */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (/[\r\n]$/.test(text)) lines.pop();
  return lines;
}

/** The scalar value of one flat frontmatter line; unsupported syntax fails. */
function frontmatterScalar(item: string): string {
  const matched = SCALAR_LINE.exec(item);
  if (!matched) throw new KnowledgeError('invalid_frontmatter', 'unsupported mapping syntax');
  return asciiStrip(matched[1] ?? '');
}

/** Refuse nested mappings, block scalars and invalid quoted scalar forms. */
function refuseComplexFrontmatterScalar(item: string): void {
  const value = frontmatterScalar(item);
  if (value && '{[&*!>|%@`'.includes(value.charAt(0))) {
    throw new KnowledgeError('invalid_frontmatter', 'unsupported scalar syntax');
  }
  if ((value.startsWith("'") || value.startsWith('"')) && !QUOTED_SCALAR.test(value)) {
    throw new KnowledgeError('invalid_frontmatter', 'unsupported quoted scalar');
  }
}

/** The knowledge_id declared by one flat mapping line, or null when it is not. */
function frontmatterIdentity(item: string): string | null {
  const matched = IDENTITY_LINE.exec(item);
  if (!matched) return null;
  const declared = (matched[1] ?? '').trim();
  if (declared.startsWith('"') || declared.startsWith("'")) return quotedIdentity(declared);
  return declared.split(' #')[0]?.trim() ?? '';
}

/** A quoted identity scalar: the quoted body; trailing comments are allowed. */
function quotedIdentity(declared: string): string {
  const quote = declared.charAt(0);
  const end = declared.indexOf(quote, 1);
  const rest = end < 0 ? '' : declared.slice(end + 1);
  if (end < 0 || (rest.trim() && !rest.trimStart().startsWith('#'))) {
    throw new KnowledgeError('invalid_frontmatter', 'unsupported identity scalar');
  }
  return declared.slice(1, end);
}

/** knowledge_id declarations of a first frontmatter block's body lines. */
function frontmatterIdentities(lines: string[]): string[] {
  const identities: string[] = [];
  for (const item of lines) {
    if (!asciiStrip(item) || asciiStrip(item, false).startsWith('#')) continue;
    refuseComplexFrontmatterScalar(item);
    const identity = frontmatterIdentity(item);
    if (identity === null) continue;
    identities.push(identity);
  }
  return identities;
}

/**
 * The first Markdown frontmatter block as {end, identity}: the closing line's
 * index and the knowledge_id it declares, or nulls without a block. Only flat,
 * simple mappings are understood; general YAML is refused, never rewritten.
 */
function frontmatter(content: Buffer): FrontmatterBlock {
  const lines = splitLines(UTF8.decode(content));
  if (!lines.length || lines[0] !== '---') return { end: null, identity: null };
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] !== '---' && lines[index] !== '...') continue;
    const identities = frontmatterIdentities(lines.slice(1, index));
    if (identities.length > 1) throw new KnowledgeError('invalid_frontmatter', 'duplicate knowledge_id');
    return { end: index, identity: identities[0] ?? null };
  }
  throw new KnowledgeError('invalid_frontmatter', 'unterminated first block');
}

/** Merge `knowledge_id:` into the first block; every other byte is kept. */
function addFrontmatter(content: Buffer, identity: string): Buffer {
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

/** Strict load for writers: every entry must pass the frozen schema and its own identity. */
function validateEntry(value: unknown, schema: JsonSchema): ValidatedEntry {
  if (schemaErrors(value, schema).length) throw new KnowledgeError('invalid_entry', 'entry fails frozen schema');
  const entry = value as ValidatedEntry; // schema-validated: id/repo/kind are contract strings
  const [repoId, kind] = entry.knowledge_id.split(':');
  if (repoId !== entry.repo_id || kind !== entry.kind
    || entry.revisions.some((revision, index) => revision.rev !== index + 1)
    || (entry.lifecycle === 'retired') !== (entry.tombstone !== null)
    || (entry.canonical.immutable && entry.canonical.frontmatter_id)) {
    throw new KnowledgeError('invalid_entry', 'entry identity, revisions or lifecycle inconsistent');
  }
  return entry;
}

/** Metadata only: a benign spelling may alias denied or native content. */
function rejectHardlink(path: string): void {
  if (existsSync(path) && lstatSync(path).nlink > 1 && statSync(path).isFile()) {
    throw new KnowledgeError('unsafe_hardlink', 'multiply-linked files are forbidden');
  }
}

/** Reject predictable output-shape errors before any write. */
function checkDestination(root: string, path: string): void {
  rejectHardlink(path);
  if (existsSync(path) && !statSync(path).isFile()) throw new KnowledgeError('unsafe_target', 'output is not a regular file');
  for (let parent = dirname(path); parent !== root && parent !== dirname(parent); parent = dirname(parent)) {
    if (existsSync(parent) && !statSync(parent).isDirectory()) {
      throw new KnowledgeError('unsafe_target', 'output parent is not a directory');
    }
  }
}

/** publish.py holds its repository guard on .ai/knowledge: writes need an initialized registry. */
function requireRegistry(root: string): void {
  const directory = writerPath(root, '.ai/knowledge');
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new KnowledgeError('invalid_publication', '.ai/knowledge: registry directory is required');
  }
}

function profileRepoId(root: string): string {
  const profile: unknown = JSON.parse(readFileSync(writerPath(root, PROFILE_FILE), 'utf8'));
  const record = asRecord(profile);
  if (record === null || typeof record.repo_id !== 'string') {
    throw new KnowledgeError('invalid_publication', `${PROFILE_FILE}: repo_id must be a string`);
  }
  return record.repo_id;
}

function identityPattern(policy: PublicationPolicy): RegExp {
  return new RegExp(`^[a-z0-9][a-z0-9-]*:(?:${Object.keys(policy.canonical_targets).join('|')}):[a-z0-9][a-z0-9.-]*$`);
}

function validateIdentity(root: string, identity: string, policy: PublicationPolicy): void {
  const repoId = profileRepoId(root);
  if (!identityPattern(policy).test(identity) || identity.split(':')[0] !== repoId) {
    throw new KnowledgeError('invalid_identity', 'expected this repository:kind:slug');
  }
}

function entryRel(identity: string): string {
  return `${ENTRIES_DIR}/${identity.replace(/:/g, '__')}.json`;
}

const ENTRY_LOCKED = 'entry lock already exists; explicit unlock required';
const SERIALIZED = 'held by another writer; writers are serialized (unlock it if stale)';
const LOCK_CHANGED = 'the lock was removed or replaced during unlock';
const LOCK_DISPLACED = 'the lock changed since inspection; it is kept under this claim for an explicit unlock';

function entryLockRel(identity: string): string {
  return `${LOCKS_DIR}/${identity.replace(/:/g, '__')}.json.lock`;
}

// An unlock claim: <entry file>.unlocking-<claimer pid>-<uuid>.lock. Unique per
// claim, so no other process can ever produce the same name.
const CLAIM_SUFFIX = '\\.unlocking-([0-9]+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** A fresh, exclusively owned claim name for one lock this unlock removes. */
function claimLockRel(identity: string): string {
  return `${LOCKS_DIR}/${identity.replace(/:/g, '__')}.json.unlocking-${process.pid}-${randomUUID()}.lock`;
}

/** Entry locks (and unlock claims) a writer of this repository can create. */
function writerLockPattern(policy: PublicationPolicy, repoId: string): RegExp {
  const kinds = Object.keys(policy.canonical_targets).join('|');
  return new RegExp(`^${repoId}__(?:${kinds})__[a-z0-9][a-z0-9.-]*\\.json(?:${CLAIM_SUFFIX})?\\.lock$`);
}

function loadWriterEntries(root: string, schema: JsonSchema): ValidatedEntry[] {
  const directory = writerPath(root, ENTRIES_DIR);
  if (!existsSync(directory)) return [];
  const entries: ValidatedEntry[] = [];
  for (const name of readdirSync(directory).filter((file) => file.endsWith('.json')).sort(compareCodePoints)) {
    const entryPath = writerPath(root, `${ENTRIES_DIR}/${name}`);
    rejectHardlink(entryPath);
    const entry = validateEntry(JSON.parse(UTF8.decode(readFileSync(entryPath))), schema);
    if (join(root, ENTRIES_DIR, name) !== join(root, entryRel(entry.knowledge_id))) {
      throw new KnowledgeError('invalid_entry', 'entry identity/revisions malformed');
    }
    entries.push(entry);
  }
  return entries;
}

function selectedEntry(root: string, identity: string, schema: JsonSchema): { entries: ValidatedEntry[]; entry: ValidatedEntry } {
  const entries = loadWriterEntries(root, schema);
  if (entries.some((entry) => entry.repo_id !== identity.split(':')[0])) {
    throw new KnowledgeError('invalid_entry', 'foreign repository identity');
  }
  const entry = entries.find((item) => item.knowledge_id === identity);
  if (!entry) throw new KnowledgeError('unknown_identity', 'entry does not exist');
  return { entries, entry };
}

function writerAggregate(root: string, entries: ValidatedEntry[]): string {
  return aggregatePayload(root, entries.map((entry) => ({ rel: entryRel(entry.knowledge_id), entry })));
}

function entryOutputs(root: string, entries: ValidatedEntry[], entry: ValidatedEntry, schema: JsonSchema): [string, string][] {
  validateEntry(entry, schema);
  const entryPath = writerPath(root, entryRel(entry.knowledge_id));
  const registryPath = writerPath(root, REGISTRY_FILE);
  for (const target of [entryPath, registryPath]) checkDestination(root, target);
  const others = entries.filter((item) => item.knowledge_id !== entry.knowledge_id);
  return [[entryPath, canonical(entry)], [registryPath, writerAggregate(root, [...others, entry])]];
}

/** A lifecycle verb only ever moves or reads mutable, public canonical content. */
function mutableDocument(root: string, relative: string, policy: PublicationPolicy): string {
  const info = classify(root, relative, policy);
  if (info.classification !== 'workspace'
    || NATIVE_ROOTS.includes(relative.split('/')[0] ?? '')
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

function publicBytes(path: string, policy: PublicationPolicy): Buffer {
  const content = readFileSync(path);
  if (scanSecrets(UTF8.decode(content), policy)) {
    throw new KnowledgeError('secret_detected', 'document contains a secret-shaped value');
  }
  return content;
}

/** Create the lock directory atomically; an existing lock fails `locked`. */
function createLockDirectory(lock: string, lockedDetail: string): void {
  try {
    mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new KnowledgeError('locked', lockedDetail);
    throw error;
  }
}

/** True while the lock and its owner marker are exactly as this writer left them. */
function lockIntact(lock: string, inode: bigint, owner: string, ownerInode: bigint): boolean {
  // Never remove a replacement marker or unexpected files.
  const info = lstatSync(owner, { bigint: true });
  return lstatSync(lock, { bigint: true }).ino === inode
    && info.ino === ownerInode
    && !info.isSymbolicLink()
    && statSync(owner).nlink === 1;
}

/** Remove the lock directory only while it is exactly the empty incarnation we hold. */
function releaseEmptyLock(lock: string, inode: bigint): void {
  if (existsSync(lock) && lstatSync(lock, { bigint: true }).ino === inode && readdirSync(lock).length === 0) {
    rmdirSync(lock);
  }
}

/** body's outcome, deferred so the lock checks run even when it failed. */
type LockBody<T> = { ok: true; value: T } | { ok: false; error: unknown };

function runLockBody<T>(body: (marker: { release: boolean }) => T, marker: { release: boolean }): LockBody<T> {
  try {
    return { ok: true, value: body(marker) };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Hold one atomic mkdirSync lock around body(marker). The lock survives a
 * killed writer; contention fails at once with `locked`; nothing here removes
 * a lock it did not create. body may clear marker.release to keep the marker
 * for manual recovery.
 */
function holdLock<T>(
  root: string,
  relative: string,
  ownerInfo: Record<string, unknown>,
  lockedDetail: string,
  body: (marker: { release: boolean }) => T,
): T {
  const lock = writerPath(root, relative);
  mkdirSync(dirname(lock), { recursive: true });
  createLockDirectory(lock, lockedDetail);
  const inode = lstatSync(lock, { bigint: true }).ino;
  const owner = join(lock, LOCK_OWNER_FILE);
  try {
    writeFileSync(owner, canonical(ownerInfo), { encoding: 'utf8', flag: 'wx' });
    const ownerInode = lstatSync(owner, { bigint: true }).ino;
    const marker = { release: true };
    const outcome = runLockBody(body, marker);
    if (!lockIntact(lock, inode, owner, ownerInode)) {
      throw new KnowledgeError('lock_changed', 'entry marker changed during operation');
    }
    if (marker.release) unlinkSync(owner);
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  } finally {
    releaseEmptyLock(lock, inode);
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
function withEntryLock<T>(root: string, identity: string, policy: PublicationPolicy, body: (marker: { release: boolean }) => T): T {
  const own = posix.basename(entryLockRel(identity));
  // Every caller validated the identity against the policy pattern first.
  const writerLock = writerLockPattern(policy, identity.split(':')[0] as string);
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

function ledgerPath(root: string, relative: string): string {
  const path = writerPath(root, relative);
  checkDestination(root, path);
  return path;
}

function parseLedgerLine(bytes: Buffer): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(UTF8.decode(bytes)));
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
function repairedFragment(line: Buffer): Record<string, unknown> | null {
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
function ledgerLines(root: string, relative: string): { path: string; values: Record<string, unknown>[] } {
  const path = ledgerPath(root, relative);
  if (!existsSync(path)) return { path, values: [] };
  const data = readFileSync(path);
  const lines: Buffer[] = [];
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
function ledgerLine(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(ledgerLine).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort(compareCodePoints)
      .map((key) => `${JSON.stringify(key)}: ${ledgerLine((value as Record<string, unknown>)[key])}`).join(', ')}}`;
  }
  return dumpJson(value, 0);
}

/**
 * Append one record to a JSONL ledger with one appender at a time (the
 * archive ledgers: archive runs serialized), durably and whole. An
 * interrupted record left at the
 * tail is repaired first, on its own line: the repair record is written right
 * after the fragment and the newline that follows commits both at once, so a
 * crash at any byte leaves either an uncommitted tail (repaired by the next
 * append) or a fully repaired line, never a malformed committed one. A short
 * or failed write is retried until complete or fails; on failure the
 * uncommitted bytes are truncated away when nothing else was appended since,
 * and the error propagates before any caller acts on it.
 */
function appendEvent(path: string, event: Record<string, unknown>): void {
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
// Write half: write verbs (publish.py main dispatch)
// ---------------------------------------------------------------------------

/** A value flag's string value; value flags only ever carry strings. */
function stringFlag(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Publish one source document into the registry (C07, C08, C09, C15). */
function cmdPublish(root: string, args: VerbFlags): ValidatedEntry {
  const policy = loadPolicy();
  requireRegistry(root);
  const path = String(args.path);
  const origin = publishSource(root, path, policy);
  const identity = resolvePublishIdentity(path, args, origin, policy);
  return withEntryLock(root, identity.identity, policy, () => (
    publishWithinLock(root, path, args, identity, origin, policy)
  ));
}

/** The source-side publish guards and bytes, in publish.py order (l.1251..1268). */
function publishSource(root: string, path: string, policy: PublicationPolicy): PublishSource {
  const info = classify(root, path, policy);
  if (info.classification === 'private') throw new KnowledgeError('denied_private', 'source is private');
  if (info.classification === 'unsupported') throw new KnowledgeError('unsupported_format', 'source format unsupported');
  refusePublishFixture(path);
  const native = NATIVE_CLASSES.includes(info.classification);
  if (NATIVE_ROOTS.includes(path.split('/')[0] ?? '') && !native) {
    throw new KnowledgeError('unsupported_source', 'native path is not allowlisted');
  }
  const repoId = profileRepoId(root);
  const source = readPublishSource(root, path, policy);
  return { info, native, repoId, source };
}

/** Registry pack and frozen fixtures are not publications (l.1254). */
function refusePublishFixture(path: string): void {
  if (['.ai/knowledge', CONTRACT_TWIN].some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    throw new KnowledgeError('contract_fixture', 'registry and frozen fixtures are not publications');
  }
}

/** The publish source bytes after hardlink and secret screening (l.1262..1268). */
function readPublishSource(root: string, path: string, policy: PublicationPolicy): Buffer {
  const sourcePath = writerPath(root, path);
  rejectHardlink(sourcePath);
  rejectHardlink(writerPath(root, REGISTRY_FILE));
  const source = readFileSync(sourcePath);
  if (scanSecrets(UTF8.decode(source), policy)) {
    throw new KnowledgeError('secret_detected', 'source contains a secret-shaped value');
  }
  return source;
}

/** args.kind wins, then a supplied/documented id's middle segment, then classify's. */
function publishKind(args: VerbFlags, parts: string[], info: ClassInfo): string {
  const declared = parts.length === 3 ? (parts[1] ?? '') : (info.kind ?? 'doc');
  return stringFlag(args.kind) || declared || info.kind || 'doc';
}

/** Validate the derived identity's shape and repository membership (l.1277..1281). */
function assertedIdentity(identity: string, repoId: string, kind: string, policy: PublicationPolicy): { identityRepo: string; slug: string } {
  if (!identityPattern(policy).test(identity)) throw new KnowledgeError('invalid_identity', 'expected repository:kind:slug');
  const [identityRepo, identityKind, slug] = identity.split(':');
  if (identityRepo !== repoId || kind !== identityKind) {
    throw new KnowledgeError('invalid_identity', 'repository or kind mismatch');
  }
  return { identityRepo: identityRepo ?? '', slug: slug ?? '' };
}

/** Extension, format, supplied/documented identity, kind and slug (l.1269..1284). */
function resolvePublishIdentity(path: string, args: VerbFlags, origin: PublishSource, policy: PublicationPolicy): PublishIdentity {
  const extension = posix.extname(path).toLowerCase();
  const format = FORMATS[extension] ?? 'text';
  const existingId = format === 'markdown' ? frontmatter(origin.source).identity : null;
  const explicitId = stringFlag(args.id);
  const suppliedId = explicitId || existingId;
  const parts = suppliedId ? suppliedId.split(':') : [];
  const kind = publishKind(args, parts, origin.info);
  const stem = posix.basename(path, posix.extname(path));
  const identity = explicitId || existingId || `${origin.repoId}:${kind}:${stem}`;
  const settled = assertedIdentity(identity, origin.repoId, kind, policy);
  if (existingId !== null && existingId !== identity) {
    throw new KnowledgeError('id_conflict', 'frontmatter identity differs');
  }
  return { existingId, explicitId, extension, format, identity, kind, ...settled };
}

/** Registry reads and the canonical/entry/aggregate writes under the lock. */
function publishWithinLock(root: string, path: string, args: VerbFlags, identity: PublishIdentity, origin: PublishSource, policy: PublicationPolicy): ValidatedEntry {
  const schema = loadSchema('knowledge-entry.schema.json');
  const entries = loadWriterEntries(root, schema);
  if (entries.some((item) => item.repo_id !== identity.identityRepo)) {
    throw new KnowledgeError('invalid_entry', 'foreign repository identity');
  }
  const old = entries.find((item) => item.knowledge_id === identity.identity) ?? null;
  refusePublishReuse(path, identity, old);
  const slot = publishSlot(policy, path, origin.native, identity, old);
  refusePublishTarget(root, slot.target, policy.canonical_targets[identity.kind] ?? '', slot.immutable, policy);
  if (entries.some((item) => item.knowledge_id !== identity.identity && item.canonical.path === slot.target)) {
    throw new KnowledgeError('canonical_collision', 'canonical belongs to another identity');
  }
  const destination = publishDestination(root, slot.target, path, slot, old);
  if (args.title === '' || args.producer === '') {
    throw new KnowledgeError('invalid_publication', 'title and producer must not be empty');
  }
  const content = slot.immutable || identity.format !== 'markdown'
    ? origin.source
    : addFrontmatter(origin.source, identity.identity);
  const entry = publishEntry(old, identity, slot, path, origin.native, args, origin.info, origin.source, content);
  validateEntry(entry, schema);
  return commitPublish(root, entries, entry, destination, path, content, origin.source, slot);
}

/** Retired identities and derived default identities owned elsewhere are refused. */
function refusePublishReuse(path: string, identity: PublishIdentity, old: ValidatedEntry | null): void {
  if (old && !identity.explicitId && !identity.existingId) {
    const known = new Set([
      old.canonical.path,
      ...old.revisions.flatMap((revision) => revision.derived_from.map((item) => item.path)),
    ]);
    if (!known.has(path)) {
      throw new KnowledgeError('id_collision', 'derived default identity already belongs to another source');
    }
  }
  if (old && (old.tombstone !== null || old.lifecycle === 'retired')) {
    throw new KnowledgeError('id_reused', 'retired identity cannot be reused');
  }
}

/** The old entry settles the slot; otherwise the immutable-aware default. */
function publishSlot(policy: PublicationPolicy, path: string, native: boolean, identity: PublishIdentity, old: ValidatedEntry | null): PublishSlot {
  let immutable = policy.immutable.some((pattern) => policyMatches(path, pattern));
  const prefix = policy.canonical_targets[identity.kind];
  if (prefix === undefined) throw new KnowledgeError('invalid_identity', 'kind has no canonical target');
  let target = immutable || (!native && path.startsWith(prefix)) ? path : `${prefix}${identity.slug}${identity.extension}`;
  if (old) {
    if (old.repo_id !== identity.identityRepo || old.kind !== identity.kind) {
      throw new KnowledgeError('invalid_entry', 'entry identity mismatch');
    }
    if (old.canonical.format !== identity.format) throw new KnowledgeError('invalid_publication', 'revision format differs');
    target = old.canonical.path;
    immutable = old.canonical.immutable;
  }
  return { target, immutable };
}

/** The canonical destination is classified, mutable-public, ours and not frozen. */
function refusePublishTarget(root: string, target: string, prefix: string, immutable: boolean, policy: PublicationPolicy): void {
  const targetInfo = classify(root, target, policy);
  if (['private', 'unsupported', ...NATIVE_CLASSES].includes(targetInfo.classification)
    || NATIVE_ROOTS.includes(target.split('/')[0] ?? '')
    || target.startsWith('.ai/knowledge/')
    || target.startsWith(`${CONTRACT_TWIN}/`)
    || (policy.immutable.some((pattern) => policyMatches(target, pattern)) && !immutable)
    || (!immutable && !target.startsWith(prefix))) {
    throw new KnowledgeError('unsafe_target', 'canonical destination is forbidden');
  }
}

/** The destination exists only as the old entry's own current bytes. */
function publishDestination(root: string, target: string, path: string, slot: PublishSlot, old: ValidatedEntry | null): string {
  const destination = writerPath(root, target);
  rejectHardlink(destination);
  if (existsSync(destination) && target !== path
    && (!old || digest(destination) !== lastRevision(old).sha256)) {
    throw new KnowledgeError('canonical_collision', 'destination already exists or was edited');
  }
  if (slot.immutable && target !== path) {
    throw new KnowledgeError('immutable_target', 'immutable publication must be in place');
  }
  return destination;
}

/** A fresh registry entry for a first publication (l.1339..1355). */
function freshPublishEntry(identity: PublishIdentity, slot: PublishSlot, native: boolean, args: VerbFlags, info: ClassInfo): ValidatedEntry {
  return {
    schema: SCHEMA,
    knowledge_id: identity.identity,
    repo_id: identity.identityRepo,
    kind: identity.kind,
    title: stringFlag(args.title) || identity.slug,
    lifecycle: info.lifecycle ?? 'active',
    canonical: {
      path: slot.target,
      format: identity.format,
      immutable: slot.immutable,
      frontmatter_id: identity.format === 'markdown' && !slot.immutable,
    },
    origin: {
      surface: info.surface ?? 'workspace',
      host: info.host ?? 'none',
      native: native && info.classification !== 'workspace-convention',
      producer: stringFlag(args.producer) || 'manual',
    },
    relations: [],
    tombstone: null,
    revisions: [],
  };
}

/** The old entry carried forward, or a fresh entry for this publication. */
function publishEntry(old: ValidatedEntry | null, identity: PublishIdentity, slot: PublishSlot, path: string, native: boolean, args: VerbFlags, info: ClassInfo, source: Buffer, content: Buffer): ValidatedEntry {
  const entry: ValidatedEntry = old ? { ...old } : freshPublishEntry(identity, slot, native, args, info);
  entry.canonical = { ...entry.canonical, frontmatter_id: identity.format === 'markdown' && !slot.immutable };
  const title = stringFlag(args.title);
  if (title !== undefined) entry.title = title;
  entry.revisions = [...entry.revisions, {
    rev: entry.revisions.length + 1,
    sha256: sha256(content),
    published_at: now(),
    evidence_class: 'imported-historical',
    derived_from: [{
      path,
      sha256: sha256(source),
      surface: info.surface ?? 'workspace',
      classification: native ? info.classification : 'canonical',
    }],
  }];
  return entry;
}

/** Validate then commit: canonical bytes (unless in place), entry, aggregate. */
function commitPublish(root: string, entries: ValidatedEntry[], entry: ValidatedEntry, destination: string, path: string, content: Buffer, source: Buffer, slot: PublishSlot): ValidatedEntry {
  const registryContent = writerAggregate(root, [...entries.filter((item) => item.knowledge_id !== entry.knowledge_id), entry]);
  const entryPath = writerPath(root, entryRel(entry.knowledge_id));
  const registryPath = writerPath(root, REGISTRY_FILE);
  for (const output of [destination, entryPath, registryPath]) checkDestination(root, output);
  if (!slot.immutable && (slot.target !== path || !content.equals(source))) {
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
  mkdirSync(dirname(entryPath), { recursive: true });
  writeFileSync(entryPath, canonical(entry), 'utf8');
  writeFileSync(registryPath, registryContent, 'utf8');
  return entry;
}

/** Retire a mutable public entry with a recorded tombstone (C10). */
function cmdRetire(root: string, args: VerbFlags): ValidatedEntry {
  const policy = loadPolicy();
  requireRegistry(root);
  const identity = String(args.id);
  validateIdentity(root, identity, policy);
  const reason = stringFlag(args.reason);
  if (reason === undefined) throw new KnowledgeError('invalid_publication', 'retirement requires a string reason');
  if (scanSecrets(reason, policy)) throw new KnowledgeError('secret_detected', 'reason contains a secret-shaped value');
  if (!reason.trim()) throw new KnowledgeError('invalid_reason', 'retirement requires a reason');
  return withEntryLock(root, identity, policy, () => {
    const schema = loadSchema('knowledge-entry.schema.json');
    const { entries, entry } = selectedEntry(root, identity, schema);
    const source = mutableDocument(root, entry.canonical.path, policy);
    if (entry.canonical.immutable) throw new KnowledgeError('immutable_target', 'immutable entry cannot be retired');
    if (entry.lifecycle === 'retired') return entry;
    const latest = lastRevision(entry).sha256;
    if (sha256(publicBytes(source, policy)) !== latest) {
      throw new KnowledgeError('canonical_changed', 'canonical bytes differ from current revision');
    }
    const updated: ValidatedEntry = {
      ...entry,
      lifecycle: 'retired',
      tombstone: { reason, last_sha256: latest, retired_at: now() },
    };
    for (const [path, data] of entryOutputs(root, entries, updated, schema)) writeFileSync(path, data, 'utf8');
    return updated;
  });
}

/** Stale or absent lock races under unlock are lock_changed; anything else rethrows. */
function lockChanged(error: unknown): unknown {
  if (error instanceof KnowledgeError) return error;
  return ['ENOENT', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
    ? new KnowledgeError('lock_changed', LOCK_CHANGED)
    : error;
}

/**
 * Snapshot a lock directory as {ino, owner, fd}, or null when there is none.
 * Only an owner.json (or nothing: a writer killed before writing it) may be
 * inside. With hold, the directory stays open (fd) until releaseSnapshots:
 * an open directory keeps its inode allocated, so no replacement lock can
 * recycle the inode number while the snapshot is in use; that, not the owner
 * bytes, is what identifies an ownerless lock.
 */
function inspectLock(root: string, relative: string, hold = false): LockSnapshot | null {
  const path = writerPath(root, relative);
  let fd: number | null = null;
  try {
    const info = lstatSync(path, { bigint: true });
    if (!info.isDirectory()) return null;
    if (hold) {
      fd = openSync(path, 'r');
      if (fstatSync(fd, { bigint: true }).ino !== info.ino) throw new KnowledgeError('lock_changed', LOCK_CHANGED);
    }
    const owner = writerPath(root, `${relative}/${LOCK_OWNER_FILE}`);
    checkDestination(root, owner);
    if (readdirSync(path).some((name) => name !== LOCK_OWNER_FILE)) {
      throw new KnowledgeError('unknown_lock_contents', 'refusing recursive lock removal');
    }
    return { ino: info.ino, owner: existsSync(owner) ? readFileSync(owner) : null, fd };
  } catch (error) {
    if (fd !== null) closeSync(fd);
    if (lockGone(error, path)) return null;
    throw lockChanged(error);
  }
}

/** True only when a lock directory is absent: ENOENT with nothing at the path. */
function lockGone(error: unknown, path: string): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT' && !existsSync(path);
}

/** Close the directories a plan holds open, on every exit path. */
export function releaseSnapshots(targets: UnlockTarget[]): void {
  for (const { snapshot } of targets) {
    if (snapshot.fd === null) continue;
    try {
      closeSync(snapshot.fd);
    } catch {
      // Already closed.
    }
    snapshot.fd = null;
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
function claimLock(root: string, relative: string, claimRelative: string, snapshot: LockSnapshot): void {
  const from = writerPath(root, relative);
  const to = writerPath(root, claimRelative);
  try {
    renameSync(from, to);
  } catch (error) {
    throw lockChanged(error);
  }
  let claimed: LockSnapshot | null;
  try {
    claimed = inspectLock(root, claimRelative);
  } catch {
    claimed = null;
  }
  const owners = (left: Buffer | null, right: Buffer | null)
    : boolean => (left === null ? right === null : right !== null && left.equals(right));
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
export function planUnlock(root: string, identity: string): UnlockTarget[] {
  const file = identity.replace(/:/g, '__');
  const leftover = new RegExp(`^${file.replace(/\./g, '\\.')}\\.json${CLAIM_SUFFIX}\\.lock$`);
  const locks = writerPath(root, LOCKS_DIR);
  const targets: UnlockTarget[] = [];
  try {
    const names = existsSync(locks) ? readdirSync(locks).sort(compareCodePoints) : [];
    for (const name of names) {
      const match = leftover.exec(name);
      if (!match) continue;
      const relative = `${LOCKS_DIR}/${name}`;
      if (pidAlive(Number(match[1] ?? '')) !== false) {
        throw new KnowledgeError('locked', `${relative}: claimed by an unlock that is still running`);
      }
      const snapshot = inspectLock(root, relative, true);
      if (snapshot) targets.push({ relative, snapshot });
    }
    const snapshot = inspectLock(root, entryLockRel(identity), true);
    if (snapshot) targets.push({ relative: entryLockRel(identity), snapshot });
    return targets;
  } catch (error) {
    releaseSnapshots(targets);
    throw error;
  }
}

/** writeSync until every byte lands in this fd: a short or failed write fails. */
function writeAll(fd: number, bytes: Buffer, detail: string): void {
  let written = 0;
  while (written < bytes.length) {
    const count = writeSync(fd, bytes, written, bytes.length - written);
    if (count <= 0) throw new Error(`${detail}: ${written} of ${bytes.length} bytes`);
    written += count;
  }
}

/**
 * Ledger one lock event as its own file, whole or not at all: written to a
 * unique temporary file (every byte, then fsync), then published under a
 * unique name with link(), which is atomic and never replaces. Concurrent
 * unlocks therefore never share a tail, and a short write or a crash leaves
 * only an ignored temporary file, never a partial record. Names sort by time.
 */
function recordLockEvent(root: string, event: LockEvent, seq: number): void {
  const directory = writerPath(root, LOCK_EVENTS_DIR);
  mkdirSync(directory, { recursive: true });
  const name = `${event.at.replace(/[-:.]/g, '')}-${event.run_id}-${String(seq).padStart(2, '0')}.json`;
  const final = writerPath(root, `${LOCK_EVENTS_DIR}/${name}`);
  const temp = writerPath(root, `${LOCK_EVENTS_DIR}/.${name}.${randomUUID()}.tmp`);
  const bytes = Buffer.from(canonical(event), 'utf8');
  try {
    const fd = openSync(temp, 'wx');
    try {
      writeAll(fd, bytes, 'short lock-event write');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    linkSync(temp, final);
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // Nothing was created, or it is already gone.
    }
  }
}

/**
 * Remove exactly the planned lock incarnations, each claimed exclusively
 * first: prepared is ledgered before, applied after; a lost race ledgers
 * failed and fails lock_changed. Unlock never reads the lock events, so no
 * damaged audit file can block lock recovery.
 */
export function executeUnlock(root: string, identity: string, targets: UnlockTarget[]): LockEvent {
  try {
    return removeTargets(root, identity, targets);
  } finally {
    releaseSnapshots(targets);
  }
}

/** Claim and remove one planned lock incarnation, ledgering prepared/failed/applied. */
function removeTargets(root: string, identity: string, targets: UnlockTarget[]): LockEvent {
  if (!targets.length) throw new KnowledgeError('not_locked', 'entry lock directory does not exist');
  const runId = randomUUID();
  let seq = 0;
  const ledger = (event: LockEvent) => recordLockEvent(root, event, (seq += 1));
  let applied: LockEvent | null = null;
  for (const { relative, snapshot } of targets) {
    const prepared: LockEvent = {
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
    ledger(prepared);
    const claimRelative = claimLockRel(identity);
    try {
      claimLock(root, relative, claimRelative, snapshot);
      const claim = writerPath(root, claimRelative);
      if (snapshot.owner !== null) unlinkSync(join(claim, LOCK_OWNER_FILE));
      rmdirSync(claim);
    } catch (error) {
      const failed: LockEvent = { ...prepared, at: now(), result: 'failed' };
      if (existsSync(writerPath(root, claimRelative))) failed.claim_path = claimRelative;
      ledger(failed);
      throw lockChanged(error);
    }
    applied = { ...prepared, at: now(), result: 'applied' };
    try {
      ledger(applied);
    } catch (error) {
      // A failed final audit restores the marker where it was.
      restoreLockMarker(root, relative, snapshot);
      throw error;
    }
  }
  // Unreachable: targets is non-empty, so at least one target applied.
  if (applied === null) throw new KnowledgeError('not_locked', 'entry lock directory does not exist');
  return applied;
}

/** A failed final audit restores the marker where it was. */
function restoreLockMarker(root: string, relative: string, snapshot: LockSnapshot): void {
  const restored = writerPath(root, relative);
  mkdirSync(restored);
  if (snapshot.owner !== null) writeFileSync(join(restored, LOCK_OWNER_FILE), snapshot.owner);
}

/**
 * Manual stale-lock recovery, run only after the operator confirmed no writer
 * remains (C19). Never automatic, and ledgered.
 */
function cmdUnlock(root: string, args: VerbFlags): LockEvent {
  const policy = loadPolicy();
  requireRegistry(root);
  const identity = String(args.id);
  validateIdentity(root, identity, policy);
  return executeUnlock(root, identity, planUnlock(root, identity));
}

// Archive confirmation: an operator-supplied run receipt must bind this move.
const ARCHIVE_MANIFEST = /^\.ai\/knowledge\/migration\/([a-z0-9][a-z0-9-]*)\/archive-confirmation\.json$/;
const CONFIRMATION_TOKEN = /^ct-\d{4}-\d{2}-\d{2}-\d{3}$/;

/** ARCHIVED/ twin of one ACTIVE specification document (docs/specifications only). */
function archiveTarget(source: string): string {
  const prefix = 'docs/specifications/ACTIVE/';
  if (source.startsWith(prefix)) return `docs/specifications/ARCHIVED/${source.slice(prefix.length)}`;
  return posix.join(posix.dirname(source), 'ARCHIVED', posix.basename(source));
}

/** Parse the operator manifest selector into this run's id (l.1645..1653). */
function archiveRunId(selector: string): string {
  const match = ARCHIVE_MANIFEST.exec(selector);
  if (!match) throw new KnowledgeError('invalid_confirmation', 'unsupported manifest path');
  return match[1] ?? '';
}

/** The commit an archive run must name: this HEAD, fail closed (l.1654..1657). */
function archiveRunHead(root: string): string {
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (head.error || head.status !== 0) {
    throw new Error(`git rev-parse --verify HEAD failed: ${head.error?.message ?? head.stderr.trim()}`);
  }
  return head.stdout.trim();
}

/** Fail unless receipt binds every required value of this run; the validated view. */
function requireBoundReceipt(receipt: unknown, required: Record<string, unknown>): ArchiveReceipt {
  const record = asRecord(receipt);
  if (record === null
    || Object.entries(required).some(([key, value]) => record[key] !== value)
    || typeof record.confirmation_token !== 'string'
    || !CONFIRMATION_TOKEN.test(record.confirmation_token)
    || !Array.isArray(record.references)) {
    throw new KnowledgeError('invalid_confirmation', 'receipt does not bind this exact archive run');
  }
  return record as ArchiveReceipt;
}

/** The confirmed backup must exist as a regular file with the moving bytes. */
function verifyArchiveBackup(root: string, receipt: ArchiveReceipt, content: Buffer): void {
  const backup = writerPath(root, receipt.backup);
  checkDestination(root, backup);
  if (!existsSync(backup) || !statSync(backup).isFile() || digest(backup) !== sha256(content)) {
    throw new KnowledgeError('invalid_backup', 'confirmed backup is absent or differs');
  }
}

/**
 * Read an operator-supplied run receipt; never create approval. The manifest
 * must bind this run exactly, its backup must exist with the moving bytes,
 * and its confirmation token must not have been consumed before (C17).
 */
function archiveConfirmation(root: string, entry: ValidatedEntry, content: Buffer, target: string): ArchiveConfirmation {
  const selector = process.env[ARCHIVE_MANIFEST_ENV];
  if (!selector) throw new KnowledgeError('archive_confirmation_required', 'explicit run manifest is required');
  const runId = archiveRunId(selector);
  const manifestPath = writerPath(root, selector);
  checkDestination(root, manifestPath);
  const manifestBytes = readFileSync(manifestPath);
  const source = entry.canonical.path;
  const receipt = requireBoundReceipt(JSON.parse(UTF8.decode(manifestBytes)), {
    schema: 'knowledge-archive-confirmation/1',
    repo_id: entry.repo_id,
    repo_root: root,
    knowledge_id: entry.knowledge_id,
    run_id: runId,
    source_commit: archiveRunHead(root),
    source,
    target,
    sha256: sha256(content),
    backup: `.ai/drift/backups/${runId}/${source}`,
    confirmed: true,
  });
  verifyArchiveBackup(root, receipt, content);
  const { path: consumed, values } = ledgerLines(root, CONFIRMATIONS);
  if (values.some((event) => event.confirmation_token === receipt.confirmation_token)) {
    throw new KnowledgeError('confirmation_consumed', 'retry requires fresh confirmation');
  }
  return { receipt, consumed, manifestHash: sha256(manifestBytes) };
}

/** One inline link: keep out-of-scope links, repair links to the moved source. */
function repairedLink(whole: string, value: string, offset: number, base: string, source: string, target: string, replaced: number[]): string {
  const hash = value.indexOf('#');
  const linkPath = hash < 0 ? value : value.slice(0, hash);
  const fragment = hash < 0 ? '' : value.slice(hash);
  if (linkPath.includes('%') && !linkPath.includes(':')) {
    throw new KnowledgeError('unsupported_reference', 'encoded local links are not supported');
  }
  if (linkPath.includes(':') || linkPath.startsWith('/')) return whole;
  if (posix.normalize(posix.join(base, linkPath)) !== source) return whole;
  replaced.push(offset, offset + whole.length);
  return `](${posix.relative(base, target)}${fragment})`;
}

/** Rewrite only simple inline Markdown links in an explicitly bound document. */
function repairedReference(content: Buffer, reference: string, source: string, target: string): Buffer {
  const text = UTF8.decode(content);
  if (/[`\\<>]/.test(text)
    || /^(?: {4}|\t|\s*~~~|\s*\[[^\]]+\]:)/m.test(text)
    || /\]\([^)]*\s+[^)]*\)/.test(text)) {
    throw new KnowledgeError('unsupported_reference', 'code, HTML, definitions and complex links are not supported');
  }
  const base = posix.dirname(reference);
  const replaced: number[] = [];
  const updated = text.replace(/\]\(([^\s()]+)\)/g, (whole: string, value: string, offset: number)
    : string => repairedLink(whole, value, offset, base, source, target, replaced));
  if (updated === text) {
    throw new KnowledgeError('unsupported_reference', 'listed file has no supported inline reference');
  }
  // Check only untouched spans: a repaired link legitimately keeps the basename.
  const bounds = [0, ...replaced, text.length];
  let untouched = '';
  for (let i = 0; i < bounds.length; i += 2) {
    const from = bounds[i];
    const to = bounds[i + 1];
    untouched += text.slice(from ?? 0, to ?? 0);
  }
  if (untouched.includes(source) || untouched.includes(posix.relative(base, source))) {
    throw new KnowledgeError('unsupported_reference', 'unrepaired source citation remains');
  }
  return Buffer.from(updated, 'utf8');
}

/** One receipt reference: distinct, unregistered, docs/ Markdown only (l.1763). */
function archiveRepairRecord(value: unknown, registered: Set<string>, repairs: ArchiveRepair[]): ReceiptReference {
  const record = asRecord(value);
  if (record === null
    || !sameValue(Object.keys(record).sort(), ['path', 'sha256'])
    || typeof record.path !== 'string') {
    throw new KnowledgeError('invalid_reference', 'reference must be a distinct unregistered Markdown document');
  }
  if (registered.has(record.path)
    || repairs.some((repair) => repair.name === record.path)
    || !record.path.startsWith('docs/') || !record.path.endsWith('.md')) {
    throw new KnowledgeError('invalid_reference', 'reference must be a distinct unregistered Markdown document');
  }
  return { path: record.path, sha256: record.sha256 };
}

/** Validate and stage the reference repairs the receipt lists (C17). */
function archiveRepairs(root: string, references: unknown[], entries: ValidatedEntry[], policy: PublicationPolicy, sourceName: string, targetName: string): ArchiveRepair[] {
  const registered = new Set(entries.map((item) => item.canonical.path));
  const repairs: ArchiveRepair[] = [];
  for (const reference of references) {
    const listed = archiveRepairRecord(reference, registered, repairs);
    const path = mutableDocument(root, listed.path, policy);
    const before = publicBytes(path, policy);
    if (sha256(before) !== listed.sha256) {
      throw new KnowledgeError('reference_changed', 'reference hash differs from confirmation');
    }
    repairs.push({ name: listed.path, path, before, after: repairedReference(before, listed.path, sourceName, targetName) });
  }
  return repairs;
}

/** The archived-lifecycle short circuit: an applied migration audit must exist. */
function archiveArchivedEntry(root: string, entry: ValidatedEntry, sourceName: string, contentSha: string): ValidatedEntry {
  const { values } = ledgerLines(root, MIGRATION_LEDGER);
  if (!values.some((event) => event.schema === 'knowledge-migration-event/1' && event.action === 'migrate'
    && event.result === 'applied' && event.target === sourceName && event.after_sha256 === contentSha)) {
    throw new KnowledgeError('archive_incomplete', 'no matching successful migration audit; operator recovery required');
  }
  return entry;
}

/** Moving relative outgoing links needs a larger Markdown transport; refuse. */
function refuseArchiveText(content: Buffer): void {
  const text = UTF8.decode(content);
  if (text.includes('<') || text.includes('>') || /\]\(|^\s*\[[^\]]+\]:/m.test(text)) {
    throw new KnowledgeError('unsupported_reference', 'source with outgoing links requires separate preparation');
  }
}

/** The knowledge-migration-event/1 audit record for one applied archive. */
function archiveMigrationEvent(receipt: ArchiveReceipt, sourceName: string, targetName: string, contentSha: string, events: Record<string, unknown>[], repairs: ArchiveRepair[]): Record<string, unknown> {
  return {
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
}

/**
 * The applied phase: consume the token, move the canonical file, repair the
 * references, write the entry outputs, audit the migration. An ambiguous
 * append/fsync failure may already have spent the token: keep the marker
 * until the final audit succeeds; recovery is then manual.
 */
function applyArchive(confirmation: ArchiveConfirmation, repairs: ArchiveRepair[], outputs: [string, string][], ledger: string, event: Record<string, unknown>, marker: { release: boolean }, updated: ValidatedEntry, source: string, target: string): ValidatedEntry {
  marker.release = false;
  appendEvent(confirmation.consumed, {
    schema: 'knowledge-archive-confirmation-event/1',
    at: now(),
    run_id: confirmation.receipt.run_id,
    confirmation_token: confirmation.receipt.confirmation_token,
    manifest_sha256: confirmation.manifestHash,
    result: 'consumed',
  });
  mkdirSync(dirname(target), { recursive: true });
  renameSync(source, target);
  for (const repair of repairs) writeFileSync(repair.path, repair.after);
  for (const [path, data] of outputs) writeFileSync(path, data, 'utf8');
  appendEvent(ledger, event);
  marker.release = true;
  return updated;
}

/** Archive a mutable public ACTIVE document under ARCHIVED/ (C17). */
function cmdArchive(root: string, args: VerbFlags): ValidatedEntry {
  const policy = loadPolicy();
  requireRegistry(root);
  const identity = String(args.id);
  validateIdentity(root, identity, policy);
  return withEntryLock(root, identity, policy, (marker) => (
    archiveWithinLock(root, identity, policy, marker)
  ));
}

function archiveWithinLock(root: string, identity: string, policy: PublicationPolicy, marker: { release: boolean }): ValidatedEntry {
  const schema = loadSchema('knowledge-entry.schema.json');
  const { entries, entry } = selectedEntry(root, identity, schema);
  const sourceName = entry.canonical.path;
  const source = mutableDocument(root, sourceName, policy);
  if (entry.canonical.immutable || entry.lifecycle === 'retired') {
    throw new KnowledgeError('invalid_lifecycle', 'immutable or retired entry cannot be archived');
  }
  const content = publicBytes(source, policy);
  const contentSha = sha256(content);
  if (contentSha !== lastRevision(entry).sha256) {
    throw new KnowledgeError('canonical_changed', 'canonical bytes differ from current revision');
  }
  if (entry.lifecycle === 'archived') return archiveArchivedEntry(root, entry, sourceName, contentSha);
  refuseArchiveText(content);
  const targetName = archiveTarget(sourceName);
  const target = mutableDocument(root, targetName, policy);
  if (existsSync(target) || entries.some((item) => item.canonical.path === targetName)) {
    throw new KnowledgeError('canonical_collision', 'archive destination already exists');
  }
  const confirmation = archiveConfirmation(root, entry, content, targetName);
  const repairs = archiveRepairs(root, confirmation.receipt.references, entries, policy, sourceName, targetName);
  const { path: ledger, values: events } = ledgerLines(root, MIGRATION_LEDGER);
  const updated: ValidatedEntry = { ...entry, lifecycle: 'archived', canonical: { ...entry.canonical, path: targetName } };
  const outputs = entryOutputs(root, entries, updated, schema);
  const event = archiveMigrationEvent(confirmation.receipt, sourceName, targetName, contentSha, events, repairs);
  return applyArchive(confirmation, repairs, outputs, ledger, event, marker, updated, source, target);
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

/** Flag bag for knowledge verbs: known value flags carry strings, booleans are true. */
type VerbFlags = Record<string, string | boolean | undefined>;

/** Tiny per-verb token parser: known value flags, known boolean flags, positionals. */
function parseVerbTokens(tokens: string[], valueFlags: string[] = [], boolFlags: string[] = []): {
  flags: VerbFlags;
  positionals: string[];
  usage?: string;
} {
  const flags: VerbFlags = {};
  const positionals: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) break; // unreachable: loop guard ensures a defined token
    if (valueFlags.includes(token)) {
      const value = tokens[i + 1];
      if (value === undefined) return { flags: {}, positionals: [], usage: `missing value for ${token}` };
      flags[token.slice(2)] = value;
      i += 1;
    } else if (boolFlags.includes(token)) {
      flags[token.slice(2)] = true;
    } else if (token.startsWith('-')) {
      return { flags: {}, positionals: [], usage: `unrecognized argument: ${token}` };
    } else {
      positionals.push(token);
    }
  }
  return { flags, positionals };
}

function writeUsageError(message: string): number {
  process.stderr.write(`${message}\n${KNOWLEDGE_HELP}`);
  return USAGE;
}

function parseListArgs(tokens: string[]): { args: VerbFlags } | { usage: string } {
  const { flags, positionals, usage } = parseVerbTokens(tokens, ['--kind', '--surface', '--lifecycle'], ['--federated']);
  if (usage || positionals.length) return { usage: `ai-catapult knowledge: ${usage ?? 'unrecognized arguments'}` };
  return { args: flags };
}

function parseFindArgs(tokens: string[]): { args: VerbFlags } | { usage: string } {
  const { flags, positionals, usage } = parseVerbTokens(tokens, [], ['--federated']);
  if (usage) return { usage: `ai-catapult knowledge: ${usage}` };
  if (positionals.length !== 1) return { usage: 'ai-catapult knowledge: the following arguments are required: query' };
  return { args: { ...flags, query: String(positionals[0]) } };
}

function parseShowArgs(tokens: string[]): { args: VerbFlags } | { usage: string } {
  const { flags, positionals, usage } = parseVerbTokens(tokens);
  if (usage || flags.check !== undefined) return { usage: `ai-catapult knowledge: ${usage ?? 'unrecognized arguments'}` };
  if (positionals.length !== 1) return { usage: 'ai-catapult knowledge: the following arguments are required: knowledge_id' };
  return { args: { ...flags, knowledgeId: String(positionals[0]) } };
}

function parseVerifyArgs(tokens: string[]): { args: VerbFlags } | { usage: string } {
  const { flags, positionals, usage } = parseVerbTokens(tokens);
  if (usage || Object.keys(flags).length || positionals.length) {
    return { usage: `ai-catapult knowledge: ${usage ?? 'unrecognized arguments'}` };
  }
  return { args: flags };
}

function parseRebuildArgs(tokens: string[]): { args: VerbFlags } | { usage: string } {
  const { flags, positionals, usage } = parseVerbTokens(tokens, [], ['--check']);
  if (usage || positionals.length) return { usage: `ai-catapult knowledge: ${usage ?? 'unrecognized arguments'}` };
  return { args: flags };
}

function parseSerializeArgs(tokens: string[]): { args: VerbFlags } | { usage: string } {
  const { flags, positionals, usage } = parseVerbTokens(tokens);
  if (usage || Object.keys(flags).length) return { usage: `ai-catapult knowledge: ${usage ?? 'unrecognized arguments'}` };
  if (positionals.length !== 1) return { usage: 'ai-catapult knowledge: the following arguments are required: source' };
  return { args: { ...flags, source: String(positionals[0]) } };
}

function parsePublishArgs(tokens: string[]): { args: VerbFlags } | { usage: string } {
  const { flags, positionals, usage } = parseVerbTokens(tokens, ['--id', '--kind', '--title', '--producer']);
  if (usage) return { usage: `ai-catapult knowledge: ${usage}` };
  if (!positionals.length) return { usage: 'ai-catapult knowledge: the following arguments are required: path' };
  if (positionals.length > 1) {
    return { usage: `ai-catapult knowledge: unrecognized arguments: ${positionals.slice(1).join(' ')}` };
  }
  return { args: { ...flags, path: String(positionals[0]) } };
}

/** argparse required=True scan: the identifiers and flags still missing. */
function missingLifecycleArgs(verb: string, flags: VerbFlags, hasId: boolean): string[] {
  const missing: string[] = [];
  if (!hasId) missing.push('id');
  // argparse required=True: unlock is never implied, only confirmed.
  if (verb === 'retire' && flags.reason === undefined) missing.push('--reason');
  if (verb === 'unlock' && flags['confirm-no-writer'] !== true) missing.push('--confirm-no-writer');
  return missing;
}

/** archive/retire/unlock: one identity positional and, where required, a flag. */
function parseLifecycleArgs(verb: string, tokens: string[]): { args: VerbFlags } | { usage: string } {
  const { flags, positionals, usage } = parseVerbTokens(
    tokens,
    verb === 'retire' ? ['--reason'] : [],
    verb === 'unlock' ? ['--confirm-no-writer'] : [],
  );
  if (usage) return { usage: `ai-catapult knowledge: ${usage}` };
  if (positionals.length > 1) {
    return { usage: `ai-catapult knowledge: unrecognized arguments: ${positionals.slice(1).join(' ')}` };
  }
  const missing = missingLifecycleArgs(verb, flags, positionals.length > 0);
  if (missing.length) {
    return { usage: `ai-catapult knowledge: the following arguments are required: ${missing.join(', ')}` };
  }
  return { args: { ...flags, id: String(positionals[0]) } };
}

/** Read verbs: the registry-reading half of the argparse flow (no side effects). */
function parseReadVerbArgs(verb: string, tokens: string[]): { args: VerbFlags } | { usage: string } | undefined {
  switch (verb) {
    case 'list': return parseListArgs(tokens);
    case 'find': return parseFindArgs(tokens);
    case 'show': return parseShowArgs(tokens);
    case 'verify': return parseVerifyArgs(tokens);
    case 'rebuild': return parseRebuildArgs(tokens);
    case 'serialize': return parseSerializeArgs(tokens);
    default: return undefined;
  }
}

/** Write verbs: publish routes to its own parser; lifecycle verbs share one. */
function parseWriteVerbArgs(verb: string, tokens: string[]): { args: VerbFlags } | { usage: string } | undefined {
  switch (verb) {
    case 'publish': return parsePublishArgs(tokens);
    case 'archive': return parseLifecycleArgs(verb, tokens);
    case 'retire': return parseLifecycleArgs(verb, tokens);
    case 'unlock': return parseLifecycleArgs(verb, tokens);
    default: return undefined;
  }
}

/** Per-verb token parsing (message-identical to the registry.py argparse flow). */
function parseVerbArgs(verb: string, tokens: string[]): { args: VerbFlags } | { usage: string } {
  return parseReadVerbArgs(verb, tokens) ?? parseWriteVerbArgs(verb, tokens)
    ?? { usage: `ai-catapult knowledge: argument verb: invalid choice: '${verb}'` };
}

type ParsedRoot =
  | { kind: 'helped' }
  | { kind: 'usage'; usage: string }
  | { kind: 'ok'; rootArg: string; rest: string[] };

/** Parse `--root` before the verb, exactly like registry.py's global option. */
function parseRoot(argv: string[]): ParsedRoot {
  const rest: string[] = [];
  let rootArg = join('.');
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token === undefined) break; // unreachable: loop guard ensures a defined token
    if (token === '--root') {
      const value = argv[i + 1];
      if (value === undefined) return { kind: 'usage', usage: 'argument --root: expected one argument' };
      rootArg = value;
      i += 2;
    } else if (token === '-h' || token === '--help') {
      process.stdout.write(KNOWLEDGE_HELP);
      return { kind: 'helped' };
    } else if (token === '--') {
      rest.push(...argv.slice(i + 1));
      break;
    } else {
      rest.push(token);
      i += 1;
    }
  }
  return { kind: 'ok', rootArg, rest };
}

/** Path(args.root).resolve() analog: follow symlinks that exist; null when unavailable. */
function resolveRegistryRoot(rootArg: string): string | null {
  let root: string;
  try {
    root = realpathSync(resolvePath(rootArg));
  } catch {
    root = resolvePath(rootArg);
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    emit({ error: 'root_unavailable', root: String(root) });
    return null;
  }
  return root;
}

/** Read verbs: registry-reading commands, each returning the process exit code. */
function dispatchReadVerb(root: string, verb: string, args: VerbFlags): number | undefined {
  switch (verb) {
    case 'list': return cmdList(root, args);
    case 'find': return cmdFind(root, args);
    case 'show': return cmdShow(root, args);
    case 'verify': return cmdVerify(root);
    case 'rebuild': return cmdRebuild(root, args);
    case 'serialize': return cmdSerialize(root, args);
    default: return undefined;
  }
}

/** Write verbs: publish/archive/retire/unlock emit their own payload and exit OK. */
function dispatchWriteVerb(root: string, verb: string, args: VerbFlags): number | undefined {
  switch (verb) {
    case 'publish': emit(cmdPublish(root, args)); return OK;
    case 'archive': emit(cmdArchive(root, args)); return OK;
    case 'retire': emit(cmdRetire(root, args)); return OK;
    case 'unlock': emit(cmdUnlock(root, args)); return OK;
    default: return undefined;
  }
}

function dispatchKnowledgeCmd(root: string, verb: string, args: VerbFlags): number {
  return dispatchReadVerb(root, verb, args) ?? dispatchWriteVerb(root, verb, args)
    ?? writeUsageError(`ai-catapult knowledge: argument verb: invalid choice: '${String(verb)}'`);
}

/**
 * Run `knowledge` argv (everything after the verb word) and return the
 * process exit code. Mirrors registry.py main().
 */
export function runKnowledge(argv: string[]): number {
  const parsed = parseRoot(argv);
  if (parsed.kind === 'helped') return OK;
  if (parsed.kind === 'usage') return writeUsageError(`ai-catapult knowledge: ${parsed.usage}`);
  const { rootArg, rest } = parsed;
  const verb = rest[0];
  const tokens = rest.slice(1);
  if (verb === undefined) {
    return writeUsageError('ai-catapult knowledge: the following arguments are required: verb');
  }

  const verbParsed = parseVerbArgs(verb, tokens);
  if ('usage' in verbParsed) return writeUsageError(verbParsed.usage);

  const root = resolveRegistryRoot(rootArg);
  if (root === null) {
    return USAGE;
  }
  try {
    return dispatchKnowledgeCmd(root, verb, verbParsed.args);
  } catch (error) {
    if (error instanceof KnowledgeError) {
      emit({ error: error.error, detail: error.detail });
      return FAILED;
    }
    // OSError/ValueError analogs: unreadable or malformed input is reported, never
    // crashed. Write verbs report invalid_publication, as publish.py main() does.
    const token = isWriteVerb(verb) ? 'invalid_publication' : 'malformed_entry';
    emit({ error: token, detail: String((error as Error).message ?? error) });
    return FAILED;
  }
}