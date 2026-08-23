# ai-catapult

Deterministic AI-SDLC scaffolding for repositories and AI coding agents. One pinned contract creates reviewable governance files from the CLI; plugins let Claude Code and Codex complete the repository-specific decisions.

## Language

### Core Concepts

**Scaffold (`init`)**:
The deterministic CLI command that renders v3 `.ai/` governance into a target repository from pinned templates. The same inputs, including `--date`, produce byte-identical output. No runtime LLM or npm dependency participates in rendering.
_Avoid_: generator, bootstrap, setup script

**Harness**:
A supported AI coding agent host that receives ai-catapult content: Claude Code, Codex, and OpenCode today. The installer detects harnesses by default or takes an explicit `--harness` choice.
_Avoid_: platform, environment, IDE

**Plugin**:
A per-harness bundle of the pinned `ai-catapult-init` skill plus slash commands, installed by `npx ai-catapult install` so an agent can finish what the CLI scaffolded.
_Avoid_: extension, addon, integration

**Mechanical vs judgment-laden split**:
The operating boundary of the whole tool. Mechanical work (copying pinned templates, invoking the README generator, writing registration instructions) belongs to the CLI alone. Judgment-laden work (topology, ADR, cascade, and traceability decisions) belongs to the plugin running inside a harness.
_Avoid_: backend/frontend, automatic/manual

**Pinned contract**:
The versioned source of truth - templates, the canonical README generator, and bundled skill bodies - whose exact bytes define every generated artifact. Plugins bundle the same source contract rather than a paraphrase of it.
_Avoid_: defaults, config, spec

**Boundary manifest**:
The selection input that determines which governance and automation artifacts `init` renders into a target (`.ai/`, `.github/`, `ci/`, `graph-automation/`). Changing scope means changing the manifest, never ad-hoc copies.
_Avoid_: file list, include list

**Governance artifacts**:
The reviewable outputs of `init`: `.ai/matrix.json` (repository identity and topology inputs), `AGENTS.md`/`CLAUDE.md`/`GEMINI.md` (agent-facing contract), and `.ai/handoff/NEXT-STEPS.md` (what was generated and what still needs the plugin).
_Avoid_: runtime state, hidden state

**Safe repeat run**:
An `init` invocation against an already-scaffolded repository. A second run refuses before writing unless `--force` is passed; forced replacement SHA-checks and backs up existing `README.md` content and records the replacement in an audit manifest.
_Avoid_: idempotent update, re-run
