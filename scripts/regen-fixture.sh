#!/usr/bin/env bash
# regen-fixture.sh — regenerate test/fixtures/init-standalone/ from the
# vendored templates using the canonical fixed inputs.
#
# Run this whenever a template changes (e.g. after a vendor bump) and commit
# the updated fixture together with the lockfile/template change in the same PR.
# The parity test in test/init.test.js will then byte-diff `ai-catapult init`
# output against this regenerated fixture.
#
# Fixed canonical inputs (must match FIXED_ARGS in test/init.test.js):
#   --repo-id       example-repo
#   --date          2026-01-01
#   --upstream-url  https://github.com/example-org/example-repo.git
#   --upstream-ref  main

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
FIXTURE_DIR="${REPO_ROOT}/test/fixtures/init-standalone"
BIN="${REPO_ROOT}/bin/ai-catapult.js"

echo "Regenerating fixture at ${FIXTURE_DIR} ..."

# Wipe and recreate so stale files from previous runs don't linger
rm -rf "${FIXTURE_DIR}"
mkdir -p "${FIXTURE_DIR}"

node "${BIN}" init "${FIXTURE_DIR}" \
  --repo-id example-repo \
  --date 2026-01-01 \
  --upstream-url https://github.com/example-org/example-repo.git \
  --upstream-ref main

echo "OK: fixture regenerated. Commit test/fixtures/init-standalone/ together"
echo "    with any lockfile/template changes in the same PR."
