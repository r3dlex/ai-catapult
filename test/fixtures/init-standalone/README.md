# example-repo

Deterministic init-ai-repo v3 AI-SDLC governance scaffold.



## Quick Start

```sh
npx ai-catapult install
test -f .ai/matrix.json && test -f .ai/handoff/NEXT-STEPS.md
```

**Expected result:** both generated files exist; `.ai/matrix.json` identifies `example-repo` and `.ai/handoff/NEXT-STEPS.md` lists the in-harness completion step.

## Requirements

- Node.js 18 or newer and Bash.

## Why

Establish reviewable governance before repository-specific decisions are completed in an AI coding agent.

## How it works

**Primary command surface:** `ai-catapult init` for mechanical setup; the `ai-catapult-init` plugin skill for repository-specific decisions.

**Mental model:** Generated files are deterministic review inputs: the CLI writes mechanical state, while the plugin completes judgment-laden governance.

1. Install the CLI with the recommended command.
2. Run the documented command against one target.
3. Confirm the observable result before using additional commands.

## Update

```sh
npm install -g ai-catapult@latest
```





<!-- AI-SDLC:start -->
Repository governance and traceability: see [AGENTS.md](AGENTS.md), [.ai/traceability/](.ai/traceability/).
<!-- AI-SDLC:end -->
