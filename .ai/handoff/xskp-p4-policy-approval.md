# XSKP P4 policy rollover — independent approval pending

This is an **unsigned approval request**, not a `readiness-context/1`, receipt,
policy approval, execution admission, or merge authorization. Preparing this
configuration does not approve its digest.

## Exact subject

- Repository: `ai-catapult`, `r3dlex/ai-catapult`.
- Canonical root: `/Users/andresilvaburgstahler/Ws/Personal/AiTool/ai-catapult`.
- Registered handoff: `northstar-plan-xskp-p4-adopt-engine`.
- Frozen generation: `92ecdb62b5807ba4cac0e274a9fe5a566292823d1f30214258d3aacd839524af`.
- Bundle file SHA-256 / admission subject: `3222a2ea612cc19b51c6f9b3293e6d4d1b5613729c73398b45db88b33460ee1a`.
- Selected goals: `XSKP-P4-01` … `XSKP-P4-05` (linear chain 01 → 05).
- Requested stage: **implementation**, admitted one goal at a time in dependency order.
- Proposed policy: `.ai/policies/readiness-policy.json`.
- Proposed policy SHA-256: `3ff4515609748c9dfbb08643eb913977fb7a12ac84ffb9f4b35985f9489cfed2`.
- Previous policy SHA-256: `41d01478582a12b98fba2d6fc96c5769870e20b8ac7b728f624c3bffc65b52b1`
  (retained in Git at `4a6f675`).
- Policy sources: `AGENTS.md` `2584673bf15a0d022523fa130af37085e0dba37dbd06f19082d1e58821bc9260`
  (unchanged; `.ai/rules/` holds only an empty `.gitkeep`, also unchanged).
- Responsible party in gates: Andres Silva Burgstahler, retained from the prior
  policy. This is not an owner assignment: every frozen goal still says `unassigned`.

| Goal | goal_revision() | Proposed branch | Target |
|---|---|---|---|
| XSKP-P4-01 | `aa008a6e96ca4efad004df5edea44889c5c8066f498025accd96c99de9c2ee7e` | `feat/knowledge-contract-XSKP-P4-01` | `main` |
| XSKP-P4-02 | `7e8039ab8d5edd3a353062540da2b402b0f1fe5130c0cfe0462f20aafe385815` | `feat/knowledge-read-verbs-XSKP-P4-02` | `main` |
| XSKP-P4-03 | `b41121e1a34b8cee485c019526b1aec05d925adc7a2afdd0d2074fc21beaa2d4` | `feat/knowledge-write-verbs-XSKP-P4-03` | `main` |
| XSKP-P4-04 | `6a69d65835a1b10cf924fde3c2da4523b939ebe034f6714878abbb5a99f47102` | `feat/adopt-inventory-XSKP-P4-04` | `main` |
| XSKP-P4-05 | `c4ae861e8809a22ad41ab95679c2d9f9158fc6de468066b47ef968c02492e72b` | `feat/adopt-apply-init-XSKP-P4-05` | `main` |

## What approving this digest authorizes

Only that the policy above is the rule set admission evaluates for P4. It does
not pass any gate, assign an owner, mark any goal ready, or authorize dispatch
or merge.

## What changed

- Kept verbatim: `own-execution` (owner, implementation), `own-review`
  (reviewer, merge), `tool-present` (npm, implementation).
- `not_applicable.branch_target` replaced by five exact per-goal
  `branch_target` gates.
- `not_applicable.registration_approval` replaced by five per-goal
  `protected_approval` gates bound to the `goal_revision()` values above.
- Added tool observations used by `npm test` and the P4 lanes: `node`, `git`,
  `bash`, `tar` (the packed-tarball tests shell out to `tar`).
- Added `planning-inputs-on-main` (`independent_result`): B5 is a gate, not a
  receipt. The spec and contract pack are present on `origin/main` at
  `4a6f675`, but no independent B5 result has been issued.
- `fixtures` and `harness_trust` exemptions rewritten P4-scoped; the old
  single-maintainer and self-sign wording is gone. No new exemption.
- `extensions` record active plan, generation, pending status and superseded digest.

## Scope limitation

readiness-contract/1 reads one fixed policy path and rejects goal scopes
outside the admitted bundle. This rollover serves P4 only; any later plan in
this repo needs its own reviewed rollover. The new digest invalidates any receipt
issued against the previous policy.

## Evaluation observed in preparation

`prereq-check.sh --stage preparation` from the isolated worktree exits 1 with
`repository_root_mismatch` (the bundle pins the canonical root). Calling
`select()` and `policy_admit()` directly, with only the root-equality check
relaxed, showed that before this change the implementation stage required evidence for 2
gates (`own-execution`, `tool-present`). After it, 19 gates require evidence. With no
context, both stages still fail on `independent_context_required`,
`goal_not_ready` and `dependency_incomplete`. Simulated contexts were
ephemeral and carried no results.

## Still required before implementation

1. Assign an owner through the supported planning path. Do not edit frozen generation files.
2. An authorized owner approves this exact digest, source set, subject, goals
   and stage through an independently verifiable boundary. An agent comment
   under the same credentials is not owner approval.
3. Obtain an independent `planning-inputs-on-main` (B5) result and green CI at
   the execution base.
4. Publish a reviewed readiness-only generation once prerequisites clear.
   Goals are currently `preparation: blocked`, `implementation: unknown`. A new
   generation changes goal revisions and requires rebinding the approval gates.
5. Fresh typed receipts (owner, branch, approval, tools) in `readiness-context/1`,
   then exact admission for `XSKP-P4-01` from the canonical root.

Fresh merge-stage admission and separate merge authorization remain required.
This preparation evidence is not feature TDD or feature completion.
