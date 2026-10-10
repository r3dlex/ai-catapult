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

const ISO_DATE_TIME =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$/;

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
  const printable = typeof value === 'string' ? value : '';
  if (typeof value !== 'string' || !ISO_DATE_TIME.test(printable) || !Number.isFinite(Date.parse(printable))) {
    violations.push(`${pathLabel(path)} must be an RFC 3339 date-time`);
  }
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
    if (!(key in value)) {
      violations.push(requiredMessage(path, key));
    }
  }
  const props = schema.properties ?? {};
  for (const [key, propSchema] of Object.entries(props)) {
    if (key in value) {
      evaluateNode(value[key], propSchema, childPath(path, key), violations);
    }
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in props)) {
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
