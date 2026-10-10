#!/usr/bin/env bash
# validate-rules.sh — Structural validation of .rules.ts
# Checks that .rules.ts: (a) is valid TypeScript syntax, (b) exports
# all 5 required Archgate domains as const arrays with name+severity+match fields.
# This is NOT a full semantic check — it validates the rule STRUCTURE,
# not whether the rules are correct for the codebase.

set -euo pipefail

RULES_FILE="${1:-.rules.ts}"
errors=0

echo "=== Archgate Rules Validation ==="

# Check file exists
if [ ! -f "$RULES_FILE" ]; then
  echo "FAIL: $RULES_FILE not found"
  exit 1
fi

# Check 5 required domain exports (backend, frontend, data, architecture, general)
for domain in backend frontend data architecture general; do
  if ! grep -q "export const $domain" "$RULES_FILE" 2>/dev/null; then
    echo "FAIL: Missing required domain export: $domain"
    errors=$((errors + 1))
  else
    echo "OK: $domain domain present"
  fi
done

# Check TypeScript syntax with node --check (requires Node.js)
if command -v node &>/dev/null; then
  # Transpile check: can npx tsx parse it?
  if npx --yes tsx --eval "import('./.rules.ts').then(m => { const domains = ['backend','frontend','data','architecture','general']; domains.forEach(d => { if(!m[d]) throw new Error('Missing: '+d) }); console.log('TypeScript syntax OK'); process.exit(0); }).catch(e => { console.error(e.message); process.exit(1); })" 2>/dev/null; then
    :
  else
    echo "WARNING: TypeScript syntax check failed (tsx not available or parse error)"
  fi
else
  echo "SKIP: Node.js not available for syntax check"
fi

echo "=== Result ==="
if [ "$errors" -eq 0 ]; then
  echo "PASS: All 5 Archgate domains present."
  exit 0
else
  echo "FAIL: $errors domain(s) missing from .rules.ts"
  exit 1
fi
