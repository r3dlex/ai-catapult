/**
 * TDD tests for Goal tswc-ac-b1 AC-2/AC-4 — versioned evolve schemas.
 *
 * Delivered as versioned JSON Schema documents under schemas/evolve/<name>/
 * with the deterministic validator engine evaluating a declared subset:
 *
 *   schemas/evolve/audit-entry/v1.schema.json     (metadata, target skill,
 *        unified diff, score, Accepted/Rejected — append-only, never rolled back)
 *   schemas/evolve/judgment-record/v1.schema.json (master §5.4 provenance schema,
 *        delivered verbatim: judgment_id, run_id, candidate_overlay_sha256,
 *        skill_under_test, task_set_id, task_set_version, judge_model,
 *        rubric_sha256, per_criterion_scores[], weighted_aggregate, verdict,
 *        cost_usd, recorded_at, recorder)
 *   schemas/evolve/task-set/v1.schema.json        (D_train/D_val split, frozen
 *        D_val per cycle via evalset_version stamping, held-out T_test)
 *
 * Red-leg mutation proof per §4.7: the rejection battery plants malformed
 * records (one per constraint) and asserts the validator refuses each —
 * including the parametric drop-every-required-field sweep derived from the
 * schema document itself, which also proves validator↔schema coordination.
 *
 * Golden fixtures under test/fixtures/evolve/ are the acceptance side.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadSchemaDoc, EVOLVE_SCHEMA_NAMES } from '../src/evolve/schema-docs.ts';
import { SUPPORTED_KEYWORDS, evaluate } from '../src/evolve/schema-engine.ts';
import { validateJudgmentRecord, JUDGMENT_FIELD_ORDER } from '../src/evolve/judgment.ts';
import { validateTaskSet, TASK_SET_FIELD_ORDER } from '../src/evolve/task-set.ts';
import { validateAuditEntry, AUDIT_FIELD_ORDER } from '../src/evolve/audit.ts';
import type { EvolveSchemaName } from '../src/evolve/schema-docs.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = join(__dirname, 'fixtures/evolve');

/** Master intake §5.4 field list, verbatim and complete. */
const JUDGMENT_REQUIRED_FIELDS = [
  'judgment_id',
  'run_id',
  'candidate_overlay_sha256',
  'skill_under_test',
  'task_set_id',
  'task_set_version',
  'judge_model',
  'rubric_sha256',
  'per_criterion_scores',
  'weighted_aggregate',
  'verdict',
  'cost_usd',
  'recorded_at',
  'recorder',
] as const;

const AUDIT_REQUIRED_FIELDS = ['metadata', 'target_skill', 'unified_diff', 'score', 'verdict'] as const;
const TASK_SET_REQUIRED_FIELDS = ['task_set_id', 'evalset_version', 'skill_under_test', 'd_train', 'd_val', 't_test'] as const;

type FixtureName = 'judgment-record-v1.golden.json' | 'task-set-v1.golden.json' | 'audit-entry-v1.golden.json';

function loadFixture(name: FixtureName): unknown {
  return JSON.parse(readFileSync(join(fixtures, name), 'utf8'));
}

const SCHEMA_VERSIONS: Record<EvolveSchemaName, number> = {
  'audit-entry': 1,
  'judgment-record': 1,
  'task-set': 1,
};

void test('schema docs: every evolve schema is present, draft-2020-12 and version-stamped in $id', () => {
  for (const name of EVOLVE_SCHEMA_NAMES) {
    const version = SCHEMA_VERSIONS[name];
    const doc = loadSchemaDoc(name, version);
    assert.equal(doc.$schema, 'https://json-schema.org/draft/2020-12/schema', name);
    assert.equal(
      doc.$id,
      `urn:ai-catapult:evolve:${name}:v${version}`,
      `${name} must be version-stamped in its $id`,
    );
  }
});

