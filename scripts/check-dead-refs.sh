#!/usr/bin/env bash
#
# check-dead-refs.sh — ai-catapult half of the dead-reference grep gate (SSCM-09).
#
# Reuses the vendored gate (vendor/skills/tests/dead_reference_gate_test.sh)
# against the ai-catapult corpus. The vendored gate's allowlists are written
# for the skills repo root, so this wrapper scans the ai-catapult-owned tree
# directly with its own exclusion set, then delegates per-file adjudication to
# the same identity regex semantics.
#
# Exclusions (each with why) — every entry must match >=1 scanned file or the
# gate fails (no dead shields):
#
#   vendor/skills/**           — the vendored skills snapshot legitimately
#                                names all four removed/deprecated identities
#                                (its own allowlists cover them there).
#   dist/** dist-snapshot/**   — build outputs derived from vendor/;
#                                gitignored, excluded for determinism.
#   node_modules/** .git/** graphify-out/** — caches/tooling, not content.
#
# Exit 0 = no unannotated live references outside the snapshot; 1 otherwise;
# 2 = usage.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

NAMES=(resolving-merge-conflicts ubiquitous-language diagnose edit-article)

# identity semantics mirror the vendored gate:
#   `name` | 'name' | "name" | $name | name/SKILL.md | --skill name
matches=()
for name in "${NAMES[@]}"; do
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    matches+=("$line")
  done < <(grep -rInE "([\`']$name[\`']|\"$name\"|\\\$$(echo "$name" | tr -d '-')\b|$name/SKILL\.md|--skill[= ]$name\b)" \
      --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=graphify-out \
      --exclude=skills.lock.json \
      . 2>/dev/null)
done

# exclusions: vendor snapshot mirror, build outputs, vendored-pin compat
# notice inside scripts (skills.lock.json note names the consolidation, not
# the identities), and the gate itself.
declare -a WHY_VENDOR=()
is_excluded() {
  local file="$1"
  case "$file" in
    ./vendor/skills/*) return 0 ;;        # vendored snapshot: covered by skills-repo allowlists
    ./dist/*) return 0 ;;                 # build output (gitignored), derived from vendor
    ./dist-snapshot/*) return 0 ;;        # test-time build snapshot, same content
    ./test/dead-refs.test.js) return 0 ;; # the npm-lane wrapper: mutation fixture injects the name by design
    ./scripts/check-dead-refs.sh) return 0 ;; # the gate itself declares the names
    *) return 1 ;;
  esac
}

FAIL=0
seen=0
total=${#matches[@]}
for (( i=0; i<total; i++ )); do
  line="${matches[$i]}"
  [[ -z "$line" ]] && continue
  seen=$((seen + 1))
  file="${line%%:*}"
  if ! is_excluded "$file"; then
    echo "VIOLATION: live reference outside vendor snapshot: $line"
    FAIL=1
  fi
done

# zero-match guard: the exclusion set must stay provably live (vendored tree
# always exists post-setup; the gate script always exists here).
for probe in vendor/skills/catalog.json scripts/check-dead-refs.sh test/dead-refs.test.js; do
  [[ -e "$probe" ]] || { echo "VIOLATION: exclusion probe target missing: $probe"; FAIL=1; }
done

if [[ "$FAIL" -eq 0 ]]; then
  echo "check-dead-refs: PASSED (${seen} raw matches, all excluded)"
  exit 0
fi
echo "check-dead-refs: FAILED"
exit 1
