# Filesystem containment residual (c) — ai-catapult plan-scoped planning specification (plan `fs-c-residual-catapult`)

ID: `FSC-C-20261014`; plan: `fs-c-residual-catapult`; repository: `ai-catapult`; goal: `FSC-C-01`.
Packet revision: **r7 — narrowed by human decision** (HITL batch #3, 2026-10-15T04:52:51Z: "Narrow the goal to the
undisputed outcomes … per-class tables → docstrings/tests; one fresh pair; publish on APPROVE×2"), plus the r6 review's
definitional fix to AC-1's `result` rule and two cosmetic corrections (coordinator authorization 2026-10-15T05:18:34Z).
Position: plan-scoped planning specification published with the planning-input generation for plan
`fs-c-residual-catapult` (readiness-contract/2, live policy `readiness-policy/2`). Packet revision r8 was approved by two
independent reviewers (Architect + blind Critic, 2026-10-15) before publication; the normative content below is
byte-identical to that reviewed revision except for this header paragraph.
Execution, admission, publication and approval authority: **none**. The generation will bind this file by
`spec_sha256`; publication grants no execution, admission, approval or merge authority.

## How to read this document (normative vs. informative)

- **Normative**: the six acceptance criteria in `goals.json` (restated in §Acceptance criteria), the fixture table
  (§Fixtures: T1–T7, T9), the scope and verification lists, and the ADR-0013 review-prompt clause. They bind
  **observable outcomes** only: what the run refuses (and with which structured code), what own bytes it cleans,
  what prior state it restores, what it reports, and what remains a documented residual.
- **Out of this goal's contract (by human decision)**: the behaviour of the policy and ledger write targets per
  entry class (regular file, symlink, hard link, directory, special file; replaced versus refused). It is described
  by the implementation's docstrings and asserted by its tests; this goal neither widens nor narrows the existing
  fixtures that cover it (AC-5).
- **Informative, non-binding**: §Appendix — Implementation notes. One way to reach the outcomes. An implementation
  may differ from it in any way that still satisfies every normative outcome and fixture; a finding against the
  appendix alone is not a finding against the goal.

## Source of authority

- **Human mandate (planning only).** `.omc/plans/hitl-answers-20261014.md` (root receipts, gitignored) — an
  **append-only coordinator transcript**, cited as a dated snapshot: its bytes as of 2026-10-14T07:09:32Z (the first
  17 lines) hash sha256 `12d1abd14a87d5fbeeab2a88cf267836ee36ebcc6c98bdbd64bb36077af40e06`; observed again at
  2026-10-15T04:54:34Z with three later addenda appended (2026-10-14T21:15:10Z "#139 D13 decision";
  2026-10-14T21:30:10Z "HITL batch #2"; 2026-10-15T04:52:51Z "HITL batch #3"), 37 lines, sha256
  `df4ad4a53f81b26e2e6079cca264fb77be2c3de3935b3ca275dc476029c90ecd`; later appends are expected and change the
  whole-file digest, not the snapshot. Rows relied on, byte-unchanged at both observations:
  - line 14 `ADR-0013`: question "Ratification of the filesystem containment threat model (agent-delegated
    acceptance on root f4a6241e)"; answer **"Ratify, but open a follow-up goal for (c) (ancestor-rename residual;
    native-free, bounded)"**;
  - line 37 `FSC` (batch #3): question "ADR-0013 (c) follow-up plan FSC-C-01 parked after five revisions"; answer
    **"Narrow the goal to the undisputed outcomes (relocated-ancestor refusal/revert, residual-(c) conformance
    fixture, canonical caller root, structured reporting, claims discipline, gates; per-class tables →
    docstrings/tests); one fresh pair; publish on APPROVE×2"**.
  These answers authorize planning (and, on APPROVE×2, publishing) this goal. They are not a plan approval, an
  implementation admission or a merge authority.
