# Codex Native Install Target

## Install target and registration mechanism

Confirmed against the **oh-my-codex plugin contract** (documented manifests + docs cited below); runtime verification against the live Codex CLI is deferred to Slice 7.

The Codex plugin system places installed plugins under:

```
${CODEX_HOME:-~/.codex}/plugins/cache/$MARKETPLACE_NAME/$PLUGIN_NAME/$VERSION/
```

For local installs the version identifier may be `local`.

Registration is driven by a **marketplace file** — a JSON document that the Codex CLI reads to discover which plugins are available and where their source lives. The marketplace file lists each plugin with a `source` object (either `"local"` with a `path`, or a remote `"npm"` / `"url"` source) and a `policy` object.

### Example marketplace file

The canonical example is `.agents/plugins/marketplace.json` in the oh-my-codex repo:

```json
{
  "name": "oh-my-codex-local",
  "interface": { "displayName": "oh-my-codex Local Plugins" },
  "plugins": [
    {
      "name": "oh-my-codex",
      "source": {
        "source": "local",
        "path": "./plugins/oh-my-codex"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Developer Tools"
    }
  ]
}
```

For `ai-catapult` the equivalent marketplace entry would point `source.path` at the assembled `dist/codex-plugin/` directory (or a published npm package once available).

### Plugin bundle layout contract

Each plugin directory must contain:

```
<plugin-root>/
  .codex-plugin/plugin.json   — manifest (name, version, description, skills, interface)
  skills/                     — skill directories, each with a SKILL.md
```

The `plugin.json` manifest fields are:

| Field         | Required | Notes |
|---------------|----------|-------|
| `name`        | yes      | Must match the marketplace entry name |
| `version`     | yes      | Semver string |
| `description` | yes      | Human-readable summary |
| `skills`      | yes      | Relative path to skills dir, e.g. `"./skills/"` |
| `interface`   | yes      | Object with at least `displayName`; may include `shortDescription`, `category` |
| `mcpServers`  | no       | Path to an MCP servers JSON file |
| `apps`        | no       | Path to an apps JSON file |
| `hooks`       | no       | Path to a hooks JSON file (for plugin-scoped lifecycle hooks) |

### Source files cited

- `.agents/plugins/marketplace.json` in `oh-my-codex` — canonical marketplace file showing `source.local` + `path` registration pattern
- `plugins/oh-my-codex/.codex-plugin/plugin.json` in `oh-my-codex` — canonical plugin manifest schema (all fields)
- `docs/troubleshooting.md` in `oh-my-codex` — confirms cache path `${CODEX_HOME:-~/.codex}/plugins/cache/$MARKETPLACE_NAME/$PLUGIN_NAME/$VERSION/`
- `docs/plugin-bundle-ssot.md` in `oh-my-codex` — plugin bundle SSOT contract (skills dir, manifest paths, sync/verify commands)

## What Slice 7 must implement

Slice 7 will wire the actual install: produce a marketplace file (e.g. `dist/marketplace.json` or `.agents/plugins/marketplace.json`) pointing at `dist/codex-plugin/` (local source) or a published npm artifact (remote source), so that `codex plugin install` or the Codex CLI plugin discovery mechanism can locate and register `ai-catapult`. This document should be updated once the install target is confirmed against the live Codex CLI.
