---
name: agents
description: Agent-facing operating contract for example-repo
---

# example-repo

See `.ai/workflows/repo-workflow.md` for the full initialization workflow.

## Harness Map

The six context types available to agents in this repository:

| Context type | Canonical source | Static or dynamic |
|---|---|---|
| `Instructions` | `AGENTS.md`, `.ai/system-prompts/`, `.ai/rules/` | Static |
| `Knowledge` | `docs/architecture/`, `docs/specifications/`, `docs/learning/` | Static |
| `Memory` | `.memory/human-override/`, `.memory/self-learned/` | Dynamic |
| `Examples` | `.ai/evals/<set>/`, `docs/learning/concept-maps/` | Static |
| `Tools` | `.ai/skills/`, `.ai/mcp/registry.json` | Dynamic |
| `Guardrails` | `.ai/rules/security.md`, `.ai/rules/technical-bounds.md`, `.ai/policies/` | Static |

Static context is fixed at task start (instructions, knowledge, examples,
guardrails) and is reviewed and versioned in-repo. Dynamic context is assembled
per-run (memory written by local agents, tool/MCP results resolved at call
time). Moving a context type across the boundary requires an ADR update
(ADR-0005).

## Quick Start

Before starting any task:

1. Read the relevant ADRs in `docs/architecture/adr/`.
2. Load `.ai/rules/security.md` and `.ai/rules/technical-bounds.md`.
3. Check `.ai/phases/` for the current workflow phase status.
4. Apply the four Karpathy rules: Think Before Coding, Simplicity First,
   Surgical Changes, Goal-Driven Execution.

## Architecture Decision Records

Significant architectural decisions are recorded in `docs/architecture/adr/`.
Before making a change that affects module boundaries, API contracts, data
schemas, or dependency direction, check whether a relevant ADR exists.

## Archgate Rules

Code quality rules are defined in `.rules.ts` across five domains: `backend`,
`frontend`, `data`, `architecture`, `general`. Structural validation runs in
CI via the `validate-rules` prek hook. Semantic enforcement is an agent
behavior at PR review time.

## Drift Verification Protocol

At PR review time, the reviewing agent:
1. Loads the PR diff alongside the BRD, PRD, acceptance criteria, and any ADRs
   whose scope overlaps with the changed files.
2. Produces a drift report identifying AC coverage, ADR conflicts, and
   `.rules.ts` violations.
3. Leaves the drift report as a PR comment or review summary.

The reviewing agent must be a separate context from the implementation agent.

## Circuit Breaker Protocol

Before starting work on an issue:
1. Check whether 3 or more prior attempts exist without resolution.
2. If the circuit is tripped, escalate to a human with a written summary of
   what was tried and what blocked each attempt.
3. Do not make a fourth attempt without human acknowledgement.
