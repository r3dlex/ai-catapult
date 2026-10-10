/**
 * proposals/ overlay staging (AC-1). One replaceable file per skill:
 * proposals/<skill>.overlay. Overlays are not write-once traces — a later
 * stage of the same skill replaces the bytes. The write runs against the
 * verified proposals/ directory inode, so symlinks (at the file or at any
 * ancestor component) are refused before any external byte changes.
 */
import { join } from 'node:path';
import { enterDirectory, replaceFileHere, withBoundRoot } from './containment.ts';
import { EvolveError } from './errors.ts';
import { EVOLVE_DIR, type EvolvePaths } from './layout.ts';

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
  const target = join(paths.proposalsDir, `${skillName}.overlay`);
  withBoundRoot(paths.root, (anchor) => {
    const evolve = enterDirectory(EVOLVE_DIR, anchor);
    enterDirectory('proposals', evolve);
    replaceFileHere(`${skillName}.overlay`, contents);
  });
  return { path: target };
}