void test('schema docs: judgment-record v1 required fields are exactly the master §5.4 list', () => {
  const doc = loadSchemaDoc('judgment-record', 1);
  assert.deepEqual(doc.required, JUDGMENT_REQUIRED_FIELDS);
  assert.deepEqual(JUDGMENT_FIELD_ORDER, JUDGMENT_REQUIRED_FIELDS);
  assert.equal(doc.additionalProperties, false);
  // per-criterion item shape: {criterion, score} with score within [0, 1].
  const item = doc.properties?.['per_criterion_scores']?.items;
  assert.deepEqual(item?.required, ['criterion', 'score']);
  assert.deepEqual(item?.properties?.['score']?.minimum, 0);
  assert.deepEqual(item?.properties?.['score']?.maximum, 1);
});

void test('schema docs: audit-entry v1 carries the append-only audit elements; verdict enum Accepted/Rejected', () => {
  const auditDoc = loadSchemaDoc('audit-entry', 1);
  assert.deepEqual(auditDoc.required, AUDIT_REQUIRED_FIELDS);
  assert.deepEqual(AUDIT_FIELD_ORDER, AUDIT_REQUIRED_FIELDS);
  assert.deepEqual(auditDoc.properties?.['verdict']?.enum, ['Accepted', 'Rejected']);
  assert.equal(auditDoc.additionalProperties, false);
  // score carries the judge aggregate + the rubric it was computed under.
  assert.deepEqual(auditDoc.properties?.['score']?.properties?.['weighted_aggregate']?.type, 'number');

  // The judgment record uses the same verdict vocabulary.
  const judgmentDoc = loadSchemaDoc('judgment-record', 1);
  assert.deepEqual(judgmentDoc.properties?.['verdict']?.enum, ['Accepted', 'Rejected']);
});

void test('schema docs: task-set v1 represents the frozen D_val and held-out T_test semantics', () => {
  const doc = loadSchemaDoc('task-set', 1);
  assert.deepEqual(doc.required, TASK_SET_REQUIRED_FIELDS);
  assert.deepEqual(TASK_SET_FIELD_ORDER, TASK_SET_REQUIRED_FIELDS);
  // evalset_version is the frozen-per-cycle stamp: integer, at least 1.
  assert.deepEqual(doc.properties?.['evalset_version']?.type, 'integer');
  assert.deepEqual(doc.properties?.['evalset_version']?.minimum, 1);
  // Documented §5.4 semantics ride the schema document itself.
  const description = String(doc.description ?? '');
  assert.ok(description.includes('D_val frozen per cycle'), 'description must state frozen-D_val semantics');
  assert.ok(description.includes('never compared across versions'), 'description must state cross-version rule');
  assert.ok(description.includes('T_test'), 'description must name the held-out T_test reservation');
});

void test('schema docs: every schema keyword used is inside the deterministic engine subset', () => {
  for (const name of EVOLVE_SCHEMA_NAMES) {
    const doc = loadSchemaDoc(name, SCHEMA_VERSIONS[name]);
    collectKeywords(doc).forEach((keyword) => {
      assert.ok(
        (SUPPORTED_KEYWORDS as readonly string[]).includes(keyword),
        `${name} uses unsupported keyword "${keyword}" — extend the engine subset deliberately or change the doc`,
      );
    });
  }
});

/** Depth-first collection of all JSON-Schema keywords a document relies on.
 *
 * Schema-doc keys that open nesting are recursed into; declaration metadata
 * keys are skipped. Keyword VALUES (strings, arrays of strings, numbers) add
 * nothing on recursion because they are not object-like.
 */
function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const SKIP_KEYS = ['properties', '$schema', '$id', 'title'];

function collectKeywords(node: unknown, acc: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((entry) => collectKeywords(entry, acc));
    return acc;
  }
  if (!isObjectLike(node)) {
    return acc;
  }
  for (const [key] of Object.entries(node)) {
    if (SKIP_KEYS.includes(key)) continue;
    acc.push(key);
  }
  // The two nesting points a schema document may use.
  const nested: unknown[] = [node.items, node.additionalProperties];
  if (isObjectLike(node.properties)) {
    nested.push(...Object.values(node.properties));
  }
  nested.filter(isObjectLike).forEach((value) => collectKeywords(value, acc));
  return acc;
}

void test('golden fixtures: all three valid records validate clean', () => {
  validateJudgmentRecord(loadFixture('judgment-record-v1.golden.json'));
  validateTaskSet(loadFixture('task-set-v1.golden.json'));
  validateAuditEntry(loadFixture('audit-entry-v1.golden.json'));
});

