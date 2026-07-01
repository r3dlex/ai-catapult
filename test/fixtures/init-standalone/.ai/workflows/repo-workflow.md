# example-repo — AI-SDLC Workflow

This document describes the four-phase AI-SDLC initialization workflow for this repository.
For the machine-readable version see `.ai/workflows/repo-workflow.json`.

## Phases

### Phase 01 — Discover & Decide

Profile the repository: detect topology type (standalone vs umbrella), measure
depth, confirm sync strategy, and write `.ai/init/repo-profile.json` and
`.ai/init/sdlc-path.md`. Update `.ai/matrix.json` with the confirmed topology.

**Status file:** `.ai/phases/01-discover-decide/status.json`

---

### Phase 02 — Govern & Plan

Establish governance artifacts: confirm or author ADRs in `docs/architecture/adr/`,
confirm model-routing policy at `.ai/policies/model-routing.json`, decide which
optional branches (cascade, skill-modernization) are enabled.

**Status file:** `.ai/phases/02-govern-plan/status.json`

---

### Phase 03 — Configure & Generate

Emit the full v3 scaffold: traceability graph, workflow manifest, entry files
(AGENTS.md, CLAUDE.md, GEMINI.md), Archgate rules, CI hooks, and all `.ai/`
subdirectory artifacts. Existing files are never overwritten silently.

**Status file:** `.ai/phases/03-configure-generate/status.json`

---

### Phase 04 — Validate & Handoff

Run offline structural validation, emit the validation report, and write the
initialization handoff document at `.ai/handoff/init-ai-repo-handoff.md`.

**Status file:** `.ai/phases/04-validate-handoff/status.json`

---

## Optional Branches

| Branch | Description | Default |
|--------|-------------|---------|
| `multi-repo-cascade` | Cascade inherited-asset propagation to managed sub-repos | disabled |
| `skill-modernization` | Audit and modernize the skill catalog in `.ai/skills/` | disabled |
