# TSWC — ai-catapult lane (`ai-catapult`, plan `tswc-ai-catapult`)

ID: `TSWC-20261004-AI-CATAPULT`
Status: **Planning copy; execution unauthorized**
Execution authorization: **none**. Registration, visibility or discovery never grants
approval, readiness or execution authority.

## Umbrella authority

This plan-scoped specification restates one repo-scoped lane of the work intake
"TypeScript transformation + code-metrics gates + WikiSkill evolution loop" (TSWC) held at
the umbrella workspace `r3dlex/ai-tool-workspace`:
`AiTool/.ai/work-intake/typescript-wikiskill-convergence.md`, pinned at sha256
`c29fafd30db7a06c4e7218cca745fec818eb087955c0b32cf57207c9b7b0d65c` (byte-level pin; the
file is a root-workspace work-intake record, untracked at planning time), and scoped by
`AiTool/.ai/work-intake/tswc-ai-catapult.md` (sha256
`f3b256a2e4a31d8103971687fe872d810c636759a1d499cc6296e191ca6fba04`). Master §0 corrections
are binding over any earlier wording. If this copy and the pinned master intake disagree,
the master intake at the pinned bytes wins and this plan's preparation is blocked until a
new planning copy is published.

References that are **not** threshold sources: WikiSkill (Tang et al., Google Research,
`arXiv:2608.27454v1 [cs.AI]`, 27 Aug 2026) supplies the three-layer workspace, the role
loop and validation gate Eq. 4 only — no complexity/lint/type/coverage value may be cited
to it (master §3a). OKF v0.3 (`docs/learning/okf-v0.3-draft.md` upstream of this repo) is
advisory-only; conformance is an explicit non-goal (master §3b).

## Locked decisions (restated; master §4 is normative)

1. **TS depth (user, 2026-10-04):** full `.ts` conversion of ai-catapult — all ~39 `.js`
   (bin/src/scripts + tests) to strict TS with ai-factory-grade flags, `tsc` build step,
   compiled output shipped (packaging-contract change → ADR in
   `docs/architecture/adr/`), zero runtime dependencies preserved (typescript is a devDep).
   Supersedes the earlier checkJs decision (mega-plan D4).
2. **Complexity values (single numbers):** cyclomatic ≤ 10, cognitive ≤ 15. Provenance is
   labeled per master §4.2 (eslint `complexity: 10` and clippy cognitive 15 are labeled
   project decisions — owner: user, 2026-10-04; sonarjs 15 and ruff/Checkstyle/PMD 10 are
   documented tool defaults).
3. **Judge execution:** human-driven out-of-band (the `eval-a-skill` model — CI proves
   declaration, the judge proves quality out-of-band).
4. **Spend ceiling:** $100 per cycle (user, 2026-10-04), enforced at two points (master
   §5.5: structural pre-reject before any judge call; gate accounting veto
   `cycle_budget_exhausted`).
5. **Baseline seeding (F1 fix):** `S_0` = current catalog state; `R_best` = the current
   skill set's validation score; `S_{k-1}` = last accepted state; reject drops the overlay
   while the wiki keeps its learnings (master §4.9).
6. **`R` substrate (F2 fix):** fixed frozen `D_val` per cycle (evalset version stamped;
   scores never compared across versions), held-out `T_test` reserved for final reporting
   only, judgment-provenance record schema (master §5.4) delivered by goal B1, robustness
   via 3 samples + majority/mean within the ceiling.
7. **Red-leg proof (repo convention):** every gate ships a negative fixture or mutation
   asserting the gate catches a violation; the red leg is the gate test failing before the
   fix and passing after, recorded in `.ai/evidence/` (throwaway-worktree pattern; no
   committed breakage) (master §4.7).
8. **Pipeline direction (hard constraint):** `skills/` repo (SSOT, 39-entry catalog) →
   SHA-pinned `vendor/skills` (`skills.lock.json`) → derived per-host payloads
   (`resolveBundledSkills`, fail-closed). Evolution proposals live in overlays until
   accepted, then flow upstream via atomic single-skill PR + lock bump + revendor.
   In-place skill mutation by the loop is forbidden (master §3c).

