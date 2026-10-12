/**
 * Write-once machinery for evolve/raw/<run-id>/ (AC-1): the first write to a
 * trace path wins; any second write is refused — even with identical bytes.
 * Run ids and trace names are validated fail-closed before anything is
 * created on disk, and the write itself runs against the verified directory
 * inode (containment.ts), so no symlink swapped in at any component can
 * redirect it.
 */
import { join } from 'node:path';
import { createFileHere, enterDirectory, enterOrCreateDirectory, withBoundRoot } from './containment.ts';
import { EvolveError, nodeErrorCode } from './errors.ts';
import { EVOLVE_DIR, RUN_ID_PATTERN, type EvolvePaths } from './layout.ts';
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
  const target = join(paths.rawDir, runId, traceName);
  return withBoundRoot(paths.root, (anchor) => {
    const evolve = enterDirectory(EVOLVE_DIR, anchor);
    const raw = enterDirectory('raw', evolve);
    enterOrCreateDirectory(runId, raw);
    try {
      // O_EXCL refuses any existing file, even one carrying identical bytes.
      // O_NOFOLLOW refuses a symlink planted at the trace path.
      createFileHere(traceName, contents);
    } catch (error) {
      if (nodeErrorCode(error) === 'EEXIST') {
        throw new EvolveError(
          'write-once-violation',
          `raw trace ${runId}/${traceName} already exists; write-once records are never overwritten, even with identical bytes`,
          { cause: error },
        );
      }
      throw error;
    }
    return {
      path: target,
      sha256: sha256Hex(Buffer.from(contents, 'utf8')),
      bytes: Buffer.byteLength(contents, 'utf8'),
    };
  });
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
