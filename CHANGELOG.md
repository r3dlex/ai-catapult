# Changelog

All notable changes to `ai-catapult` are recorded here. Versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file starts at 0.5.0. Releases up to and including 0.4.4 shipped without a
changelog; their history is recoverable from the git log between
[v0.4.3](https://github.com/r3dlex/ai-catapult/compare/v0.4.2...v0.4.3) and
[v0.4.4](https://github.com/r3dlex/ai-catapult/compare/v0.4.3...v0.4.4).

## [0.5.0] - 2026-10-20

Minor release. Every commit since `v0.4.4` is additive: 5 `feat:` commits, 1
`chore:` commit and 2 `plan:` commits, with no breaking changes, no dependency
bumps and no removals.

### Features

- Deterministic three-layer workspace and versioned schemas for `evolve`
  (tswc-ac-b1) — [#63](https://github.com/r3dlex/ai-catapult/pull/63)
- Recorded-judgment gate for `evolve --validate` (tswc-ac-b3) —
  [#70](https://github.com/r3dlex/ai-catapult/pull/70)
- Stub upstream flow for an accepted overlay (tswc-ac-b4) —
  [#71](https://github.com/r3dlex/ai-catapult/pull/71)
- Pre-reject gnarly skill proposals before the judge seam (tswc-ac-b5) —
  [#72](https://github.com/r3dlex/ai-catapult/pull/72)
- `backfill` refuses relocated write directories and requires a canonical root
  (FSC-01) — [#76](https://github.com/r3dlex/ai-catapult/pull/76)

### Chores

- Sync vendored skills `28f813bf` → `848a3dd6` and stage the README shim
  runtime (AF06-C-01) — [#74](https://github.com/r3dlex/ai-catapult/pull/74)

### Planning

- Publish the `af-06-catapult-local-ci` planning generation (af-06 PR 2,
  add-only) — [#73](https://github.com/r3dlex/ai-catapult/pull/73)
- Publish the `fs-c-residual-catapult` planning generation (ADR-0013 (c)
  follow-up, narrowed per human, add-only) —
  [#75](https://github.com/r3dlex/ai-catapult/pull/75)

[0.5.0]: https://github.com/r3dlex/ai-catapult/compare/v0.4.4...v0.5.0