void test('judgment-record: dropping any required field is refused (parametric validator↔schema proof)', () => {
  const golden = loadFixture('judgment-record-v1.golden.json') as Record<string, unknown>;
  for (const field of JUDGMENT_REQUIRED_FIELDS) {
    const broken = { ...golden };
    delete broken[field];
    assert.throws(() => validateJudgmentRecord(broken), (err: unknown) => {
      if (!(err instanceof Error)) return false;
      assert.ok(err.message.includes(field), `missing "${field}" must be named: ${err.message}`);
      return true;
    }, `missing field: ${field}`);
  }
  // The engine agrees with the schema doc on the required list.
  assert.deepEqual(
    evaluate(golden, loadSchemaDoc('judgment-record', 1)),
    [],
    'the golden record must also satisfy the schema document directly',
  );
});

void test('judgment-record: malformed records are refused field-by-field (mutation battery)', () => {
  const golden = loadFixture('judgment-record-v1.golden.json') as Record<string, unknown>;
  const mutations: Array<[string, Record<string, unknown>]> = [
    ['unknown field', { ...golden, extra: 'not allowed' }],
    ['verdict outside enum', { ...golden, verdict: 'Rollback' }],
    ['verdict lowercase (enum is exact)', { ...golden, verdict: 'accepted' }],
    ['sha256 pattern', { ...golden, candidate_overlay_sha256: 'not-a-hash' }],
    ['sha256 wrong length', { ...golden, rubric_sha256: 'ab'.repeat(20) }],
    ['task_set_version not integer', { ...golden, task_set_version: '1' }],
    ['cost_usd negative', { ...golden, cost_usd: -0.01 }],
    ['weighted_aggregate above 1', { ...golden, weighted_aggregate: 1.01 }],
    ['weighted_aggregate below 0', { ...golden, weighted_aggregate: -0.1 }],
    ['score out of range', { ...golden, per_criterion_scores: [{ criterion: 'x', score: 2 }] }],
    ['per_criterion empty', { ...golden, per_criterion_scores: [] }],
    ['per_criterion missing score', { ...golden, per_criterion_scores: [{ criterion: 'x' }] }],
    ['empty judgment_id', { ...golden, judgment_id: '' }],
    ['recorded_at not a date-time', { ...golden, recorded_at: 'yesterday' }],
    ['recorded_at impossible calendar date', { ...golden, recorded_at: '2026-02-30T00:00:00Z' }],
    ['own constructor property', { ...golden, constructor: 'nope' }],
    ['run_id wrong shape', { ...golden, run_id: 'Run 2026!' }],
  ];
  for (const [label, record] of mutations) {
    assert.throws(() => validateJudgmentRecord(record), Error, `must refuse: ${label}`);
  }
  // Inherited fields are not the record's own fields, even when `in` would say so.
  assert.throws(() => validateJudgmentRecord(Object.create(golden)), Error, 'inherited fields must not satisfy required');
  const ownProto = { ...golden };
  Object.defineProperty(ownProto, '__proto__', { value: { admin: true }, enumerable: true, configurable: true, writable: true });
  assert.throws(() => validateJudgmentRecord(ownProto), Error, 'own __proto__ must be refused');
});

void test('date-time: valid early years are accepted; impossible calendar dates stay refused across eras', () => {
  const golden = loadFixture('judgment-record-v1.golden.json') as Record<string, unknown>;
  // RFC 3339 years are four digits. Date.UTC maps years 0–99 onto 1900–1999,
  // which rejected valid early years; the calendar check must keep the literal
  // year (setUTCFullYear) without that remapping.
  validateJudgmentRecord({ ...golden, recorded_at: '0099-02-28T00:00:00Z' });
  validateJudgmentRecord({ ...golden, recorded_at: '0004-02-29T00:00:00Z' }); // year 4 is a leap year
  const impossible: readonly string[] = [
    '0099-02-29T00:00:00Z', // year 99 is not a leap year
    '0100-02-29T00:00:00Z', // century years need division by 400
    '2026-02-30T00:00:00Z',
  ];
  for (const recordedAt of impossible) {
    assert.throws(
      () => validateJudgmentRecord({ ...golden, recorded_at: recordedAt }),
      Error,
      `${recordedAt} must be refused`,
    );
  }
});