- **ADR-0013** `docs/architecture/adr/0013-filesystem-containment-threat-model.md`, accepted at root
  `r3dlex/ai-tool-workspace` `f4a6241e07bc8beddc4ff8a3e43816b71f3160f5` (sha256
  `a9a60e8cde2666e3dc1fb71776c975d48de61a7f68338a236694ce0b99860d18`) and **human-ratified** by the
  `## Ratification (2026-10-14)` note appended by root PR #128 (squash `22154ebbb8ab03cb500993ffee451a055ca26ea1`,
  parent `f4a6241e`; ADR sha256 on main `20850c2fe6cdc0faedbf0eac2dac7807c668a03881b06ecfed399bd5adc3589e`). The
  note changes no decision text. Adopted assumption, verbatim:
  > (a) pre-existing symlink/hardlink substitution at any depth is **refused**; (b) detected relocation or
  > invalidation is **refused fail-closed with structured reports**; and (c) the residual window between the final
  > verification and the kernel write, against a concurrent hostile relocator, is **outside the boundary,
  > explicitly declared**.
  And the prerequisite that makes this goal's change in-boundary rather than (c):
  > where an implementation performs no identity verification for a component the mutation depends on — as with
  > C-04's parent-directory resolution before this ADR — the missing check is an in-boundary defect (annex), not an
  > instance of (c).
- **Annex** `.ai/work-intake/fs-threat-model-impact-20261011.md` (sha256
  `0364ebe37e8c5612325e6b2ff825bd655f98f4eee7d20c970382695fd5410d49`), §C-04: parent-identity verification
  required before the policy rename and the ledger open and for the earlier `mkdir`/temp mutations; the (a)-depth
  requirement for the root ("refuse it, or require and verify a canonical caller path"); claims alignment;
  `cure-race-red.log` surfaced in-branch.
- **Successor-plan inputs** `.omc/plans/successor-plans-b1-c04-20261011.md` (sha256
  `2448656f0b08e77f1136047a256599a37868a7a2fcc3a160b8d02e25e1fcb195`): the C-04-R4 review-prompt clause and its
  2026-10-11T06:58Z amendment.

## What exists at base (observed first-hand, ai-catapult `origin/main` `8815f1940c0125c2f7fa3ca24149a3779d613139`, #74 `AF06-C-01` merged 2026-10-14T08:41:01Z; re-verified 2026-10-15T04:54Z, no open pull request; the six paths in scope are byte-identical to `5d0c5bd5609d4ae2d3cb65d66c72256cea3ec5ae`, where they were first read)