## Dispatch gating (blocking preparation condition)

Mega-plan §0.6 / PARALLEL-LANES §1.2: **all implementation in this repo is pre-D1
blocked**. ai-catapult certifies only with `vendor/`/`dist*` isolation (its build writes
`dist*`; tests need gitignored `vendor/`). Autobahn dispatch for every goal in this plan
opens only after the D1 gate-isolation plan merges (=O8). This is encoded as a blocking
preparation condition on every goal record in the published bundle.

## Rename-wave ordering

Goal `tswc-ac-a2` (full TS conversion) lands first and as one repo-wide rename wave; every
other ai-catapult goal (this plan's B3/B4/B5, plus ACH C-03/C-04 and XSKP P4-*) rebases
onto it and ships in TS on the converted tree (mega-plan §2.5, W1). `tswc-ac-b1` is
file-disjoint (new files) but dispatches after A2 by this wave rule.

## Cross-lane relationships (prose; never cross-repo bundle dependencies)

1. **B2 (skills lane, plan `tswc-skills`) ← B1's layout vocabulary** — the three role
   skills (`evolution-rollout`, `wiki-maintainer`, `skill-proposer`) speak the `evolve/`
   layout this plan's B1 defines.
2. **B5 ← A-gates across lanes** — B5's structural pre-reject consumes this lane's A2 gate
   stack and the skills-lane A4 gates (ruff C901 10, xenon, shellcheck, shfmt, mypy) over
   proposed skill scripts.

## Plan

### A2 — full TS conversion (the rename wave)

All ~39 `.js` → strict `.ts`; `tsc` build step; package rewire (`bin`, `files`, `prepack`);
the two complexity-34/22 refactors (`src/install.js` `runInstall` ≈34 and
`src/graph-hooks.js` `runGraphHooksInstall` ≈22 at `a87c912`); shellcheck `-S error` +
`shfmt -d` on the `.sh`; own prek hooks; **packaging-change ADR** in
`docs/architecture/adr/`. DevDeps only. Verified: build + gate trio green + negative
fixture.

### B1 — `evolve/` layout + schemas

`raw/<run-id>/` write-once traces; `wiki/` + append-only `logs.md` + `skill-impact.md`;
`proposals/` overlays; `PURPOSE.md` convention; audit-entry schema + judgment-record schema
(master §5.4). Verified: structural `node --test` + golden fixtures.

### B3 — `evolve --validate` (Eq. 4 gate)

Seeded per §4.9 (F1), provenance-checked per §5.4 (`judgment_unbound` refusal),
budget-vetoed per §5.5 (`cycle_budget_exhausted`), wiki append-only even on reject, reject
drops the overlay. Verified: accept/reject/early-stop/revert/unbound-reject/budget-exhaust
unit vectors + negative fixture.

### B4 — upstream flow

Accept → atomic single-skill `skills/` PR → lock bump → revendor → payload rebuilds;
reject → overlay dropped, wiki kept. Verified: e2e fixture run through the
`opencode-e2e`-style harness.

### B5 — proposal hygiene

Structural/complexity pre-reject before any judge invocation (a gnarly proposal costs zero
judge dollars); OKF advisory frontmatter check as findings-only (master §3b). Verified:
gnarly fixture proposal rejected with zero judge calls (stub harness asserts no
invocation).

## Goals

The authoritative per-goal scope, acceptance, verification and readiness live in the
published `.ai/handoff/readiness-v1/tswc-ai-catapult/<generation>/goals.json` in this
repository, registered in `.ai/workflows/northstar-readiness-v1.json` (registration
`northstar-plan-tswc-ai-catapult`). No goal in this plan depends on a goal in another plan
or repository; the two cross-lane relationships above are prose records on the goal objects.
Planning completion is not implementation readiness.
