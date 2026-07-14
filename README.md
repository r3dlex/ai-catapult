# ai-catapult

Deterministic AI-SDLC scaffolding for repositories and AI coding agents.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## Quick Start

```sh
npx ai-catapult init .
test -f .ai/matrix.json && test -f .ai/handoff/NEXT-STEPS.md
```

**Expected result:** the command exits 0 and both generated files exist; `.ai/matrix.json` identifies the repository and `.ai/handoff/NEXT-STEPS.md` names the in-harness completion step.

## Requirements

- Node.js 18 or newer and Bash.

## Why

Use one pinned contract to create reviewable governance files from the CLI and complete repository-specific decisions in Claude Code or Codex.

## Choose the CLI or a plugin

Use the CLI for deterministic, no-LLM setup:

```sh
npx ai-catapult init [target]
```

Use a plugin when the mechanical scaffold exists and an agent needs to complete topology, ADR, cascade, or traceability decisions:

```sh
npx ai-catapult install
```

- Claude Code: reload the host, then run `/ai-catapult-init`.
- Codex: enable the installed local plugin, then invoke the `ai-catapult-init` skill.

The installer detects Claude Code and Codex by default. Pass `--harness claude`, `--harness codex`, or `--harness all` to choose explicitly. It prints registration instructions and does not mutate Claude Code internal state or Codex `config.toml`.

## How it works

**Primary command surface:** `ai-catapult init` creates deterministic mechanical state; the Claude Code and Codex plugins run the same pinned `ai-catapult-init` skill for judgment-laden work.

**Mental model:** Generated files are reviewable outputs, not hidden runtime state. The CLI copies pinned templates and invokes the canonical README generator; plugins bundle that same source contract.

- `.ai/matrix.json` records repository identity and topology inputs.
- `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md` expose the agent-facing contract.
- `.ai/handoff/NEXT-STEPS.md` records what was generated and what still needs the plugin.
- `.ai/`, `.github/`, `ci/`, and `graph-automation/` contain deterministic governance and automation artifacts selected by the pinned boundary manifest.

The same inputs, including `--date`, produce byte-identical output. No runtime LLM or npm dependency is used to render the scaffold.

## Safe repeat runs

- A second `init` refuses before writing when generated files or `README.md` already exist.
- Pass `--force` only when replacing generated state is intentional. Existing `README.md` content is SHA-checked, backed up under `.ai/drift/readme-backups/`, and recorded in an audit manifest before replacement.
- Plugin builds and packaged CLI artifacts copy the generator and template from the SHA pinned in `skills.lock.json`; they do not maintain a second README generator.
- `install` refuses to replace a foreign plugin directory unless `--force` is supplied. Use `--dry-run` to inspect installation paths without writing.

Run `npx ai-catapult init --help` or `npx ai-catapult install --help` for the full option lists.

## Update

`npx` resolves the requested package when it runs. For a global installation, update explicitly:

```sh
npm install -g ai-catapult@latest
```

Source checkouts refresh the pinned skill and rebuild artifacts with:

```sh
bash setup.sh
bash scripts/prepare-dist.sh
```

## Troubleshooting

- **`init would overwrite existing file`** — inspect the existing scaffold first; rerun with `--force` only when replacement is intended.
- **`canonical README contract not found`** — in a source checkout, run `bash setup.sh` and `bash scripts/stage-readme-contract.sh`. Reinstall the npm package if the error comes from `npx`.
- **Plugin installed but not visible** — reload the host and complete its printed registration steps. Codex registration details are in [docs/codex-install.md](docs/codex-install.md).
- **Vendor SHA mismatch** — run `bash setup.sh`, then `bash scripts/verify-vendor.sh`. The checkout must match `skills.lock.json` exactly.

## Documentation

- [Codex installation and registration](docs/codex-install.md)
- [Agent operating contract](AGENTS.md)
- [Pinned upstream skill source](skills.lock.json)
- Run `npx ai-catapult --help` for CLI commands and `npx ai-catapult <command> --help` for command-specific options.

## License

MIT — see [LICENSE](LICENSE).

<!-- AI-SDLC:start -->
Repository governance and traceability: see [AGENTS.md](AGENTS.md), [.ai/traceability/](.ai/traceability/).
<!-- AI-SDLC:end -->
