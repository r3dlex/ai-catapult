# af-06 `local_ci` declaration — ai-catapult plan-scoped planning specification (plan `af-06-catapult-local-ci`)

ID: `AF06-C-20261014`; plan: `af-06-catapult-local-ci`; repository: `ai-catapult`.
Position: plan-scoped planning specification published with the planning-input generation for plan `af-06-catapult-local-ci` (readiness-contract/2, live policy `readiness-policy/2`).
Execution, admission, publication and approval authority: **none**. The generation binds this file by `spec_sha256`; publication grants no execution, admission, approval or merge authority.

## Source of authority

Pinned umbrella goal record: `r3dlex/ai-tool-workspace` `.ai/handoff/autobahn-goals/af-06-catapult-local-ci-declaration.json`, root `origin/main` commit `f4a6241e07bc8beddc4ff8a3e43816b71f3160f5`, sha256 `14f3b8a5eec4314e919e225735f0f2cf8cc63b8022939421306242af494f49d8` (recomputed from git objects at registration). Context records at the same root commit: `af-06b-local-ci-backfill.json` sha256 `64294325f76f82f9abc2ca0690f123bf8cf4d02a29ca4f73484b24bee85d1741`; `af-11-corpus-revendor.json` sha256 `77fbad2f90c00340c4f18b8b16a41c5a763a22bc348c50efd67d774581462089`.

af-06 PR 1 landed in r3dlex/skills as #105, squash `305ebc25d2b0896839147f2500f387edd874c7c5` (2026-10-08): the `local_ci` schema doc (`03-configure-generate/ai-catapult-init/modules/workflow.md`), the scaffold template (`templates/dot-ai/workflows/repo-workflow.json` emitting the parked starter), the v3 reference fixtures and `tests/local_ci_declaration_test.py`. This plan is af-06 **PR 2**, the r3dlex/ai-catapult side.

## Decision D3 (carried verbatim in effect)

`local_ci` has exactly the shape `{ "surfaces": [{ "cmd", "hermetic", "covers" }], "sole_source_of_truth" }`. af-06 (the skills schema doc) owns the format. Consumers — ai-catapult included — never reinterpret, re-validate, default, repair or guess it; an absent, empty, `sole_source_of_truth: false` or malformed declaration parks the consumer. ai-catapult ships the format only as vendored, byte-pinned content.

## What the catapult side already has (observed at base `5d0c5bd5609d4ae2d3cb65d66c72256cea3ec5ae`, lock `28f813bf9fd767960b96e9d54857964de8181a53`)

