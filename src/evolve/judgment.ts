/**
 * The §5.4 judgment record (AC-2/AC-4) — the master provenance record for one
 * judged candidate overlay — and the write-once machinery that pins it under
 * evolve/raw/<run-id>/judgment-<judgment_id>.json (AC-1).
 *
 * validateJudgmentRecord() evaluates the record against its versioned schema
 * document (schemas/evolve/judgment-record/v1.schema.json) and fails closed on
 * any violation. serializeJudgmentRecord() renders the record deterministically
 * in the fixed §5.4 field order — nested per-criterion items included — plus a
 * trailing newline, so the recorded bytes depend only on the data and never on
 * the input key order. recordJudgment() validates first, then pins the
 * serialized bytes through the write-once machinery: a malformed record lands
 * nothing on disk, and a duplicate judgment_id is refused even with identical
 * bytes.
 */
import type { EvolvePaths } from './layout.ts';
import { recordTrace, type RecordedTrace } from './write-once.ts';
import { canonicalFields, isArrayValue } from './records.ts';
import { evaluate, throwIfViolations } from './schema-engine.ts';
import { loadSchemaDoc } from './schema-docs.ts';

/** The master intake §5.4 field list, verbatim and complete. */
export const JUDGMENT_FIELD_ORDER = [
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

/** Canonical field order inside one per-criterion score item. */
const SCORE_ITEM_FIELD_ORDER = ['criterion', 'score'] as const;

const SCHEMA_NAME = 'judgment-record' as const;
const SCHEMA_VERSION = 1;

export function validateJudgmentRecord(record: unknown): void {
  throwIfViolations('judgment record', evaluate(record, loadSchemaDoc(SCHEMA_NAME, SCHEMA_VERSION)));
}

export function serializeJudgmentRecord(record: unknown): string {
  const canonical = canonicalFields(record, JUDGMENT_FIELD_ORDER);
  const scores = canonical.per_criterion_scores;
  canonical.per_criterion_scores = (isArrayValue(scores) ? scores : []).map((item) =>
    canonicalFields(item, SCORE_ITEM_FIELD_ORDER),
  );
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

export function recordJudgment(paths: EvolvePaths, record: unknown): RecordedTrace {
  validateJudgmentRecord(record);
  const fields = record as Record<string, unknown>;
  const runId = fields.run_id as string;
  const judgmentId = fields.judgment_id as string;
  return recordTrace(paths, runId, `judgment-${judgmentId}.json`, serializeJudgmentRecord(record));
}
