import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute directory of the module file behind an `import.meta.url` value. */
export function moduleDir(importMetaUrl: string): string {
  return dirname(fileURLToPath(importMetaUrl));
}

/**
 * Walks up from `fromDir` to the nearest directory containing `package.json`
 * and returns it. Both source-layout and compiled-layout callers land on the
 * package root: `dist/scripts/x.js` walks dist → package root, mirroring the
 * `dirname "$0"` walks the old shell scripts did from their own locations.
 *
 * Fails closed: throws when no package.json exists above `fromDir`.
 */
export function packageRoot(fromDir: string): string {
  let dir = fromDir;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`package.json not found walking up from ${fromDir}`);
    }
    dir = parent;
  }
}