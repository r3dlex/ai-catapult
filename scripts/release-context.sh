#!/usr/bin/env bash
# Fail closed before build/publication; never select a different checkout.
set -euo pipefail
[[ $# == 0 ]] || { echo 'release-context: arguments unsupported' >&2; exit 1; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
VERSION="$(node -e 'const v = require("./package.json").version; if (typeof v !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(v)) process.exit(1); process.stdout.write(v)')"
[[ "${GITHUB_REF_TYPE:-}" == tag && "${GITHUB_REF:-}" == "refs/tags/v${VERSION}" ]] || {
  echo 'release-context: run must target the exact v<package version> tag' >&2; exit 1;
}
[[ "$(git rev-parse HEAD)" == "$(git rev-parse --verify "${GITHUB_REF}^{commit}")" ]] || {
  echo 'release-context: checkout does not match the exact release tag commit' >&2; exit 1;
}
case "${GITHUB_EVENT_NAME:-}" in
  push) PACKAGE=both ;;
  workflow_dispatch)
    case "${RELEASE_PACKAGE:-}" in
      both|ai-catapult|@r3dlex/ai-catapult) PACKAGE="$RELEASE_PACKAGE" ;;
      *) echo 'release-context: unsupported or missing package choice' >&2; exit 1 ;;
    esac
    ;;
  *) echo 'release-context: unsupported event' >&2; exit 1 ;;
esac
: "${GITHUB_OUTPUT:?release-context: GitHub output path required}"
printf 'package=%s\n' "$PACKAGE" >> "$GITHUB_OUTPUT"
