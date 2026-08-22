# Work Item: v3-init-artifacts — complete ai-catapult-init v3 scaffold

- **Traceability node:** `issue:ai-catapult:v3-init-artifacts`
- **Parent effort:** umbrella spec `opencode-omo-harness-convergence` (slice A4),
  tracked at the umbrella root; this file is the in-repo record of the slice.
- **State:** `in_progress` (2026-08-22)

## Summary

The repo carried a partial ai-catapult-init v3 scaffold: `.ai/matrix.json`,
`.ai/handoff/`, and assorted policy dirs existed, but the required workflow and
traceability artifacts were absent, so fail-closed gates (northstar/autobahn
prereq-check) refused the repo root.

## Changes

1. `.ai/phases/{01..04}/status.json` instantiated from the vendored
   `ai-catapult-init` templates (verbatim).
2. `.ai/workflows/repo-workflow.json` instantiated from template with
   `repo_id: "ai-catapult"`.
3. `.ai/traceability/graph.json` seeded as a minimal valid schema-1.1 instance
   rooted at `ai-catapult`, referencing this intake note.

## Acceptance criteria

- [ ] `northstar prereq-check.sh --root .` exits 0 (was failing on 2 missing artifacts).
- [ ] No changes to product code or existing `.ai` content beyond additive artifacts.