skills `305ebc25` is an ancestor of the pinned `28f813bf`; the O8 lock bump (ai-catapult PR #57, merge `711c99cc76ae4c6ac75eae435323af5280261790`) already carried PR 1 into this repository:

| af-06 scope line naming r3dlex/ai-catapult | State |
|---|---|
| repo-workflow.json scaffold/template | Vendored template renders the parked starter; `test/fixtures/init-standalone/.ai/workflows/repo-workflow.json` carries it, `test/readiness-delivery.test.ts` (F1) pins it, `test/init.test.ts` byte-diffs a fresh `init` against the fixture. |
| workflow-manifest validator | Reference validator and its per-case tests (well-formed accepted, malformed rejected with the offending JSON path, absent treated as absent) live in skills `tests/local_ci_declaration_test.py`. ai-catapult owns no manifest validator; under D3 none is added. |
| docs for the field | skills `modules/workflow.md` `## local_ci declaration` (park rule, execution semantics, adoption); vendored and bundled verbatim into the Claude/Codex/OpenCode plugin payloads. |
| `skills.lock.json` + regenerated fixtures | **Drifted again**: lock `28f813bf`, skills `origin/main` `848a3dd6375d3552ea118914d4584d39aaa351ba` (9 commits). This plan's single goal. |

## Why the bump is not a one-line lock edit (measured, not inferred)

A throwaway worktree at base with only the lock set to `848a3dd6`: `npm ci` vendors cleanly; `npm test` → 607 tests, 592 pass, **13 fail**, 2 todo; `npm run regen:fixture` → **zero byte delta** under `test/fixtures/init-standalone/`.

Cause: skills #137 (`10a650db`, E6 decision D3 "permanent compatibility entrypoints") replaced `03-configure-generate/ai-catapult-init/scripts/readme-generate.sh` with a generated compat shim that execs `lib/readme-generate.mjs` located beside itself (exit 127 `node_unavailable` when absent) and refuses any node outside `v26.*` (exit 126 `node_version_unsupported`, skills ADR-0018; `ts-tooling/package.json` `engines.node` `>=26.0.0 <27.0.0`). ai-catapult's packaged CLI lane stages only `scripts/readme-generate.sh` and `assets/readme/template.md` into `dist/readme-contract/` (`scripts/stage-readme-contract.ts`), so a packaged `init` fails before its first write; the plugin lanes copy the whole skill directory and are unaffected. Hosted CI pins `node-version: '22'` (`ci.yml` four jobs, `release.yml`, which also runs `npm test`) and `package.json` declares `engines.node >=22.18`, so every `init` would also refuse in vendor mode on the hosted runner. The repository's own `.prototools` already pins node `26.5.0`.

The failing tests at the naive bump: `test/evolve-upstream.test.ts` (literal lock SHA), ten `packed-init` tests (`ACH-C-03`, `XSKP-P4-05` lanes: exit 127), and two `test/readme-contract.test.ts` digest pins (generator `aa2a51dc5227ff0f35852b0028ebee69d479573c67bc32a931d34c7332e6447e` → vendored `eea644047f02d392284d2900b1baa4b2a77b68215d7cf1a5586fa834feb59a4d`; template `449a0d74f7150e8558a3884d5bd09c031f00dd4885d8690fef53c00a2ae9a358` unchanged). `test/release-dispatch.test.ts` additionally pins `node-version: '22'` in `release.yml`.

## Goal map

`goals.json` owns exact scope, acceptance criteria, dependencies and verification; this table is navigation only.

| Goal | Dependency | Purpose |
|---|---|---|
| `AF06-C-01` | — | Vendor-sync `28f813bf → 848a3dd6` with its forced consumer adaptations: literal re-pins, stage the shim runtime (`scripts/lib/`) beside the generator in the packaged CLI lane, hosted CI and `engines.node` on the range the vendored shim enforces, `.ai/ci/local-ci.json` source re-pins, fixture regen proven byte-identical twice, PR body enumerating the nine upstream commits as the bump's reviewed blast radius (af-06 AC[7] analog). |

## Decisions and non-goals

1. Target pin is literal: `848a3dd6375d3552ea118914d4584d39aaa351ba`. A later skills tip is a new goal in a successor generation; nothing retargets silently.
2. The shim runtime rides the existing "stage the pinned generator" mechanism: `scripts/stage-readme-contract.ts` copies the vendored `scripts/lib/` directory beside `scripts/readme-generate.sh`, mirroring the vendored layout. No new vendoring filter, bundler or second runner is introduced (AGENTS.md: no runtime npm dependencies; the `.mjs` modules import only `node:` builtins).
3. The README contract test pins the shim, the template **and** `scripts/lib/readme-generate.mjs`, because the generator's behaviour now lives in the module; a plugin or CLI payload missing or altering any of the three is a stale contract.
4. Node floor: hosted CI runs node 26 and `package.json` `engines.node` becomes `>=26.0.0 <27.0.0`, the exact range the vendored shim enforces at run time. This is a consequence of the pinned shim, recorded as a decision for a human to supersede (`.omc/plans/receipts-af06-pr2-catapult-20261014/stop-questions.md` SQ-1, root workspace). No release is tagged or published by this plan.
5. Fixture regen is expected to be a no-op and must be proven: two `npm run regen:fixture` runs, byte-identical to each other and to the committed fixture, recorded as digests in `.ai/evidence/AF06-C-01.json`.
6. `.ai/ci/local-ci.json` keeps its reviewed `workspace` object and `verification` list exactly; only the digests of declared sources and workflows this goal edits are re-pinned.
7. Non-goal: a catapult-side `local_ci` validator, reader or default (D3). Non-goal: editing anything under `vendor/skills/` (SHA-pinned mirror). Non-goal: af-06b's per-repository backfill of ai-catapult's own `.ai/workflows/repo-workflow.json`. Non-goal: the root workspace's `tests/local-ci-manifest_test.sh` extension (root-side scope line of af-06).
8. Fail-closed origin guard (af-06 solutions[7], by outcome): the goal PR's base repository is `r3dlex/ai-catapult`; no umbrella-root commit carries child content; `git ls-files ai-catapult/` from the umbrella stays empty.

## Readiness

Planning completion is not implementation readiness. Preparation, implementation and merge readiness are `unknown` at every stage pending one verified plan approval carried by tag `approval/af-06-catapult-local-ci/<generation prefix>` (agent-self is accepted by the live policy; an agent-self approval must carry the verbatim disclosure "AGENT-SELF — no human approved it"). Hosted CI green and local gates are evidence, never authority.
