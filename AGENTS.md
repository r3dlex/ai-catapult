# AGENTS.md

This is the single source of truth for agent-facing operating contracts in this repository.

## Purpose

`ai-catapult` is a deterministic CLI (+ Claude Code and Codex plugins, later slices) that scaffolds
v3 `.ai/` governance into any repository. It has no runtime LLM dependency — all output is
generated from templates at execution time.

## Operating contract

- All implementation work happens in `bin/` and `src/` (src/ added in later slices).
- Tests live in `test/` and run with `node --test` — no external test framework.
- The package is ESM (`"type": "module"`); use `import`/`export` throughout.
- No runtime npm dependencies. Dev dependencies are allowed only for tooling (linting, etc.).
- Commits follow Conventional Commits style.
- Do not push or open PRs without explicit instruction.

## Governance

This repo carries a minimal v3 `.ai/` skeleton (dogfood). See `.ai/matrix.json` for topology.
