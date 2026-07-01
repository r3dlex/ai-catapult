#!/usr/bin/env bash
# verify-vendor.sh — non-mutating gate that checks vendor/skills integrity.
# Exits non-zero (fail closed) if:
#   - vendor/skills directory is absent
#   - vendor/skills/HEAD_SHA does not match the SHA in skills.lock.json
#
# Accepts VENDOR_ROOT env override (used by tests to avoid touching real vendor/).
# Never modifies any files.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

LOCK_FILE="${REPO_ROOT}/skills.lock.json"
VENDOR_ROOT="${VENDOR_ROOT:-${REPO_ROOT}/vendor}"
VENDOR_DIR="${VENDOR_ROOT}/skills"

# --- Read locked SHA from lockfile ---
if [[ ! -f "${LOCK_FILE}" ]]; then
  echo "ERROR: lockfile not found: ${LOCK_FILE}" >&2
  exit 1
fi

# Use node to parse JSON (already required by the project).
# Path is passed via env to avoid shell-injection on paths with quotes/backslashes.
# This script trusts the HEAD_SHA sentinel written by setup.sh — it stays non-mutating
# and offline rather than re-deriving the SHA via git.
LOCKED_SHA="$(LOCK_FILE="${LOCK_FILE}" node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.env.LOCK_FILE,'utf8')).sha)")"

if [[ -z "${LOCKED_SHA}" ]]; then
  echo "ERROR: could not read .sha from ${LOCK_FILE}" >&2
  exit 1
fi

# --- Check vendor directory exists ---
if [[ ! -d "${VENDOR_DIR}" ]]; then
  echo "ERROR: vendor/skills directory not found at ${VENDOR_DIR}" >&2
  echo "       Run setup.sh to vendor skills at SHA ${LOCKED_SHA}" >&2
  exit 1
fi

# --- Check HEAD_SHA file exists ---
HEAD_SHA_FILE="${VENDOR_DIR}/HEAD_SHA"
if [[ ! -f "${HEAD_SHA_FILE}" ]]; then
  echo "ERROR: ${HEAD_SHA_FILE} not found — vendor may be corrupt or from a different setup" >&2
  echo "       Run setup.sh to re-vendor skills at SHA ${LOCKED_SHA}" >&2
  exit 1
fi

# --- Compare SHAs ---
ACTUAL_SHA="$(tr -d '[:space:]' < "${HEAD_SHA_FILE}")"

if [[ "${ACTUAL_SHA}" != "${LOCKED_SHA}" ]]; then
  echo "ERROR: vendor/skills SHA mismatch" >&2
  echo "       locked: ${LOCKED_SHA}" >&2
  echo "       actual: ${ACTUAL_SHA}" >&2
  echo "       Run setup.sh to re-vendor skills at the locked SHA" >&2
  exit 1
fi

echo "OK: vendor/skills is present and matches locked SHA ${LOCKED_SHA}"
