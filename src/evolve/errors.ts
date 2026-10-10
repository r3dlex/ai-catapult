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
 */
export type EvolveErrorKind =
  | 'append-only-violation'
  | 'layout-violation'
  | 'schema-violation'
  | 'unsafe-path'
  | 'write-once-violation';

export class EvolveError extends Error {
  readonly kind: EvolveErrorKind;

  constructor(kind: EvolveErrorKind, message: string) {
    super(message);
    this.name = 'EvolveError';
    this.kind = kind;
  }
}
