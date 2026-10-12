/**
 * The audit-entry record (AC-2) — one append-only entry of the skill audit
 * trail: metadata, target skill, unified diff, score, Accepted/Rejected.
 *
 * validateAuditEntry() evaluates the entry against its versioned schema
 * document (schemas/evolve/audit-entry/v1.schema.json) and fails closed on any
 * violation. renderAuditEntryBlock() formats the entry deterministically as a
 * single fenced json block — top-level fields in the fixed order, metadata and
 * score canonicalised in their fixed field orders too — so the appended bytes
 * depend only on the data and never on input key order.
 * appendAuditEntry() validates first, then appends the rendered block to
 * wiki/skill-impact.md through the append-only machinery: entries extend the
 * trail in order and are never rewritten or rolled back.
 */
import type { EvolvePaths } from './layout.ts';
import { appendWikiFile, type AppendedWikiFile } from './append-only.ts';
import { canonicalFields } from './records.ts';
import { evaluate, throwIfViolations } from './schema-engine.ts';
import { loadSchemaDoc } from './schema-docs.ts';

/** The audit-entry field order (master §5.4 audit elements), fixed for rendering. */
export const AUDIT_FIELD_ORDER = ['metadata', 'target_skill', 'unified_diff', 'score', 'verdict'] as const;

/** Canonical field order inside the audit metadata block. */
const AUDIT_METADATA_FIELD_ORDER = ['run_id', 'cycle', 'recorded_at', 'recorder'] as const;

/** Canonical field order inside the audit score block. */
const AUDIT_SCORE_FIELD_ORDER = ['weighted_aggregate', 'rubric_sha256'] as const;

const SCHEMA_NAME = 'audit-entry' as const;
const SCHEMA_VERSION = 1;

export function validateAuditEntry(entry: unknown): void {
  throwIfViolations('audit entry', evaluate(entry, loadSchemaDoc(SCHEMA_NAME, SCHEMA_VERSION)));
}

export function renderAuditEntryBlock(entry: unknown): string {
  const canonical = canonicalFields(entry, AUDIT_FIELD_ORDER);
  canonical.metadata = canonicalFields(canonical.metadata, AUDIT_METADATA_FIELD_ORDER);
  canonical.score = canonicalFields(canonical.score, AUDIT_SCORE_FIELD_ORDER);
  return `\`\`\`json\n${JSON.stringify(canonical)}\n\`\`\`\n`;
}

export function appendAuditEntry(paths: EvolvePaths, entry: unknown): AppendedWikiFile {
  validateAuditEntry(entry);
  return appendWikiFile(paths, 'skill-impact.md', renderAuditEntryBlock(entry));
}
