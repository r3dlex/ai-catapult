/**
 * Deterministic JSON-Schema subset evaluator for the versioned evolve schemas.
 *
 * The engine deliberately implements one declared keyword subset
 * (SUPPORTED_KEYWORDS). It is total and synchronous: evaluate() returns every
 * violation it finds as path-qualified messages and never throws; the schema
 * documents themselves are loaded by schema-docs.ts. Types are narrowed via
 * JSON guards (records.ts) and unknown type names fail closed.
 */
import type { EvolveSchemaDoc } from './schema-docs.ts';
import { isArrayValue, isRecord } from './records.ts';
import { EvolveError } from './errors.ts';

/**
 * Keywords the engine recognises. A schema document may only use keywords from
 * this list (enforced by test/evolve-schemas.test.ts): extending it must come
 * with deliberate engine support, not silent acceptance.
 *
 * 'properties' is the structural nesting key the engine interprets directly;
 * 'date-time' names the one supported `format` value; 'description' rides the
 * documents as prose the engine intentionally does not enforce.
 */
export const SUPPORTED_KEYWORDS = [
  'additionalProperties',
  'date-time',
  'description',
  'enum',
  'format',
  'items',
  'maxLength',
  'maximum',
  'minItems',
  'minimum',
  'minLength',
  'pattern',
  'properties',
  'required',
  'type',
] as const;

const DATE_TIME_PARTS =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$/;

/**
 * Evaluate `value` against a schema document; returns one message per
 * violation. An empty list means the value satisfies the document.
 */
export function evaluate(value: unknown, schema: EvolveSchemaDoc, path: string = ''): string[] {
  const violations: string[] = [];
  evaluateNode(value, schema, path, violations);
  return violations;
}

/** The validators' shared refusal: a non-empty violation list fails closed. */
export function throwIfViolations(subject: string, violations: readonly string[]): void {
  if (violations.length > 0) {
    throw new EvolveError('schema-violation', `${subject} rejected by its schema: ${violations.join('; ')}`);
  }
}

function evaluateNode(value: unknown, schema: EvolveSchemaDoc, path: string, violations: string[]): void {
  evaluateType(value, schema, path, violations);
  evaluateEnum(value, schema, path, violations);
  if (typeof value === 'string') evaluateString(value, schema, path, violations);
  if (typeof value === 'number') evaluateNumber(value, schema, path, violations);
  evaluateFormat(value, schema, path, violations);
  if (isArrayValue(value)) evaluateArray(value, schema, path, violations);
  if (isRecord(value)) evaluateObject(value, schema, path, violations);
}

function evaluateType(value: unknown, schema: EvolveSchemaDoc, path: string, violations: string[]): void {
  const type = schema.type;
  if (type === undefined) return;
  const names = typeof type === 'string' ? [type] : [...type];
  if (names.some((name) => isJsonType(value, name))) return;
  violations.push(`${pathLabel(path)} must be of type ${names.join(' or ')}`);
}

function isJsonType(value: unknown, name: string): boolean {
  if (name === 'string') return typeof value === 'string';
  if (name === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (name === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (name === 'boolean') return typeof value === 'boolean';
  if (name === 'array') return isArrayValue(value);
  if (name === 'null') return value === null;
  if (name === 'object') return isRecord(value);
  return false; // unknown type name: fail closed
}

function evaluateEnum(value: unknown, schema: EvolveSchemaDoc, path: string, violations: string[]): void {
  const choices = schema.enum;
  if (choices === undefined) return;
  if (!choices.includes(value)) {
    violations.push(`${pathLabel(path)} must be one of ${JSON.stringify(choices)}`);
  }
}

function evaluateString(value: string, schema: EvolveSchemaDoc, path: string, violations: string[]): void {
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    violations.push(`${pathLabel(path)} must have at least ${schema.minLength} characters`);
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    violations.push(`${pathLabel(path)} must have at most ${schema.maxLength} characters`);
  }
  if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
    violations.push(`${pathLabel(path)} must match /${schema.pattern}/`);
  }
}

