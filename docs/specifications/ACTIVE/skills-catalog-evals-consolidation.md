# Spec (repo slice): skills-catalog-evals-consolidation in ai-catapult

- **Canonical spec:** umbrella `r3dlex/ai-tool-workspace` → `docs/specifications/ACTIVE/skills-catalog-evals-consolidation.md`
- **Canonical spec SHA-256:** `79e3295adbb1ddabcca921b8bdd567f596f5202ada581d8a2ed5afbfeb9ece3d`
- **This file:** the ai-catapult goals of that plan, so autobahn can admit them from this repo's root. Acceptance criteria and verification details live in the canonical spec; on any conflict, the canonical spec wins.
- **State:** planned; wave-1 goals have direct-goal intake files under `.ai/handoff/autobahn-goals/`.

## Goals in this repo

### SCE-S11
- **Wave 1:** yes
- **Covers:** AC-10, AC-11, G3, G8
- **Scope:** `lock-bump.yml` poller (6 h `schedule` + dispatch, `permissions: contents/pull-requests/actions: write`): compares skills main HEAD with the lock; re-vendors, regenerates fixtures, runs `npm test`; opens or updates **one rolling PR** with the diff + skills log, marked failing with the log when tests are red; dispatches `ci.yml` (which gains `workflow_dispatch`) on that branch; no-op when current; never merges, tags or publishes. Its branch holds only bot commits, and hand edits go in S12a

### SCE-S10
- **Wave 1:** yes
- **Covers:** G7, AC-12, AC-13
- **Scope:** OpenCode `.ai-catapult-owned.json` `{version, skills[], commands[]}` + prune of previously owned entries the new manifest drops; one-time seed from the current manifest; tmpdir tests (first install, prune after a manifest shrink, foreign dir kept, version recorded, idempotent)

### SCE-S12a
- **Wave 1:** no (depends: SCE-S4b)
- **Covers:** AC-9
- **Scope:** Hand-authored sweep: re-point `scripts/opencode-commands/northstar.json` `delegates_to` to `grilling` / `to-tickets` (safe at any lock, since both exist today); classify every `init-ai-repo` use as identifier (allowlist with reason) or skill reference (rename); add a test that every `delegates_to` resolves to a bundled skill or a declared external tool. Add the 7 names to `check-dead-refs.sh` here (it already excludes `vendor/skills/**`, `check-dead-refs.sh:50`). Identifier allowlist by path glob with reasons: `test/fixtures/init-standalone/**`, `.ai/**`, `package.json`, `scripts/build-*.sh` (these survive bot fixture regeneration)

### SCE-S12
- **Wave 1:** no (depends: SCE-S9, SCE-S11, SCE-H4, SCE-S12a)
- **Covers:** AC-9
- **Scope:** Merge the S11 rolling PR once it sits at the post-S9 SHA. Then a **separate follow-up PR** (the bot branch only ever holds bot commits): `package.json` → 0.5.0 and a lock-keyed assertion that 29 skills are bundled
