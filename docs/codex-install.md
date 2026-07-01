# Codex Native Install Target

## Install target and registration mechanism

Confirmed against the **oh-my-codex plugin contract** (documented manifests + docs cited below) and against the real `~/.codex-reverso/config.toml` pattern.

The Codex plugin system places installed plugins under:

```
${CODEX_HOME:-~/.codex}/plugins/cache/$MARKETPLACE_NAME/$PLUGIN_NAME/$VERSION/
```

For local installs the version identifier is `local`.

### How Codex discovers plugins

Codex reads plugin registration from **config.toml** (not from a standalone `marketplace.json` file). Two TOML tables are required:

```toml
[marketplaces.<marketplace-name>]
source_type = "local"
source = "<path-to-plugin-payload>"

[plugins."<plugin-name>@<marketplace-name>"]
enabled = true
```

The `source` for a local install points at the directory containing the `.codex-plugin/plugin.json` manifest (i.e. the cache path shown above).

### What `ai-catapult install` does

Running `npx ai-catapult install` (or `ai-catapult install --harness codex`):

1. **Copies the pre-built plugin payload** to:
   ```
   ${CODEX_HOME:-~/.codex}/plugins/cache/ai-catapult-local/ai-catapult/local/
   ```
   The payload includes `.codex-plugin/plugin.json` and the `skills/` directory.

2. **Prints the exact TOML block** the user must add to their `config.toml`:
   ```toml
   [marketplaces.ai-catapult-local]
   source_type = "local"
   source = "<installed payload path>"

   [plugins."ai-catapult@ai-catapult-local"]
   enabled = true
   ```

The installer does **not** auto-mutate `config.toml` — that would be too invasive and carries corruption risk. The user adds the printed block manually.

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

Note: this JSON format is a marketplace *description* file used internally by oh-my-codex. Codex CLI itself discovers plugins via `config.toml` as described above.

### Source files cited

- `~/.codex-reverso/config.toml` lines ~214-218 — real `[marketplaces.<name>]` + `[plugins."<plugin>@<marketplace>"]` pattern for `oh-my-codex-local`
- `.agents/plugins/marketplace.json` in `oh-my-codex` — canonical marketplace file showing `source.local` + `path` registration pattern
- `plugins/oh-my-codex/.codex-plugin/plugin.json` in `oh-my-codex` — canonical plugin manifest schema (all fields)
- `docs/troubleshooting.md` in `oh-my-codex` — confirms cache path `${CODEX_HOME:-~/.codex}/plugins/cache/$MARKETPLACE_NAME/$PLUGIN_NAME/$VERSION/`
- `docs/plugin-bundle-ssot.md` in `oh-my-codex` — plugin bundle SSOT contract (skills dir, manifest paths, sync/verify commands)