void test('task-set: malformed task sets are refused (splitting, stamping and partition rules)', () => {
  const golden = loadFixture('task-set-v1.golden.json') as Record<string, unknown>;
  const mutations: Array<[string, Record<string, unknown>]> = [
    ['missing evalset_version stamp', { ...golden, evalset_version: undefined }],
    ['evalset_version zero', { ...golden, evalset_version: 0 }],
    ['evalset_version float', { ...golden, evalset_version: 1.5 }],
    ['empty d_val (invalid split)', { ...golden, d_val: [] }],
    ['extra field', { ...golden, frozen: true }],
    ['case ids not strings', { ...golden, d_train: [17] }],
    ['empty case id', { ...golden, d_val: [''] }],
  ];
  for (const [label, record] of mutations) {
    assert.throws(() => validateTaskSet(record), Error, `must refuse: ${label}`);
  }
  // Partition invariant beyond JSON Schema: a case id must not sit in two splits.
  assert.throws(
    () => validateTaskSet({ ...golden, t_test: ['case-val-1'] }),
    (err: unknown) => err instanceof Error && err.message.includes('case-val-1'),
    'd_val ∩ t_test overlap must be refused',
  );
  assert.throws(
    () => validateTaskSet({ ...golden, d_train: [...(golden.d_train as string[]), 'case-train-1'] }),
    (err: unknown) => err instanceof Error && err.message.includes('duplicate'),
    'duplicate case ids must be refused',
  );
});

void test('task-set: d_train and t_test may be empty — the held-out reservation stays representable', () => {
  validateTaskSet({
    task_set_id: 'ts-min',
    evalset_version: 2,
    skill_under_test: 'wiki-maintainer',
    d_train: [],
    d_val: ['case-val-1'],
    t_test: [],
  });
});

void test('audit-entry: malformed audit entries are refused (mutation battery)', () => {
  const golden = loadFixture('audit-entry-v1.golden.json') as Record<string, unknown>;
  const mutations: Array<[string, Record<string, unknown>]> = [
    ['missing metadata', { ...golden, metadata: undefined }],
    ['extra top-level field', { ...golden, rolled_back: true }],
    ['non-integer cycle', { ...golden, metadata: { ...(golden.metadata as Record<string, unknown>), cycle: 0.5 } }],
    ['metadata recorded_at missing', { ...golden, metadata: { run_id: 'run-x', cycle: 1, recorder: 'r' } }],
    ['verdict lowercase (enum is exact)', { ...golden, verdict: 'accepted' }],
    ['verdict outside enum', { ...golden, verdict: 'RolledBack' }],
    ['empty target_skill', { ...golden, target_skill: '' }],
    ['score aggregate out of range', { ...golden, score: { ...(golden.score as Record<string, unknown>), weighted_aggregate: 1.5 } }],
    ['score refuses extra fields', { ...golden, score: { ...(golden.score as Record<string, unknown>), ok: true } }],
  ];
  for (const [label, entry] of mutations) {
    assert.throws(() => validateAuditEntry(entry), Error, `must refuse: ${label}`);
  }
});

void test('engine: evaluate() accepts the golden fixtures against their own schema documents', () => {
  const pairs: Array<[EvolveSchemaName, FixtureName]> = [
    ['judgment-record', 'judgment-record-v1.golden.json'],
    ['task-set', 'task-set-v1.golden.json'],
    ['audit-entry', 'audit-entry-v1.golden.json'],
  ];
  for (const [name, fixture] of pairs) {
    const doc = loadSchemaDoc(name, SCHEMA_VERSIONS[name]);
    assert.deepEqual(evaluate(loadFixture(fixture), doc), [], `${fixture} vs ${name}`);
    // And a scalar is never a record.
    assert.equal(evaluate(17, doc).length > 0, true, `${name} must refuse a scalar`);
    assert.equal(evaluate(null, doc).length > 0, true, `${name} must refuse null`);
  }
});