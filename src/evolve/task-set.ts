/**
 * The task-set record (AC-4) — the D_train/D_val split with the frozen-D_val
 * per-cycle semantics and the held-out T_test reservation, as representable
 * data: evalset_version stamps the frozen split (scores are never compared
 * across versions) and T_test cases stay reserved for final reporting.
 *
 * validateTaskSet() evaluates the record against its versioned schema document
 * (schemas/evolve/task-set/v1.schema.json) and then enforces the partition
 * invariant the JSON document cannot express alone: a case id must be unique
 * within its split and must not sit in two splits at once. d_train and t_test
 * may be empty; d_val carries at least one case by schema.
 */
import { EvolveError } from './errors.ts';
import { isArrayValue } from './records.ts';
import { evaluate, throwIfViolations } from './schema-engine.ts';
import { loadSchemaDoc } from './schema-docs.ts';

/** The task-set field order (master §5.4 splitting fields), fixed for serialization. */
export const TASK_SET_FIELD_ORDER = ['task_set_id', 'evalset_version', 'skill_under_test', 'd_train', 'd_val', 't_test'] as const;

const SCHEMA_NAME = 'task-set' as const;
const SCHEMA_VERSION = 1;

export function validateTaskSet(record: unknown): void {
  throwIfViolations('task set', evaluate(record, loadSchemaDoc(SCHEMA_NAME, SCHEMA_VERSION)));
  assertCasePartition(record);
}

/**
 * The partition invariant beyond JSON Schema: every case id appears exactly
 * once across the three splits. A repeat inside one split is a duplicate; a
 * repeat across splits means the splits no longer partition the case pool.
 */
function assertCasePartition(record: unknown): void {
  const splitByCase = new Map<string, string>();
  for (const [splitName, caseIds] of splitLists(record)) {
    const seenInSplit = new Set<string>();
    for (const caseId of caseIds) {
      if (seenInSplit.has(caseId)) {
        throw new EvolveError(
          'schema-violation',
          `task set rejected: duplicate case id "${caseId}" inside ${splitName}`,
        );
      }
      seenInSplit.add(caseId);
      const earlierSplit = splitByCase.get(caseId);
      if (earlierSplit !== undefined) {
        throw new EvolveError(
          'schema-violation',
          `task set rejected: case id "${caseId}" appears in both ${earlierSplit} and ${splitName}; the splits must partition the cases`,
        );
      }
      splitByCase.set(caseId, splitName);
    }
  }
}

function splitLists(record: unknown): Array<readonly [string, readonly string[]]> {
  const fields: Record<string, unknown> = typeof record === 'object' && record !== null ? (record as Record<string, unknown>) : {};
  return [
    ['d_train', stringList(fields['d_train'])],
    ['d_val', stringList(fields['d_val'])],
    ['t_test', stringList(fields['t_test'])],
  ];
}

/** Narrow one split list; the schema already validated the shape, this is the typed view. */
function stringList(value: unknown): string[] {
  const items: string[] = [];
  if (isArrayValue(value)) {
    for (const item of value) {
      if (typeof item === 'string') items.push(item);
    }
  }
  return items;
}
