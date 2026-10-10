/**
 * Write-once machinery for evolve/raw/<run-id>/ (AC-1): the first write to a
 * trace path wins; any second write is refused — even with identical bytes.
 * Run ids and trace names are validated fail-closed before anything is
 * created on disk.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EvolveError } from './errors.ts';
import { RUN_ID_PATTERN, type EvolvePaths } from './layout.ts';
import { sha256Hex } from './digest.ts';

/**
 * Trace names are single path segments: no separators, no traversal, no
 * dotfiles, no NUL — anything else is an unsafe path.
 */
const TRACE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface RecordedTrace {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export function recordTrace(paths: EvolvePaths, runId: string, traceName: string, contents: string): RecordedTrace {
  assertRunId(runId);
  assertTraceName(traceName);
  const runDir = join(paths.rawDir, runId);
  mkdirSync(runDir, { recursive: true });
  const target = join(runDir, traceName);
  try {
    // 'wx' refuses any existing file, even one carrying identical bytes:
    // write-once means the first write wins, unconditionally.
    writeFileSync(target, contents, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (isEexist(error)) {
      throw new EvolveError(
        'write-once-violation',
        `raw trace ${runId}/${traceName} already exists; write-once records are never overwritten, even with identical bytes`,
      );
    }
    throw error;
  }
  return {
    path: target,
    sha256: sha256Hex(Buffer.from(contents, 'utf8')),
    bytes: Buffer.byteLength(contents, 'utf8'),
  };
}

function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new EvolveError(
      'unsafe-path',
      `run id "${runId}" must match ${RUN_ID_PATTERN.toString()} (lowercase letters, digits and hyphens only)`,
    );
  }
}

function assertTraceName(traceName: string): void {
  if (!TRACE_NAME_PATTERN.test(traceName)) {
    throw new EvolveError(
      'unsafe-path',
      `trace name "${traceName}" must be a single safe path segment matching ${TRACE_NAME_PATTERN.toString()}`,
    );
  }
}

function isEexist(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EEXIST';
}
