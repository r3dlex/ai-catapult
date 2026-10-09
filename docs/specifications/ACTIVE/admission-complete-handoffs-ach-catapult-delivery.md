# Admission-complete Handoffs — ai-catapult plan-scoped planning specification

ID: `ACH-20261002`; plan: `ach-catapult-delivery`.
Position: plan-scoped planning specification published with the planning-input generation for plan `ach-catapult-delivery`; **O8 is live**.
Execution, admission, publication and approval authority: **none**.
Location: `docs/specifications/ACTIVE/admission-complete-handoffs-ach-catapult-delivery.md` in ai-catapult. This file is installed and the generation binds it by `spec_sha256`; the planning publication grants no execution, admission, approval or merge authority.

## Refresh before binding

1. The publication blockers in `DRAFT.json` are recorded as open dispositions. The ACH-S-08 merge is evidenced (r3dlex/skills PR #125, merge `f5e338b92bb754c2bfffdf542b498530258fdbc0`, the skills main tip). The HUMAN sitting-1 required-check choice remains open; the tier-shaped proposal supplies no binding.
2. Refresh repository/host facts and every v1 inventory entry, then reconcile this text, `goals.json` and the candidate. Complete only when every below-listed re-derivation agrees and no other umbrella disagreement exists; a different disagreement blocks preparation.
3. Under a separate publication authorization, bind the final copy and its unambiguous traceability node. Complete only when the post-O8 publisher derives the final spec/generation digests and reports no blocking planning gap. The sidecar carries no machine holds: readiness is `unknown` at every stage pending one verified plan approval; this publication grants no authority.

## Authority and effective plan amendments

Pinned umbrella: `r3dlex/ai-tool-workspace`, root commit `87274a6`, path `docs/specifications/ACTIVE/admission-complete-handoffs.md`, sha256 `e6feb698bde18356f0d49c497b7f368f242f39bc254b12942f7f1902408cee39` (verified from git objects).
The excerpts below are verbatim source material, including its historical open-N3 and repository-state sentences. Apply the following publication re-derivations and latest §9/user rulings to those sentences; they are not fresh observations. Any disagreement outside this table blocks preparation rather than amending the umbrella.

| Source statement / area | Effective C-plan interpretation |
|---|---|
| O2, K3 Forms, Bootstrap, Policy fields and Delivery call N3 open | **N3 decided at sitting 1 (2026-10-05): init seeds agent-self**, accepted and recorded. Seed the S-02 template verbatim: accept `["agent-self","ssh-tag","in-session"]`, default_mode `agent`; `anchor_sha256: null` and empty required checks still produce named gaps. Record this here, never by editing the umbrella. |
| First policy/2 candidate decided at publication | **D-ACCEPT variant a accepted**: ssh-tag, in-session and agent-self; default_mode `agent`. Candidate array order is preserved from the source draft, not normalized to the prose order. |
| C required-check names / D-TIERS | **Unresolved HUMAN sitting-1 choice**. `policy-candidate.variant-a.json` retains `test`, `vendor`, `codex-plugin`, `plugin-claude`. The `tier2-fast-ai-catapult` / `tier3-mergequeue-ai-catapult` pair is **PROPOSED/BLOCKED**, not accepted. Use `required-checks.proposed.json` only after the explicit choice and observable-check reconciliation; absent tier checks remain a gap, never a success. Tier 2 cannot replace Tier 3 full-suite evidence at the tested revision. |
| O8 for C, formerly ACH-S-06 | **The ACH-S-08 merge on skills main has landed**: full sha `f5e338b92bb754c2bfffdf542b498530258fdbc0` (r3dlex/skills PR #125, merged 2026-10-09T10:55:25Z, skills main tip). S-07 main `2ac9926f…` and provisional S-08 `dc91b29f…` do not satisfy it. Every C lane uses the post-merge source lane and matching readiness-dependency-v2 fingerprints. |
| Pre-D1 byte-clean certificate blocker | C-01 folds `.ai/ci/local-ci.json` into scope and upgrades to local-ci/2 with workspace `{bootstrap:["bash setup.sh"], dependencies:["vendor"], outputs:["dist","dist-snapshot"]}`. The merged S-08 schema must be rechecked. Bootstrap and gates run in the observer-built PR-head workspace; observed-root cleanliness/snapshot checks remain intact. Network is permitted only for bootstrap; gate Git config is isolated. This is future mechanics, not an issued certificate. |
| C-02/C-06 local-CI re-pins | Update changed declared-source digests while preserving C-01's **entire workspace object exactly**. C-02 also changes the pinned readiness-delivery test; its digest cannot be left stale. |
| v1 inventory previously named only P4 | At `f31de088…`, inventory includes **P4 and tswc-ai-catapult**, all ten goals. Refresh EVERY current entry and its fate, including newly added entries. Retire only inventory-confirmed merged work. **C-05 stays P4-only; ACH never migrates TSWC**. Unobservable/in-flight work blocks, and every v1 byte is preserved. |
| “#46 is merged” / “#46's lock” | #46's content landed through #50, merge `a87c91258fddad854e250f80045688da147644b7`; baseline lock is `26d25105b028903ea1b34aebe9fbf4595b550051`. C-01 annotates `.ai/work-intake/autobahn-startup-delivery.md`. #46's current owner/state and the kept backport branch require refresh; this plan does not act on #46. |
| Admission observes O8 / external PR states | The publishing agent observes cross-repository O8 and #50 facts. Admission observes same-repository input ancestry, inventory, anchor, tooling and approval. No cross-repository observation is fabricated as a same-repository gate. |
| Protection / replay / planning gaps | Refresh protection as observable or `unavailable`, never claim that unavailable proves satisfaction. A replay is one generation directory per planning PR. Planning-class approval/deferred gaps are reported separately; no blocking gap is hidden. |
| C-06 release and P-C2 | Bump only, expected `0.4.4` subject to fresh npm checks for both names. Tag/publish work is deferred until every ACH plan completes, in the separately authorized background release lane, at the exact C-06 merge. Watch, verify both npm versions/provenance, stop on failure and never re-tag. The copied ai-factory release snapshot is historical and grants no F-lane scope here. |
| Bootstrap / sign-off | Live ai-catapult policy is v1 at the observed base. Its first policy/2 still requires the **exact first-policy digest confirmation**, requested last via `--mode prompt`; bootstrap agent-self is refused. No new global specification sign-off is introduced. |

## Goal map

`goals.json` owns exact scopes, acceptance criteria, dependencies and verification; this table is navigation only.

| Goal | Dependency | Lane / purpose |
|---|---|---|
| ACH-C-01 | — | source; policy/2, every-entry inventory, local-ci/2 fold |
| ACH-C-02 | C-01 | source + packaged; actual O8 lock and drift checks |
| ACH-C-03 | C-02 | source + packaged; N3 init seed |
| ACH-C-04 | C-03 | source + packaged; explicit backfill, two-plan fixtures |
| ACH-C-05 | C-01 | source; P4-only migration |
| ACH-C-06 | C-04, C-05 | packaged; bump only, installed lane report-only |

## Outcome

If Northstar reports a plan ready, Autobahn can run it end to end. That takes
exactly **one** approval per plan generation, and no further prompts. Under K3
that approval is `agent-self` by default, human-confirmed in `prompt` mode, or
human-signed with `ssh-tag`. *(Amended by K3; it read "exactly **one** human
approval".)* The approval also authorizes merging each goal's PR. A merge still happens only when
the PR holds a valid merge certificate, so "proceed", "override" or
"--admin if necessary" can never skip a gate.

## Decisions (C-relevant verbatim rows)

| # | Decision |
|---|---|
| U1 | **Approval channel.** A plan approval takes one of the forms the repository's policy accepts (K3): `agent-self` (the default), an in-session digest-echo confirmation (`prompt` mode, only on request), or an SSH-signed git tag over the `plan-approval/1` digest, verified with `ssh-keygen -Y verify` against the trust anchor (`ssh-tag`, optional). Signer principals carry roles: `approver` is human-only, `agent` is for agent keys. Agent keys sign review records and certificates, and sign an `agent`-mode approval only under `ai-catapult-agent-approval`, never under the human `ai-catapult-plan-approval` namespace. *(Amended by K3; it read "Agent keys may sign review records and certificates, never approvals", with in-session as the lower-assurance fallback.)* |
| U2 | **The one approval also authorizes merges**, but only through a valid `merge-certificate/1`. A missing element blocks the merge; nothing waives it. |
| U3 | **Admin merge** may satisfy a required-review rule only when the repo's policy declares `identity_model: single`. It needs a valid certificate and an independent agent review lane. Admin merges backed only by self-review are refused. |
| R1 | **Coexistence.** `readiness-contract/2` runs beside v1. v1 bundles keep validating under v1 until explicitly migrated with `migrate-handoff.sh`, which resets readiness and needs one new approval. New plans publish v2. XSKP P1 finishes on v1. |
| R2 | **Trust anchor.** The anchor is `~/.config/ai-catapult/allowed_signers`, machine-local and never written by agents, with two user-instructed exceptions (see [Trust anchor](#trust-anchor-r2-amended-2026-10-04)). It holds four principals. Its sha256 appears in every approval request. The validator refuses an anchor inside any worktree. *(Amended 2026-10-04; it read "machine-local and never written by agents".)* |
| R2b | **Approval expiry.** An approval is valid until the plan generation, spec digest or policy digest changes, or for 14 days. Readiness and coverage edits do not affect it. |
| G2 | **Policy patterns.** The policy fixes binding patterns (branch `^(feat|fix|chore)/<plan_id>-<goal_id>$`, target, required checks). The bundle only fills them in. A bundle cannot add, remove or relax a gate. The approval binds the **content-only generation** (see O1). *(Amended by K3; it read "The approval signs".)* |
| G3 | **Pure validator, separate observer.** The validator stays non-writing and runs no commands. A separate pinned, read-only **observer** in the gate driver reads git and the hosted API. Certificates bind the observer's output, and the merge step observes again and refuses on any difference. |
| K1 | **Key presence is not enforced.** The user accepted that agents can reach `SSH_AUTH_SOCK`. A signature therefore proves possession of an approver key, not human presence. Each approval records its key type and an `assurance` field: `user-presence` only for `sk-` keys, otherwise `key-held`, `in-session` for a prompted approval, and `agent-self` for an `agent`-mode approval. Reports always state the assurance level. *(Amended by K3, which adds `agent-self`.)* |
| K2 | **Accepted risk: self-approval through in-session.** The user kept O2 everywhere (2026-10-02), including policy bootstrap and `--admin` merges, after the Architect showed that an agent could author a policy, approve it in-session, and then admin-merge on a `single`-identity repository. The path stays open by choice. Every approval, certificate, merge-authority decision and audit entry must carry `assurance`, and every report must show `assurance: in-session` and `assurance: agent-self` prominently. No code may present an in-session or `key-held` approval as `user-presence`, and `agent-self` is never shown as, or upgraded to, any other level. A repository can close the path by narrowing `accept` to `["ssh-tag"]`. *(Amended by K3, which adds `agent-self`.)* |
| K3 | **Approval modes** (user decision 2026-10-04). Agent self-approval is the default: `assurance: agent-self`, under the namespace `ai-catapult-agent-approval`, never upgraded to a human level. The in-session prompt is used only when the user explicitly asks for it, per plan or per repository. `ssh-tag` is optional. The merge bar is unchanged in every mode. Details, rule (d) and the statements K3 supersedes are in [Amendment 2026-10-04](#amendment-2026-10-04). |
| K3b | **Agent-self policy approval** (user decision 2026-10-04, accepted risk). `agent-self` may also approve bootstrap and policy-amendment generations, but only when `agent-self` is in both the live and the candidate `accept` lists (rule d). A v1 or absent live policy counts as an empty live `accept` list, so a bootstrap generation needs `in-session` or `ssh-tag`; an agent-self approval of one is refused with `agent_self_bootstrap_refused`. Such approvals emit `agent_self_policy_change`, and `audit-merges` lists them. |
| O1 | **What the approval binds** (resolves G2 vs AC-4). The approval binds `generation_v2`, the canonical hash of the content-only projection: goal content, spec, policy and anchor. Readiness, coverage, `legacy_*` and owner live in a per-generation **sidecar** that may only tighten without a new approval. Loosening any sidecar value requires a new approval. *(Amended by K3; it read "without a new signature".)* |
| O2 | **Accepted approval forms.** The S-02 baseline template is `agent` mode (`approval.default_mode: agent`, with `agent-self` in `accept`). Whether a repository seeded from it by ai-catapult init keeps `agent-self` is open decision N3, and each repository's first policy/2 candidate is decided at publication (see [Bootstrap](#bootstrap)). `ssh-tag` is optional, and `prompt` (in-session) is used only when the user asks for it. An `in-session` record is agent-writable: it is always reported as `assurance: in-session`, and a repository may narrow `accept` to `["ssh-tag"]`. *(Amended by K3; it read "The baseline `approval.accept` is `["ssh-tag", "in-session"]` (user decision), and ssh-tag is preferred".)* |
| O3 | **Policy approval.** There is no separate policy approval. The first plan approval that binds a `policy_sha256` also approves that policy, so AC-9's "exactly one approval" holds. *(Amended by K3; it read "separate policy signature" and "exactly one signature".)* |
| O4 | **Persistence.** The approval tag is authoritative. Merge certificates are agent-signed and stored in observer state, listed by `audit-merges`. Copies under `.ai/approvals/` are informational only. |
| O5 | **Policy path and default identity.** There is one fixed policy path, so each repository swaps to v2 once, after its v1 plan finishes (P1 in root, P4 in ai-catapult). The baseline `identity_model` is `multi`, which refuses admin. Single-identity repositories such as skills opt in explicitly. |
| O6 | **Follow-up migrations belong to the owning repository's plan,** because a bundle binds every goal to its own repository: XSKP P2/P3 in the root plan, P4 in the ai-catapult plan, P5 in the skills plan, and P6 plus ai-factory's policy/2 in a fourth plan, `ach-factory-adoption`. |
| O7 | **Review-lane independence** is reported as `declared`. It means a distinct agent principal, not authenticated independence (consistent with K1). |
| O8 | **"Skills v2 released"** means merged to skills `main` at a named commit, checked mechanically by git ancestry. |
| O9 | **Policy bootstrap.** A repository's first v2 generation carries its `readiness-policy/2` candidate. The single plan approval binds the candidate together with the plan, so no separate policy PR or approval is needed (makes O3 mechanical). The candidate stays inert until that approval verifies. A bootstrap generation needs an `in-session` or `ssh-tag` approval (K3b). *(Amended by K3 and K3b; it read "signs the candidate", and the last sentence is new.)* |
| O10 | **Unstarted v1 plans migrate directly.** A migration goal moves an unstarted or partly merged v1 bundle (such as XSKP P4) to v2 by republishing its unmerged goals. Only plans with goals in flight (XSKP P1) finish on v1 first. |

## Amendment 2026-10-04

These user decisions were made after #94 published this specification. Each
statement they contradict is amended in place and marked *Amended by …* with
its earlier wording. The skills plan-scoped copy
`docs/specifications/ACTIVE/admission-complete-handoffs-ach-skills-contract-v2-gen2.md`
carries the same K3 and K3b decisions.

### K3: approval modes

> **K3. Approval modes** (user decision 2026-10-04). Agent self-approval is the
> default approval mode. A prompted (in-session) approval applies only when the
> user explicitly asks for it, per plan or per repository. An SSH signature is
> optional and never required.

- **Forms.** `readiness-policy/2` `approval.accept` gains an `agent-self` form.
  `approval.default_mode` takes `agent`, `prompt` or `ssh-tag`. The skills
  baseline template (`ACH-S-02`) defaults to `agent`; whether the copy that
  ai-catapult init seeds keeps `agent-self` is open decision N3.
- **`agent` mode.**
  - Autobahn issues the `plan-approval/1` itself, signed with the agent key.
  - The namespace is the distinct `ai-catapult-agent-approval`, never the human
    `ai-catapult-plan-approval`.
  - Its assurance is `agent-self`. That level is reported in every report,
    certificate, audit entry and `audit-merges` result. It is never rendered
    as, or upgraded to, `in-session`, `key-held`, `user-presence` or any other
    human level.
- **`prompt` mode** requires an explicit in-session human confirmation.
- **Bootstrap exception.** A bootstrap generation's human confirmation is
  requested by the agent at publication, unasked (see [Bootstrap](#bootstrap)).
- **`ssh-tag`** remains optional.
- **The merge bar is unchanged in every mode:** a merge certificate, full green,
  an independent review lane, and no waiver.
- **Rule (d)** (as merged in `ACH-S-02`). The approval form of a
  policy-amendment or bootstrap generation must pass the live policy's whole
  form rule (`accept` and `default_mode`) and be in the candidate's `accept`
  list. The candidate's own `default_mode` never governs its own approval. A v1
  or absent live policy counts as an empty live list, which refuses only
  `agent-self` (`agent_self_bootstrap_refused`); the human forms (`in-session`,
  `ssh-tag`) then follow the candidate's `accept` list.

### K3b: agent-self policy approval

> **K3b** (user decision 2026-10-04, accepted risk). Agent-self approval may
> also approve bootstrap and policy-amendment generations. That includes changes
> to `anchor_sha256`, `accept`, `default_mode` or required checks.

- **When.** Only when `agent-self` is in both the live policy's `accept` list
  and the candidate's (rule d).
- **How it is recorded.** Each such approval carries `assurance: agent-self`. It
  emits the notice code `agent_self_policy_change` in the admission and merge
  reports, and `audit-merges` lists it. It is never upgraded to `in-session` or
  any human level.
- **Accepted risk.** An agent can approve a policy that drops a required check,
  then merge under it. An agent-self approved anchor change can also add
  approver lines whose keys the agent holds. That is the same class of risk K1
  already concedes, and ADR-0016 (skills, `ACH-S-02` scope) states it.
- **Unchanged.** The per-merge certificate bar stays as it is: exact head, every
  required hosted check `SUCCESS`, local CI, an independent review lane signed
  by a principal distinct from the certifier, zero unresolved threads, and
  merge-stage admission.
- **Bootstrap.** A v1 or absent live policy counts as an empty live `accept`
  list. An agent-self approval of a bootstrap generation is therefore refused
  with `agent_self_bootstrap_refused`.

### What K3 supersedes

K3 supersedes every statement below. Each is amended in place.

| Statement | Under K3 |
|---|---|
| U1: "Agent keys may sign review records and certificates, never approvals." | An agent key signs an `agent`-mode approval under `ai-catapult-agent-approval`, never under the human namespace. |
| Contract v2, Approval, Commands: "`autobahn` verifies the signature but never signs." | In `agent` mode, Autobahn issues and signs the approval with the agent key. |
| Outcome: "exactly **one** human approval per plan generation". | Exactly one approval per plan generation: `agent-self` by default, human-confirmed in `prompt` mode, human-signed with `ssh-tag`. |
| AC-1: "an asserted human-prompt count of 1". | Count 1 for an `in-session` approval (and for `ssh-tag` when exercised), 0 for an `agent-self` approval. |
| Policy fields: `approval{anchor_sha256, max_age_days: 14, accept: ["ssh-tag", "in-session"]}`. | `accept` may also hold `agent-self`, and `approval` gains an optional `default_mode`. |
| Adoption: "approve one `readiness-policy/2` … with one signature each". | One approval each, in the repository's mode. A signature is required only in `ssh-tag` mode. |
| O2: the baseline `accept` is `["ssh-tag", "in-session"]`, with ssh-tag preferred. | The S-02 baseline template is `agent` mode, and the init seed is open decision N3. `ssh-tag` is optional, and `prompt` is used only on request. |
| K1: assurance is `user-presence`, `key-held` or `in-session` (also the glossary). | Adds `agent-self`. |
| K2: every report must show `assurance: in-session` prominently, and no code may present `in-session` or `key-held` as `user-presence`. | `agent-self` is reported just as prominently. It is never shown as, or upgraded to, any other level. |
| R3, O3 and AC-9: "exactly one signature". | Exactly one approval. Root's first policy/2 is a bootstrap, so that approval is `in-session` or `ssh-tag`. |
| AC-2: "an agent-role signature". | An agent-role signature under the human namespace, or an `agent-self` approval that `accept` does not list. K3b adds three negatives. |
| O1: a sidecar "may only tighten without a new signature". | Without a new approval. |
| G2 and O9: the approval "signs" the content-only generation and the candidate. | The approval binds them. |
| Contract v2, Approval, Signature: a detached SSH signature under `ai-catapult-plan-approval`. | Per form: that signature for `ssh-tag`, the agent key's signature under `ai-catapult-agent-approval` for `agent` mode, and the digest-echo record for `in-session`. |
| Glossary: a plan approval is "a `plan-approval/1` record and its signature". | Its signature or digest-echo record. |
| Northstar publication: it emits the request digest "and the signing command". | And, for `ssh-tag`, the signing command. |
| Plans, `ach-root-adoption`: "migrating XSKP P2/P3 and the one-signature dogfood (AC-9)". | Migrating XSKP-P3-05 and SWP-ROOT-01 (O12), and the one-approval dogfood (AC-9; `in-session` or `ssh-tag`, K3b). |

Every row after K2 goes beyond the gen2 copy's list. Together with the rows
above, they cover every statement that read a signature as required for an
approval, or that refused every agent-role approval. Other uses of "signature"
or "signed" describe merge certificates, review-lane records, the `ssh-tag` and
`agent`-mode signatures themselves, or their verification, and are unaffected.
G2's rule that a bundle never relaxes a gate, U2 and U3 stand unchanged.

### Trust anchor (R2, amended 2026-10-04)

The anchor `~/.config/ai-catapult/allowed_signers` (sha256 `8b33406c…`) holds
four principals, one line each:
- `approver@human` and `approver-rsa@human`: plan approval;
- `agent@autobahn`: review, certificate and agent approval (the certifier);
- `reviewer@autobahn`: review only, the independent review lane.

The independent review lane must be a principal distinct from the certifier.
The previous anchor `52c61dc5…` held only one agent principal, so
`review_lane_not_independent` refused every certificate.

The coordinating agent wrote the anchor twice, each time on the user's explicit
instruction. Both edits are user-instructed exceptions to R2:
1. After #94, it removed a byte-identical duplicate `agent@autobahn` line
   ("diy"). That changed the anchor from `90c431fe…` to `52c61dc5…` without
   changing the trust set.
2. On 2026-10-04 it added `reviewer@autobahn` and gave `agent@autobahn` the
   `ai-catapult-agent-approval` namespace ("Agent does it"). That gave
   `8b33406c…`. ADR-0016 records this edit.

Apart from these two user-instructed edits, only the user writes the anchor.

### Bootstrap

Every repository's first `readiness-policy/2` needs an `in-session` or `ssh-tag`
approval, because its live policy is v1 or absent (K3b). This covers the
ai-catapult `ACH-C-01`, root `ACH-R-01` and ai-factory `ACH-F-01` plans. Skills'
generation 2 was approved in-session. Skills moves to `default_mode: agent`
through a policy-amendment generation after `ACH-S-06` merges, and that
amendment also needs `in-session` or `ssh-tag`, because the live `accept` list
does not yet contain `agent-self`.

- **Requesting the human form.** A bootstrap generation's `in-session`
  confirmation is requested by the agent as part of publication. Rule (d)
  implies it, so the user does not have to ask for `prompt` mode.
- **Candidate `accept` for each first policy/2** (`ACH-C-01`, `ACH-R-01`,
  `ACH-F-01`) is decided at publication. The candidate may list `agent-self`
  with `default_mode: agent`, so that later plans in that repository can
  self-approve under rule (d). The bootstrap approval itself still needs
  `in-session` or `ssh-tag`. For ai-catapult the choice depends on N3.

**Open decision N3.** The user decides at P-C1 whether repositories created
from the ai-catapult init template start agent-self-capable (accepted and
recorded), or are seeded without `agent-self`, so that their first amendment
needs a human form. This specification does not decide it.

### Release timing (user decision 2026-10-04)

- **Who.** The agent pushes the release tags itself. This replaces P-C2, the
  maintainer step in which a maintainer pushed the ai-catapult tag after
  `ACH-C-06` merged.
  - **ai-catapult:** tag `v0.4.4` at the `ACH-C-06` version-bump merge commit.
    `release.yml` publishes through npm trusted
    publishing under both package names that `scripts/publish-both.sh`
    publishes: `ai-catapult` (the `package.json` name) and
    `@r3dlex/ai-catapult`.
  - **ai-factory:** private and at version `0.0.0`, so nothing is published to
    npm. The tag targets the merge commit of the last ACH goal to merge on
    ai-factory `main`, and gets a GitHub release.
- **When.** Only at the very end, after every ACH plan (skills, ai-catapult,
  root and ai-factory) is complete. `ACH-C-06` still merges the version bump on
  full green; only the tag push moves to the final step.
- **Conditions.**
  - For ai-catapult, the version-bump PR (`ACH-C-06`) has merged on full green.
  - Each tag goes at the exact merge commit named above.
  - The release workflow is watched until it completes.
  - For ai-catapult, npm `latest` and provenance are verified for both package
    names, and the installed-lane status is reported.
  - On any failure the agent stops and reports. It never re-tags over a
    published version.
- **Dropped dependency.** The P-R1 and P-F1 preparation blocker "ACH-C-06
  released, and the installed ai-catapult version equal to it" is dropped. Root
  and ai-factory run from the skills source lane at the O8 commit, verified by
  `readiness-dependency-v2.json`, and the installed lane is report-only, so
  neither depends on an npm release.
- **Cost (accepted with the decision).** The installed plugin lane lags v2
  until the very end. The root and ai-factory plans run from the skills source
  lane at O8, and the installed lane is report-only (see
  [Verification lanes](#verification-lanes)).

## Glossary

- **Plan approval**: a `plan-approval/1` record and its signature or digest-echo record, authorizing one plan generation's implementation and merge stages. It is not a work-item state, and it grants nothing outside the generation, goals and expiry it names. *(Amended by K3; it read "and its signature".)*
- **Trust anchor**: the machine-local allowed-signers file with role-tagged principals.
- **Observer**: the pinned, read-only component that records git and hosted-API facts as `observation/1`. Agents never write observations.
- **Merge certificate**: a `merge-certificate/1` issued only by `run-gates.sh --phase pre-merge` when every merge condition holds at one exact head.
- **Assurance level**: `user-presence`, `key-held`, `in-session` or `agent-self`; it is reported, never upgraded. *(Amended by K3, which adds `agent-self`.)*
- **Proceed**: a human instruction to continue the gate loop. It never maps to a waiver, an exemption or a flag.

## Contract v2 (normative)

### Policy (`readiness-policy/2`)
- **Fixed path:** one file per repository at `.ai/policies/readiness-policy.json`, with `schema: "readiness-policy/2"`, plan-agnostic.
- **Fields:**
  - `repository{id}`
  - `identity_model` (`multi` | `single`)
  - `sources[]` (instruction files, digests observed rather than hand-pinned)
  - `required_checks[]` (hosted check names; only `SUCCESS` passes)
  - `skippable_checks[]` (the only checks whose `SKIPPED` conclusion passes)
  - `branch_pattern`
  - `target`
  - `tools[]`
  - `reviewer_requirements` (`independent_lane: true`)
  - `approval{anchor_sha256, max_age_days: 14, accept, default_mode}`: `accept` lists the accepted forms, drawn from `agent-self`, `in-session` and `ssh-tag`. The optional `default_mode` is `agent`, `prompt` or `ssh-tag`, and the skills baseline template defaults to `agent` (K3); the init seed is open decision N3. *(Amended by K3; it read `accept: ["ssh-tag", "in-session"]`, with no `default_mode`.)*
  - `gates[]`
- **Gate kinds** (fixed set): `ownership`, `review`, `branch_target`, `tooling`, `file_digest`, `git_ancestor`, `hosted_checks`, `plan_approval`, `fixture`, `harness_trust`.
- **Scoping:** gates are repository-scoped. Per-goal values come from the approved bundle, inside the patterns.
- **`not_applicable`:** only `fixture` and `harness_trust` may be marked not applicable, and only with a reason from the fixed enum `no-fixture-dependency` | `no-pinned-harness`.

### Approval (`plan-approval/1`)
- **Fields:**
  - `plan_id`
  - `generation`
  - `bundle_sha256`
  - `spec_sha256`
  - `policy_sha256`
  - `goals[]`
  - `stages: ["implementation", "merge"]`
  - `owner`
  - `reviewer_lane`
  - `issued_at`
  - `expires_at`
  - `anchor_sha256`
  - `assurance`
- **Signature:** for `ssh-tag`, a detached SSH signature (`ssh-keygen -Y sign -n ai-catapult-plan-approval`) over the canonical JSON. It is carried in an **unsigned** annotated tag `approval/<plan_id>/<generation[0:12]>`; `git tag -s` would sign under the `git` namespace instead. Informational copies go to `.ai/approvals/<plan_id>/<generation>.json` and `.sig`. In `agent` mode the agent key signs under `ai-catapult-agent-approval` instead, never under `ai-catapult-plan-approval`. For `in-session` the same tag carries the digest-echo record, with no `.sig`. *(Amended by K3; it described only the `ssh-tag` signature.)*
- **Commands:** `northstar approve` prints the digest and, for `ssh-tag`, the exact `ssh-keygen -Y sign` command for the human to run. `autobahn` verifies the approval: its signature, or the in-session digest-echo record. In `agent` mode it also issues and signs the approval with the agent key (K3). *(Amended by K3; it read "`autobahn` verifies the signature but never signs".)*

### Merge certificate (`merge-certificate/1`)
- **Issuer:** only `run-gates.sh --phase pre-merge`.
- **What it binds:**
  - the plan approval digest
  - the PR number
  - the head and base SHAs
  - the merge-stage admission digest
  - local gate results
  - every `required_checks` entry as `SUCCESS` at that head, completed before issue
  - zero unresolved threads
  - the independent review lane record
  - the admin flag, allowed only when `identity_model: single`
- **Merge refusal:** `merge-authority.sh` (v2) re-observes everything and refuses on any mismatch, on a moved head, on an expired approval, or when no certificate exists. It never accepts an agent-written verdict for v2 plans.

## Delivery (ai-catapult)
- **Pin:** pin the skills commit that delivers v2.
- **Install check:** install fails when the installed contract's sha256 differs from `readiness-dependency.json`, covering the loaded cache, the marketplace directory and the vendored copy.
- **Init:** `init` scaffolds a baseline `readiness-policy/2` (whether the seeded copy lists `agent-self` is open decision N3).
- **Backfill:** `ai-catapult backfill --policy-v2` is an explicit, idempotent, ledgered command for existing repositories, needed because the scaffold is not retroactive.

## Adoption (C-relevant verbatim bullet)
- **Policy approval:** approve one `readiness-policy/2` per repository (root, skills, ai-catapult, ai-factory) with one approval each, in the repository's mode. A signature is required only in `ssh-tag` mode. Each repository's first policy/2 is a bootstrap and needs `in-session` or `ssh-tag` (K3b). *(Amended by K3; it read "with one signature each".)*

## Plans (C-relevant verbatim row)
| Plan | Repo | Scope (authoritative goals in `goals.json`) |
|---|---|---|
| `ach-catapult-delivery` | ai-catapult | The contract pin and install drift failure, the init baseline policy/2, `backfill --policy-v2`, and P4's migration to v2 |

## Acceptance (C-relevant verbatim criterion)
- [ ] AC-8: ai-catapult install fails on any contract drift, and the loaded copy matches canonical.

## Verification lanes
Source, packaged delivery (the `npm pack --ignore-scripts` tarball) and the installed runtime are separate claims. The installed lane is report-only.

## Next action

This specification accompanies the planning-input publication of plan `ach-catapult-delivery`; `DRAFT.json`, `REFRESH.md` and `changeset.json` record the preparation inputs this file supersedes.
