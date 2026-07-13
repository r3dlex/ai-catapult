#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
bash scripts/build-claude-plugin.sh
bash scripts/build-codex-plugin.sh
bash scripts/stage-skill-templates.sh
bash scripts/stage-readme-contract.sh
bash scripts/stage-matrix-runtime.sh
bash scripts/stage-ci-adapters-runtime.sh
bash scripts/snapshot-dist.sh
