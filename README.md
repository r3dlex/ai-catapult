# ai-catapult

Scaffold [init-ai-repo v3 AI-SDLC governance](https://github.com/r3dlex/init-ai-repo) into any repository — no LLM required, no config needed, one command.

## What it does

`ai-catapult` is a deterministic CLI that writes a complete v3 `.ai/` governance skeleton into your repo: directory structure, matrix, system prompts, rules, workflows, traceability wiring, and agent contracts. It also ships as a **Claude Code plugin** and a **Codex plugin** so the scaffold runs from inside your AI coding agent without leaving your editor.

It repackages the `init-ai-repo`/`ai-catapult-init` skill as a standalone tool — same output, zero dependency on a running LLM session.

## Quick start

```sh
# Scaffold governance skeleton into the current directory
npx ai-catapult init

# Then install the plugin into detected harnesses (Claude Code and/or Codex)
npx ai-catapult install
```

Or install globally:

```sh
npm install -g ai-catapult
ai-catapult init
ai-catapult install
```

## Commands

### `ai-catapult init [target]`

Scaffold the mechanical v3 `.ai/` governance skeleton into `<target>` (default: current directory).

```
Options:
  --repo-id <id>         Repository identifier          (default: basename of target)
  --date <YYYY-MM-DD>    Scaffold date token             (default: today)
  --upstream-url <url>   Upstream git URL for matrix.json
  --upstream-ref <ref>   Upstream git ref                (default: main)
  --force                Overwrite existing files without error
  -h, --help             Show help
```

### `ai-catapult install`

Install the ai-catapult plugin into detected AI coding harnesses.

Harnesses detected automatically:
- **Claude Code** — `~/.claude/` present
- **Codex** — `${CODEX_HOME:-~/.codex}/` present

```
Options:
  --harness <claude|codex|all>   Select harness(es) (default: auto-detect)
  --dry-run                      Print what would happen without writing
  --force                        Overwrite even if dir contains a foreign plugin
  -h, --help                     Show help
```

After install, reload Claude Code and run `/ai-catapult-init` to complete the in-harness judgment-laden phases.

## Claude Code plugin

`ai-catapult` ships as a Claude Code plugin bundling the `ai-catapult-init` skill.

### Install path

Plugin is placed at:
```
~/.claude/plugins/cache/ai-catapult-local/ai-catapult/local/
```

`installed_plugins.json` is updated so Claude Code picks it up on next reload. Alternatively, add the plugin manually via:
```sh
/plugin marketplace add ~/.claude/plugins/cache/ai-catapult-local/ai-catapult/local
```

### Build the plugin locally

```sh
bash setup.sh                  # vendor the pinned skill source
npm run build:plugin:claude    # assemble into dist/claude-plugin/
```

## Codex plugin

`ai-catapult` ships as a Codex plugin bundling the `ai-catapult-init` skill.

### Install path

Plugin payload lands at:
```
${CODEX_HOME:-~/.codex}/plugins/cache/ai-catapult-local/ai-catapult/local/
```

A marketplace registration file is written at:
```
${CODEX_HOME:-~/.codex}/plugins/ai-catapult-local/marketplace.json
```

### Build the plugin locally

```sh
bash setup.sh                  # vendor the pinned skill source
npm run build:plugin:codex     # assemble into dist/codex-plugin/
```

## Publishing

Both `ai-catapult` (unscoped) and `@r3dlex/ai-catapult` (scoped mirror) are published to npm.

### Dry-run (safe, default)

```sh
bash scripts/publish-both.sh
```

### Real publish (double-gated)

```sh
AI_CATAPULT_PUBLISH=1 bash scripts/publish-both.sh --yes
```

Semver-tagged releases are automated via `.github/workflows/release.yml` (requires `NPM_TOKEN` in repo secrets).

## License

MIT © Andre Burgstahler (r3dlex)
