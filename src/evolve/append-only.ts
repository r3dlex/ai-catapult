/**
 * Append-only wiki machinery (AC-1): wiki/ entries may only extend the file's
 * byte prefix. assertAppendOnly is the invariant primitive behind the
 * transition matrix; appendWikiFile is the only write path into wiki/logs.md
 * and wiki/skill-impact.md — it refuses to create a missing wiki file instead
 * of silently materialising one.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { EvolveError } from './errors.ts';
import type { EvolvePaths } from './layout.ts';
import { sha256Hex } from './digest.ts';

export type WikiFileName = 'logs.md' | 'skill-impact.md';

export interface AppendedWikiFile {
  readonly path: string;
  readonly sha256: string;
}

/**
 * The append-only transition matrix as a refusal: `after` must equal `before`
 * (an empty append) or extend it as a byte prefix. Truncation, rewriting,
 * prepending — any non-extension — is refused.
 */
export function assertAppendOnly(before: string, after: string): void {
  if (after === before || after.startsWith(before)) return;
  throw new EvolveError(
    'append-only-violation',
    'append-only invariant violated: the new content would truncate, rewrite or prepend existing wiki bytes instead of extending them',
  );
}

export function appendWikiFile(paths: EvolvePaths, which: WikiFileName, entry: string): AppendedWikiFile {
  const target = wikiFilePath(paths, which);
  if (!existsSync(target)) {
    throw new EvolveError(
      'layout-violation',
      `wiki/${which} does not exist; the append-only machinery appends to wiki files but never creates them`,
    );
  }
  const current = readFileSync(target);
  const appended = Buffer.concat([current, Buffer.from(entry, 'utf8')]);
  writeFileSync(target, appended);
  return { path: target, sha256: sha256Hex(appended) };
}

function wikiFilePath(paths: EvolvePaths, which: WikiFileName): string {
  if (which === 'logs.md') return paths.wikiLogsFile;
  if (which === 'skill-impact.md') return paths.wikiSkillImpactFile;
  // Closed union: `which` is `never` here. Do not interpolate it (restrict-template-expressions).
  throw new EvolveError('layout-violation', 'unknown wiki file (expected logs.md or skill-impact.md)');
}
