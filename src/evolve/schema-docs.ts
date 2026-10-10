/**
 * Versioned evolve schema documents (AC-2).
 *
 * Documents live at schemas/evolve/<name>/v<version>.schema.json relative to
 * the package root and are loaded fail-closed: the name must be a known evolve
 * schema, the version a positive integer, the file must exist, the parsed
 * document must be a JSON object carrying the draft-2020-12 marker, and its
 * $id must stamp exactly this name and version. A document that fails any of
 * these refuses to load rather than being silently evaluated as-is.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { moduleDir, packageRoot } from '../paths.ts';
import { isRecord } from './records.ts';

export const EVOLVE_SCHEMA_NAMES = ['audit-entry', 'judgment-record', 'task-set'] as const;
export type EvolveSchemaName = (typeof EVOLVE_SCHEMA_NAMES)[number];

export const SCHEMA_DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

/** The JSON-Schema document shape the deterministic engine evaluates. */
export interface EvolveSchemaDoc {
  readonly $schema: string;
  readonly $id: string;
  readonly description?: string;
  readonly type?: string | readonly string[];
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, EvolveSchemaDoc>>;
  readonly additionalProperties?: boolean;
  readonly enum?: readonly unknown[];
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly items?: EvolveSchemaDoc;
  readonly format?: string;
}

export function loadSchemaDoc(name: EvolveSchemaName, version: number): EvolveSchemaDoc {
  const docPath = schemaDocPath(name, version);
  if (!existsSync(docPath)) {
    throw new Error(`evolve schema document not found: ${docPath}`);
  }
  const doc = parseSchemaDoc(docPath);
  assertIdStamp(doc, name, version);
  return doc;
}

function schemaDocPath(name: EvolveSchemaName, version: number): string {
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`evolve schema version must be a positive integer, got: ${version}`);
  }
  const relative = join('schemas', 'evolve', name, `v${version}.schema.json`);
  return join(packageRoot(moduleDir(import.meta.url)), relative);
}

function parseSchemaDoc(docPath: string): EvolveSchemaDoc {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(docPath, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown parse failure';
    throw new Error(`evolve schema document is unreadable: ${docPath} (${detail})`, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error(`evolve schema document must be a JSON object: ${docPath}`);
  }
  if (parsed['$schema'] !== SCHEMA_DRAFT_2020_12) {
    throw new Error(`evolve schema document must declare the ${SCHEMA_DRAFT_2020_12} marker: ${docPath}`);
  }
  return parsed as unknown as EvolveSchemaDoc;
}

function assertIdStamp(doc: EvolveSchemaDoc, name: EvolveSchemaName, version: number): void {
  const expected = `urn:ai-catapult:evolve:${name}:v${version}`;
  if (doc.$id !== expected) {
    throw new Error(`evolve schema document $id must stamp exactly ${expected}, got: ${doc.$id}`);
  }
}
