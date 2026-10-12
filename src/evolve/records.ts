/**
 * JSON record primitives shared by the evolve modules: narrowing guards and
 * the canonical field-ordering mechanism the deterministic serializers use.
 *
 * Recorded bytes must depend only on the data, never on the key insertion
 * order of the input record, so every serializer rebuilds its records in a
 * fixed field order via canonicalFields() before stringifying.
 */

/** A JSON object (not an array, not null) as a string-keyed record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A JSON array as a readonly element sequence. */
export function isArrayValue(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * Rebuild a record with fields in the given fixed order. Absent fields are
 * carried as `undefined`, which JSON.stringify omits, so serialization of a
 * valid record is byte-identical regardless of input key order.
 */
export function canonicalFields(source: unknown, order: readonly string[]): Record<string, unknown> {
  const record = isRecord(source) ? source : {};
  const canonical: Record<string, unknown> = {};
  for (const field of order) {
    canonical[field] = record[field];
  }
  return canonical;
}
