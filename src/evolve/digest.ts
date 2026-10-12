/**
 * The one digest primitive the evolve modules share: sha256 as lowercase hex.
 * Recorded {sha256} values are digests of the exact written bytes, so callers
 * can pin what landed on disk against what was returned.
 */
import { createHash } from 'node:crypto';

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
