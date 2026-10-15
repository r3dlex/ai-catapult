/**
 * Evolve workspace errors — the deterministic refusal vocabulary (AC-1/AC-2).
 *
 * Every evolve/ invariant is enforced fail-closed with one of five kinds, so
 * callers and tests can distinguish the reason a write was refused:
 *
 *   layout-violation       the three-layer workspace shape is broken
 *   write-once-violation   a recorded trace/judgment was offered twice
 *   append-only-violation  a wiki transition truncates, rewrites or prepends
 *   schema-violation       a record fails its versioned schema
 *   unsafe-path            a run id / trace name could escape raw/<run-id>/
 *
 * The containment layer (containment.ts) additionally tags its refusals with an
 * optional machine-readable `reason` and the `subject` path it names, so a
 * caller with its own refusal vocabulary (backfill) can map a refusal without
 * matching message text. The five kinds and their meanings are unchanged; a
 * refusal without a reason is exactly what it was before.
 *
 *   relocated          a verified directory is no longer the same directory
 *                      (moved, replaced, removed or turned into a symlink)
 *   symlinked          a component or leaf is a symlink
 *   not-directory      a component that must be a real directory is not one
 *   not-regular-file   a leaf that must be a regular file is not one
 *   multiply-linked    a regular-file leaf has more than one hard link
 *   changed            the directory entry no longer names the opened file
 *
 * A `relocated` refusal is raised whenever a relocation is observed, before or
 * after a write. Declared residual (ADR-0013 (c)): a relocation in effect only
 * inside the interval between the final identity verification and the kernel
 * write, and undone before the next verification, is not observed; the
 * containment layer is not required to detect or defeat that interval, and its
 * own-bytes removals and restorations are best-effort controls, not guarantees,
 * and not single kernel operations.
 */
export type EvolveErrorKind =
  | 'append-only-violation'
  | 'layout-violation'
  | 'schema-violation'
  | 'unsafe-path'
  | 'write-once-violation';

export type EvolveRefusalReason =
  | 'changed'
  | 'multiply-linked'
  | 'not-directory'
  | 'not-regular-file'
  | 'relocated'
  | 'symlinked';

export type EvolveErrorOptions = ErrorOptions & {
  readonly reason?: EvolveRefusalReason;
  readonly subject?: string;
};

export class EvolveError extends Error {
  readonly kind: EvolveErrorKind;
  readonly reason: EvolveRefusalReason | null;
  readonly subject: string | null;

  constructor(kind: EvolveErrorKind, message: string, options?: EvolveErrorOptions) {
    super(message, options);
    this.name = 'EvolveError';
    this.kind = kind;
    this.reason = options?.reason ?? null;
    this.subject = options?.subject ?? null;
  }
}

export function nodeErrorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return null;
}
