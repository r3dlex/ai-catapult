# ai-catapult

Scaffold [init-ai-repo v3 AI-SDLC governance](https://github.com/r3dlex/init-ai-repo) into any repository — no LLM required, no config needed, one command.

## What it does

`ai-catapult` is a deterministic CLI that writes a complete v3 `.ai/` governance skeleton into your repo: directory structure, matrix, system prompts, rules, workflows, traceability wiring, and agent contracts. It also ships as a **Claude Code plugin** and a **Codex plugin** (later slices) so the scaffold runs from inside your AI coding agent without leaving your editor.

It repackages the `init-ai-repo`/`ai-catapult-init` skill as a standalone tool — same output, zero dependency on a running LLM session.

## Install

```sh
npx ai-catapult init
```

Or install globally:

```sh
npm install -g ai-catapult
ai-catapult init
```

## Status

**Early skeleton (Slice 0a).** The `--version` and `--help` flags work. The `init` and `install` subcommands are coming in the next slices.

## Publishing

Both `ai-catapult` (unscoped) and `@r3dlex/ai-catapult` (scoped mirror) will be published to npm. The scoped package lands in a later slice.

## Claude Code plugin

`ai-catapult` ships as a Claude Code plugin that bundles the `ai-catapult-init` skill.

### Build the plugin locally

```sh
bash setup.sh                  # vendor the pinned skill source
npm run build:plugin:claude    # assemble into dist/claude-plugin/
```

The assembled plugin lands in `dist/claude-plugin/` (gitignored — never committed). `.claude-plugin/` holds only the manifests (`plugin.json`, `marketplace.json`); the bundled `skills/ai-catapult-init/` directory sits at the plugin root (`dist/claude-plugin/skills/`).

### Install (future — Slice 7)

Marketplace publish and the `/plugin marketplace add ai-catapult` install path land with Slice 7. Until then, point Claude Code at the local build:

```sh
# coming in Slice 7
```

## License

MIT © Andre Burgstahler (r3dlex)
