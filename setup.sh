#!/usr/bin/env bash
# setup.sh — vendors r3dlex/skills at the SHA pinned in skills.lock.json.
# Idempotent: safe to re-run. Never commits vendor/ (it is gitignored).
# Does NOT use git submodules.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK_FILE="${REPO_ROOT}/skills.lock.json"
VENDOR_DIR="${REPO_ROOT}/vendor/skills"

# --- Read lock ---
if [[ ! -f "${LOCK_FILE}" ]]; then
  echo "ERROR: ${LOCK_FILE} not found" >&2
  exit 1
fi

SKILLS_REPO="$(LOCK_FILE="${LOCK_FILE}" node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.env.LOCK_FILE,'utf8')).repo)")"
LOCKED_SHA="$(LOCK_FILE="${LOCK_FILE}" node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.env.LOCK_FILE,'utf8')).sha)")"
LOCKED_REF="$(LOCK_FILE="${LOCK_FILE}" node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.env.LOCK_FILE,'utf8')).ref)")"

echo "skills lock: ${SKILLS_REPO}@${LOCKED_REF} (${LOCKED_SHA})"

# --- Idempotency check ---
if [[ -f "${VENDOR_DIR}/HEAD_SHA" ]]; then
  CURRENT_SHA="$(tr -d '[:space:]' < "${VENDOR_DIR}/HEAD_SHA")"
  if [[ "${CURRENT_SHA}" == "${LOCKED_SHA}" ]]; then
    echo "vendor/skills already at ${LOCKED_SHA} — nothing to do."
    exit 0
  fi
  echo "vendor/skills is at ${CURRENT_SHA}, re-vendoring to ${LOCKED_SHA}..."
  rm -rf "${VENDOR_DIR}"
fi

# Clear any stale/partial vendor dir left by a previously interrupted run.
# (The idempotency short-circuit above already returned for a healthy, SHA-matched dir.)
[[ -e "${VENDOR_DIR}" ]] && rm -rf "${VENDOR_DIR}"

mkdir -p "$(dirname "${VENDOR_DIR}")"

# --- Clone or fetch at exact SHA ---
# Use a shallow clone of the ref, then checkout the exact SHA.
echo "Cloning ${SKILLS_REPO} (ref: ${LOCKED_REF})..."
git clone --depth=1 --branch "${LOCKED_REF}" "${SKILLS_REPO}" "${VENDOR_DIR}"

# Deepen/fetch the exact commit in case shallow tip differs (should match for main)
ACTUAL_SHA="$(git -C "${VENDOR_DIR}" rev-parse HEAD)"
if [[ "${ACTUAL_SHA}" != "${LOCKED_SHA}" ]]; then
  echo "Shallow tip is ${ACTUAL_SHA}, fetching exact locked SHA ${LOCKED_SHA}..."
  git -C "${VENDOR_DIR}" fetch --depth=1 origin "${LOCKED_SHA}"
  git -C "${VENDOR_DIR}" checkout "${LOCKED_SHA}"
  ACTUAL_SHA="$(git -C "${VENDOR_DIR}" rev-parse HEAD)"
fi

if [[ "${ACTUAL_SHA}" != "${LOCKED_SHA}" ]]; then
  echo "ERROR: checked out SHA ${ACTUAL_SHA} does not match locked SHA ${LOCKED_SHA}" >&2
  exit 1
fi

# Write HEAD_SHA sentinel so verify-vendor.sh can check without running git
echo "${LOCKED_SHA}" > "${VENDOR_DIR}/HEAD_SHA"

echo "OK: vendor/skills vendored at ${LOCKED_SHA}"