| Surface | Observed outcomes | Evidence |
|---|---|---|
| backfill (`src/backfill.ts`, PR #67 → `2fe7e303`) | **Does not** refuse an ancestor directory relocated during the run: the policy lands outside `--root` with exit 0 `written` (todo leg 1) and an empty ledger is created outside before a descriptor check refuses (todo leg 2). Adopts an ancestor-of-root symlink by canonicalizing with `realpath`. Docstring/help call the ancestor swap "a deferred residual (ADR-0013)". Its existing refusals and its existing write-boundary behaviours are covered by fixtures that this goal keeps unchanged. | `git show 8815f194:src/backfill.ts`; `test/backfill.test.ts` |
| evolve (`src/evolve/containment.ts`, PR #63 → `3fa658b2`) | Refuses relocation of any validated component whenever observed, before or after a write, with a structured kind; cleans a created file only while it is still its own inode holding exactly its own bytes; restores a replaced file only while it still equals its own bytes; declares the remaining interval. Both reviewers APPROVE at cure5 `8f3c5623`. | `git show 8815f194:src/evolve/containment.ts`; `.omc/plans/receipts-b1-impl-20261010/b1-r3-cure5-merged.md` |
| tests | `npm test` 607 / 605 pass / 0 fail / **2 todo** (`deferred-to-ADR-0013` legs; "If one starts passing, the residual closed and the todo label must be removed"). 38 evolve-layout cases. | PR #74 record; `git show 8815f194:test/backfill.test.ts` |

Consequence: on the backfill surface the (c) interval does **not yet begin** — the identity verification the ADR
presupposes is missing (in-boundary). This goal binds the outcomes that close that gap (AC-1) and states the
remainder (AC-2).

## Decision — scope, non-goals, dependencies

- **Scope** (six literal paths) and why each is in scope: `src/backfill.ts` (AC-1, AC-3, AC-4, AC-5);
  `src/evolve/containment.ts` (may be extended to reach AC-1; its evolve-surface behaviour unchanged, AC-4/AC-6);
  `src/evolve/errors.ts` (may gain an optional, backward-compatible addition; the five evolve kinds unchanged, AC-4);
  `test/backfill.test.ts` (T1–T7, T9, converted todo legs); `test/evolve-layout.test.ts` (regression battery; any
  coverage of an extended primitive); `.ai/evidence/FSC-C-01.json` (AC-5, AC-6). `.ai/ci/local-ci.json` pins none of
  them and is untouched.
- **Non-goals**: per-class entry behaviour of the write targets (out of contract — see "How to read"); `src/adopt.ts`
  writes; `init`/scaffold writes; behavioural change for evolve callers; relocating the containment module; editing
  ADR-0013; editing the registered `ACH-C-04` acceptance text; any native module or runtime npm dependency.
- **Dependencies**: PR #63 (`tswc-ac-b1`, squash `3fa658b2142c8874aa3fd78986cff487be3b521d`) and PR #67 (`ACH-C-04`,
  squash `2fe7e303649e35a57de8194c79136c8bf9449a2d`) are ancestors of the base; the `AF06-C-01` goal PR (#74, squash
  `8815f194`) has merged, so the cross-plan ordering this goal carried is satisfied; `dependencies: []` because a bundle
  cannot depend on another plan's goal. SQ-1 (canonical root) and SQ-2 (ordering, moot) in `stop-questions.md`.
- **Options for the mandate's (i)/(ii)/(iii)** — adopted: (ii)-class before/after re-validation on a bound directory
  with (i)'s post-write re-walk and own-bytes cleanup retained and (iii)'s declaration discipline kept as AC-2/AC-5;
  rejected (i) alone and (iii) alone. How the adopted option is realised is informative (appendix).

## Acceptance criteria (normative; `goals.json` is authoritative — restated here for reading)

**AC-1 Relocated ancestor observed → refusal and revert (ADR-0013 (b)).** Whenever the run observes that a
directory component it validated for a write target (root, `.ai`, `.ai/policies`, `.ai/drift`) is no longer the same
directory — moved, replaced, removed or turned into a symlink — before or after a write it performed, it refuses
`path_relocated` naming the component; `result` is `refused` when, after this run's cleanup, no policy written by this
run stands at the verified path (including a policy write this run removed or restored), and `failed` when this run's
policy write stands at the verified path and the later ledger step refused (the base semantics of `result`); exit 1;
stderr non-empty; never `written`/exit 0 through an observed relocation; a root observed gone is never recreated.
Nothing this run wrote remains outside the root: a file this run created in the relocated directory is removed while
the entry is still this run's inode holding exactly this run's bytes; a prior policy this run replaced is restored to
its decision-time bytes under the same two conditions; a competitor's bytes on this run's inode are never deleted or
rewritten — left as is, refusal still reported; the relocated directory itself is not claimed removed. Fixtures T1,
T2 (the converted todo legs), T3, T3b, T4, T5, T7.

**AC-2 Documented residual (ADR-0013 (c)).** A relocation in effect only inside the interval between the run's final
verification and its write, undone before the run next verifies, is **not observed**: exit 0 `written`, policy bytes
at the verified path inside the root (T9, named "declared, not detected"). Not required to detect or defeat; AC-1's
removal/restoration best-effort, not single kernel operations; forbidden phrases absent; ADR-0013 not edited.

**AC-3 Canonical caller root (ADR-0013 Depth of (a); SQ-1).** A `--root` reaching the repository through a symlinked
ancestor → `root_not_canonical` with the canonical path in `detail`, exit 1, nothing written anywhere, no ledger
line; `BACKFILL_HELP` and the docstring state it (T6). Existing `root_symlinked`/`root_missing`/`root_not_directory`
fixtures keep their assertions.

**AC-4 Structured reporting vocabulary.** Every AC-1/AC-3 refusal is a structured report (`result` `refused|failed`;
`refusals[]` with `code`/`detail`), exit 1, stderr line; no silent success; unexpected error → exit 1 + stderr. Exactly
two codes added (`path_relocated`, `root_not_canonical`); every existing backfill code — the 21 `code:` literals in
`src/backfill.ts` at base, enumerated in `goals.json` — keeps its meaning and every existing backfill assertion is
unchanged; the evolve surface's observable refusal kinds keep their meanings and every existing evolve-layout assertion
is unchanged.

**AC-5 Claims discipline + historical red leg.** `src/backfill.ts` docstring, `BACKFILL_HELP`, the docstring of any
changed scope file, `.ai/evidence/FSC-C-01.json`, PR body state exactly AC-1/AC-3 outcomes and AC-2's residual;
forbidden phrases absent; "deferred residual"/"deferred-to-ADR-0013" gone from `src/` and `test/`; per-class entry
behaviour out of contract (docstrings/tests; existing fixtures neither widened nor narrowed); registered `ACH-C-04`
AC wording not repeated; evidence carries `cure-race-red.log` verbatim (4306 bytes, sha256
`8dee1c6f72263f5cf370e7504e205050b0070303e5c6bff0837b7dc16cf99e11`) under `historical_red_leg` with provenance.

**AC-6 TDD, gates, scope, sequencing.** One identical command
`node --test --test-name-pattern 'FSC-C-01' test/backfill.test.ts test/evolve-layout.test.ts` — exit 1 at base
`8815f194` with the new tests present (red because T1–T7 fail there; T9 is a conformance fixture that also passes at
base and is not claimed red), exit 0 at the final head; digests in evidence. Final head: `npm test` 0 fail, no deferred
todo; 38 evolve-layout + all existing backfill cases unchanged assertions; typecheck, eslint, `git diff --check` clean;
hosted CI four jobs on both events at the exact head; changes within the six scope paths; `.ai/ci/local-ci.json`
untouched. Dependencies #63/#67 ancestors; `AF06-C-01` (#74) merged → ordering satisfied. Agent-self disclosure
verbatim if applicable. Review prompts paste the ADR-0013 clause.

## Fixtures (normative outcomes)

| ID | AC | Scenario | At base | Green asserts (outcome) |
|---|---|---|---|---|
| T1 | 1 | `.ai/policies` relocated out of the root (outside symlink planted at its name) before the policy write — converted todo leg 1 | **red**: exit 0 `written`, policy outside | `path_relocated` naming `<root>/.ai/policies`; exit 1; `result: refused`; stderr non-empty; nothing this run wrote outside the root; no temporary file remains anywhere |
| T2 | 1 | `.ai/drift` relocated before the ledger append — converted todo leg 2 | **red**: empty ledger outside | `path_relocated` naming `<root>/.ai/drift`; exit 1; this run's policy write stands and the ledger step refused → `result: failed`; no ledger outside |
| T3 | 1 | `.ai/policies` relocated inside the policy write (fresh root); relocation left in effect | **red**: exit 0 `written`, policy outside | relocation recorded as in effect when the write ran; `path_relocated`; `outside/policies/readiness-policy.json` absent (this run's write removed); no policy written by this run stands at the verified path → `result: refused`; exit 1; stderr non-empty |
| T3b | 1 | as T3 with a v1 policy present | **red**: v1 replaced outside | `outside/policies/readiness-policy.json` holds exactly the original v1 bytes (this run's write restored); no policy written by this run stands → `result: refused`; `path_relocated`; exit 1 |
| T4 | 1 | `.ai/drift` relocated inside the ledger create | **red**: empty ledger outside | `path_relocated`; `outside/backfill-ledger.jsonl` absent; exit 1; `result: failed` |
| T5 | 1 | as T4 plus a competitor appends to the created inode before the run observes the relocation | **red**: refusal code differs | competitor bytes survive the refusal (file left as is); `path_relocated`; exit 1 |
| T6 | 3 | `--root` through a symlinked ancestor | **red**: exit 0 `written` (adopted via realpath) | `root_not_canonical`; exit 1; nothing written anywhere; no ledger |
| T7 | 1 | root replaced by a fresh directory (original moved away) before the policy write | **red**: policy written into the fresh root, exit 0 | `path_relocated` naming the root; exit 1; the fresh root stays empty; nothing this run wrote in the moved original |
| T9 | 2 | relocation in effect only inside the write interval, undone before the run next verifies | **conformance** (green at base, same outcome) | exit 0; `result: written`; policy bytes at `<root>/.ai/policies/readiness-policy.json`; test name states "declared, not detected" |

Regression battery (assertions unchanged): every existing `test/backfill.test.ts` case; all 38
`test/evolve-layout.test.ts` cases; full `npm test` 0 fail; `npm run typecheck`; eslint via `prek run --all-files`;
`git diff --check`; `.ai/ci/local-ci.json` untouched. The historical C-04 red leg (`cure-race-red.log`) is carried
in the evidence file (AC-5).

## Review-prompt clause (paste verbatim into every `FSC-C-01` review prompt)

```text
Boundary binding (read first). This review is filesystem-containment work and is governed by ADR-0013
(docs/architecture/adr/0013-filesystem-containment-threat-model.md, accepted at root
f4a6241e07bc8beddc4ff8a3e43816b71f3160f5 and human-ratified by the Ratification (2026-10-14) note of root PR
#128, squash 22154ebbb8ab03cb500993ffee451a055ca26ea1 — read the merged text, which wins over this clause):
(a) pre-existing symlink/hardlink substitution at any depth must be refused; (b) detected relocation or
invalidation must be refused fail-closed with a structured report; (c) the interval between the final identity
verification and the kernel write, against a concurrent hostile relocator, is the declared boundary and is
OUTSIDE the containment boundary — tooling is not required to detect or defeat a write that lands in that
interval. Judge findings accordingly: a finding that reproduces only the (c) interval is not blocking; the
following are all in-boundary and remain blocking: a check that runs after the mutation it was meant to
precede; a refusal that cannot be observed or reported; a compensation that damages a competing writer's bytes;
a claim stronger than what is enforced; and any failure of (a) or (b). Cite ADR-0013 "Decision" in any finding
that turns on the boundary.

Narrowed contract (human decision, HITL batch #3). Binding: the six acceptance criteria, fixtures T1–T7 and T9,
the scope and verification lists. Out of this goal's contract: per-entry-class behaviour of the policy and ledger
write targets (replaced versus refused; symlink, hard link, directory, special file) — covered by the
implementation's docstrings and tests, with the existing fixtures kept unchanged; a finding about it is recorded
as out-of-contract, not blocking, unless an existing fixture's assertion changed. Informative only: the
specification's "Implementation notes" appendix; a finding against it alone is not a finding against the goal.

Scope for this round (goal FSC-C-01, plan fs-c-residual-catapult): verify AC-1 (observed relocation of a
validated component refused path_relocated with the stated result/exit/stderr; own-bytes cleanup and
restoration only while the entry is still this run's inode holding exactly this run's bytes; competitor bytes
never deleted or rewritten; a vanished root never recreated; T1–T5, T7), AC-2 (the residual stated in ADR-0013's
terms and asserted by T9), AC-3 (root_not_canonical; T6), AC-4 (structured reporting; exactly two added codes;
existing assertions unchanged), AC-5 (claim texts; forbidden phrases; historical red leg in the evidence file),
AC-6 (the TDD command red at base and green at head; regression battery; gates; exact scope). Do not
re-litigate: the evolve surface's reviewed guarantees at #63 cure5 (8f3c5623), the ACH-C-04 fixtures at base,
the test-only faults observers, or hosted CI at reviewed heads. You may add any finding; name it as in-boundary,
(c), or out-of-contract, with the ADR citation where it turns on the boundary.
```

## Readiness

Planning completion is not implementation readiness. Preparation, implementation and merge readiness are `unknown`
at every stage pending one verified plan approval carried by tag `approval/fs-c-residual-catapult/<generation
prefix>` after the planning PR merges (agent-self is accepted by the live policy; an agent-self approval must carry
the verbatim disclosure "AGENT-SELF — no human approved it"). The human's answers are not that approval. Hosted CI
green and local gates are evidence, never authority. Implementation requires a separate explicit `autobahn`
invocation with current admission; this planning record dispatches nothing.

---

## Appendix — Implementation notes (INFORMATIVE, NON-BINDING)

One way the implementing lane can reach the normative outcomes. Nothing here is an acceptance criterion; where it
conflicts with an outcome or fixture above, the outcome wins.

**N1 — Reuse of the evolve containment module.** `process.chdir` binds the kernel's current-directory vnode to a
verified directory; a single-component relative pathname is then resolved only inside that vnode. `src/evolve/containment.ts`
builds on this and already exports `withBoundRoot`, `enterDirectory`, `enterOrCreateDirectory`, `ensureDirectoryHere`,
`createFileHere`, `replaceFileHere`, `appendFileHere`, `dropFileHere`, `readFileHere`, `entryKind`; its chain
verification and own-bytes compensation helpers are module-private and would be exported or wrapped as needed. A
missing ledger is created with `createFileHere` (`appendFileHere` deliberately refuses to create). Backfill would add
an atomic-replacement primitive for the policy (temp file created exclusively in the bound directory, written and
synced, chain re-verified, two single-component-name rename, post-write chain check) and a no-create option for the
root bind (AC-1's "never recreated"). Reusing the module is the minimal-code route; it is not required.

**N2 — Refusal vocabulary.** If the implementation maps containment errors to backfill codes, an additive optional
discriminator on `EvolveError` avoids message-text matching; the five evolve kinds stay as they are (AC-4 outcome).

**N3 — Canonical root (AC-3).** `realpathSync(root) !== path.resolve(root)` → `root_not_canonical`. Test fixtures
already realpath (`fixtureRoot`).

**N4 — Test seams.** No new production seam. The existing test-only `faults.beforePolicyWrite` /
`faults.beforeLedgerAppend` observers (C-04's observer pattern; the CLI sets none) serve T1, T2 and T7; at base they
fire after the temp file is created and immediately before the policy rename, and after the ledger directory `mkdir`
and immediately before the ledger open. The in-window fixtures (T3, T3b, T4, T5, T9) patch `node:fs` `renameSync` /
`openSync` for the kernel call through `syncBuiltinESMExports` — the `withPatchedFs` mechanism of
`test/evolve-layout.test.ts`, duplicated inline in `test/backfill.test.ts` (no new scope path) — performing the
relocation with the saved originals, recording that it was in effect when the call ran, then calling through; T9
moves the directory back before returning.

**N5 — TDD red leg.** With T1–T7 and T9 written first against the base implementation, the AC-6 command fails
(T1–T7 behaviourally); after the change it passes. `cure-race-red.log` (the C-04 historical red leg) is embedded
verbatim in the evidence file (AC-5).

**N6 — Rejected alternatives.** (i) post-write re-walk on absolute-pathname writes only: detects but cannot stop a
redirected rename/open. (iii) documentation-only narrowing: no enforcement; leaves the in-boundary gap. A native
`openat` binding: forbidden by the repository contract (no runtime dependencies) and itself leaves source-entry
substitution and held-descriptor relocation open (ADR-0013 Alternatives).