function evaluateNumber(value: number, schema: EvolveSchemaDoc, path: string, violations: string[]): void {
  if (schema.minimum !== undefined && value < schema.minimum) {
    violations.push(`${pathLabel(path)} must be >= ${schema.minimum}`);
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    violations.push(`${pathLabel(path)} must be <= ${schema.maximum}`);
  }
}

function evaluateFormat(value: unknown, schema: EvolveSchemaDoc, path: string, violations: string[]): void {
  const format = schema.format;
  if (format === undefined) return;
  if (format !== 'date-time') {
    violations.push(`${pathLabel(path)} uses the unsupported format "${format}"`);
    return;
  }
  if (typeof value !== 'string' || !isRfc3339DateTime(value)) {
    violations.push(`${pathLabel(path)} must be an RFC 3339 date-time`);
  }
}

/** Calendar fields must exist. Date.parse alone normalizes 2026-02-30 to March. */
function isRfc3339DateTime(value: string): boolean {
  const parts = dateTimeParts(value);
  if (parts === null || !isRealUtcDate(parts)) return false;
  return Number.isFinite(Date.parse(value));
}

function dateTimeParts(value: string): number[] | null {
  const match = DATE_TIME_PARTS.exec(value);
  if (match === null) return null;
  const parts: number[] = [];
  for (let index = 1; index <= 6; index += 1) {
    const text = match[index];
    if (text === undefined) return null;
    parts.push(Number(text));
  }
  return parts;
}

function isRealUtcDate(parts: readonly number[]): boolean {
  const fields = readDateFields(parts);
  if (fields === null || !clockInRange(fields)) return false;
  // Date.UTC maps years 0–99 onto 1900–1999, which rejected valid early years.
  // setUTCFullYear sets the literal year, so 0099-02-28 stays 99 AD and an
  // impossible date still normalizes to a different month/day and is refused.
  const utc = new Date(0);
  utc.setUTCFullYear(fields.year, fields.month - 1, fields.day);
  return utc.getUTCFullYear() === fields.year && utc.getUTCMonth() === fields.month - 1 && utc.getUTCDate() === fields.day;
}

function readDateFields(parts: readonly number[]): { year: number; month: number; day: number; hour: number; minute: number; second: number } | null {
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];
  const hour = parts[3];
  const minute = parts[4];
  const second = parts[5];
  if (year === undefined || month === undefined || day === undefined) return null;
  if (hour === undefined || minute === undefined || second === undefined) return null;
  return { year, month, day, hour, minute, second };
}

function clockInRange(fields: { month: number; day: number; hour: number; minute: number; second: number }): boolean {
  return fields.month >= 1 && fields.month <= 12 && fields.day >= 1 && fields.hour <= 23 && fields.minute <= 59 && fields.second <= 59;
}

function evaluateArray(value: readonly unknown[], schema: EvolveSchemaDoc, path: string, violations: string[]): void {
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    violations.push(`${pathLabel(path)} must have at least ${schema.minItems} items`);
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    violations.push(`${pathLabel(path)} must have at most ${schema.maxItems} items`);
  }
  const itemSchema = schema.items;
  if (itemSchema === undefined) return;
  value.forEach((element, index) => {
    evaluateNode(element, itemSchema, `${pathLabel(path)}[${index}]`, violations);
  });
}

function evaluateObject(value: Record<string, unknown>, schema: EvolveSchemaDoc, path: string, violations: string[]): void {
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(value, key)) {
      violations.push(requiredMessage(path, key));
    }
  }
  const props = schema.properties ?? {};
  for (const [key, propSchema] of Object.entries(props)) {
    if (Object.hasOwn(value, key)) {
      evaluateNode(value[key], propSchema, childPath(path, key), violations);
    }
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      // `in` is true for inherited names (constructor, __proto__). Own keys only.
      if (!Object.hasOwn(props, key)) {
        violations.push(`${childPath(path, key)} must not be present (additionalProperties is false)`);
      }
    }
  }
}

function pathLabel(path: string): string {
  return path === '' ? 'the root value' : path;
}

function childPath(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

function requiredMessage(path: string, key: string): string {
  const prefix = path === '' ? '' : `${path}: `;
  return `${prefix}required field "${key}" is missing`;
}
