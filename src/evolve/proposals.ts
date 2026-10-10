/**
 * proposals/ overlay staging (AC-1). One replaceable file per skill:
 * proposals/<skill>.overlay. Overlays are not write-once traces — a later
 * stage of the same skill replaces the bytes. Symlinks are refused.
 */
import { join } from 'node:path';
import { assertRealDirectory, writeRegularFile } from './containment.ts';
import { EvolveError } from './errors.ts';
import type { EvolvePaths } from './layout.ts';

/** Skill names are a single lowercase segment. The file suffix is `.overlay`. */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const OVERLAY_FILE_PATTERN = /^[a-z0-9][a-z0-9-]*\.overlay$/;

export interface StagedOverlay {
  readonly path: string;
}

export function stageOverlay(paths: EvolvePaths, skillName: string, contents: string): StagedOverlay {
  if (!SKILL_NAME_PATTERN.test(skillName)) {
    throw new EvolveError(
      'unsafe-path',
      `skill name "${skillName}" must match ${SKILL_NAME_PATTERN.toString()}`,
    );
  }
  assertRealDirectory(paths.proposalsDir);
  const target = join(paths.proposalsDir, `${skillName}.overlay`);
  writeRegularFile(target, contents, true);
  return { path: target };
}
