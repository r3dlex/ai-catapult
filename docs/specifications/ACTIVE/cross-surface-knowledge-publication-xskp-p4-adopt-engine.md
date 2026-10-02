# P4 — ai-catapult adopt engine (`ai-catapult`, plan `xskp-p4-adopt-engine`)

ID: `XSKP-20261002-P4`
Status: **Planning copy; execution unauthorized**
Execution authorization: **none**. Registration, visibility or discovery never grants approval, readiness or execution authority.

## Umbrella authority

This plan-scoped specification restates one plan of the umbrella specification
`XSKP-20261002` in `r3dlex/ai-tool-workspace` (`docs/specifications/ACTIVE/cross-surface-knowledge-publication.md`),
pinned at sha256 `d50488d9b480fdfdea6c2fa2b7265a507d98fdae97758c3b1d2f501951415586`. Decisions D1–D11, the glossary,
the verbs, the migration gate semantics and the umbrella acceptance criteria
AC-1 to AC-7 are defined there. If this copy and the umbrella spec disagree, the
umbrella spec at the pinned sha wins and this plan's preparation is blocked until
a new planning copy is published.

## Contract pack

`docs/specifications/ACTIVE/cross-surface-knowledge-publication.contract/` beside this file is a byte-identical copy of the frozen contract pack
(pack version 1, 12 files). Its `contract.lock.json` sha256 is `9f5d7edfc17554c383b06aa4726dfffe564ecc8d657b16baa89ce72098d5e102`.
Goal 01 copies it to `.ai/knowledge/contract/` and pins it with a fingerprint
test. It is a planning copy of one frozen contract, not a competing authority:
the lock is the identity.

## Plan

### P4 — ai-catapult adopt engine (`ai-catapult`, plan `xskp-p4-adopt-engine`)

Contract copy. `ai-catapult knowledge <verb>` (Node) passing all conformance
cases. `ai-catapult adopt`: inventory, migration map, confirmation token,
backup, ledger, reference repair, and idempotent rerun across greenfield,
brownfield, partial-v3, legacy-agents and legacy-ai-sdlc layouts and single,
monorepo and umbrella topologies. `init` scaffolds an empty registry. Verified
in three separate lanes: source (`node --test`), packaged (`dist-snapshot`) and
installed runtime (report-only).

## Goals

The authoritative per-goal scope, acceptance, verification and readiness live in
the published `.ai/handoff/readiness-v1/xskp-p4-adopt-engine/<generation>/goals.json` in this
repository, registered in `.ai/workflows/northstar-readiness-v1.json`. No goal
depends on a goal in another plan or repository.
