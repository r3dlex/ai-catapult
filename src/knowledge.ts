/**
 * Knowledge read half (knowledge-registry/1).
 *
 * Verbs: list, find, show, verify, rebuild [--check], serialize.
 * Exit 0 ok, 1 verification failure, 2 usage or unavailable.
 *
 * This is the packaged TS port of the umbrella reference implementation
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
import { moduleDir } from './paths.ts';

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

function repoIdOf(entries: LoadedEntry[]): unknown {
  for (const { entry } of entries) {
    if (entry.repo_id) return entry.repo_id;
  }
  return '';
}

/** knowledge_id sorts as a string; null/absent sort as '', as String(x ?? '') did. */
function knowledgeIdString(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

export function aggregatePayload(root: string, entries: LoadedEntry[]): string {
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

/** Per-verb token parsing (message-identical to the registry.py argparse flow). */
function parseVerbArgs(verb: string, tokens: string[]): { args: VerbFlags } | { usage: string } {
  switch (verb) {
    case 'list': return parseListArgs(tokens);
    case 'find': return parseFindArgs(tokens);
    case 'show': return parseShowArgs(tokens);
    case 'verify': return parseVerifyArgs(tokens);
    case 'rebuild': return parseRebuildArgs(tokens);
    case 'serialize': return parseSerializeArgs(tokens);
    default: return { usage: `ai-catapult knowledge: argument verb: invalid choice: '${verb}'` };
  }
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

function dispatchKnowledgeCmd(root: string, verb: string, args: VerbFlags): number {
  switch (verb) {
    case 'list': return cmdList(root, args);
    case 'find': return cmdFind(root, args);
    case 'show': return cmdShow(root, args);
    case 'verify': return cmdVerify(root);
    case 'rebuild': return cmdRebuild(root, args);
    case 'serialize': return cmdSerialize(root, args);
    default: return writeUsageError(`ai-catapult knowledge: argument verb: invalid choice: '${String(verb)}'`);
  }
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

  const verbParsed = verb === undefined
    ? { usage: 'ai-catapult knowledge: the following arguments are required: verb' }
    : parseVerbArgs(verb, tokens);
  if ('usage' in verbParsed) return writeUsageError(verbParsed.usage);

  const root = resolveRegistryRoot(rootArg);
  if (root === null) {
    return USAGE;
  }
  try {
    return dispatchKnowledgeCmd(root, verb as string, verbParsed.args);
  } catch (error) {
    if (error instanceof KnowledgeError) {
      emit({ error: error.error, detail: error.detail });
      return FAILED;
    }
    // OSError/ValueError analogs: unreadable or malformed input is reported, never crashed.
    emit({ error: 'malformed_entry', detail: String((error as Error).message ?? error) });
    return FAILED;
  }
}