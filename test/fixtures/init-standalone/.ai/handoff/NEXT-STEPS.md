╔══════════════════════════════════════════════════════════════╗
║          ai-catapult — scaffold complete                     ║
╚══════════════════════════════════════════════════════════════╝

Mechanical v3 skeleton scaffolded into:
  .

Key emitted paths (verified on disk):
  • ./.ai/matrix.json
  • ./AGENTS.md

Judgment-laden phases NOT yet written (require in-harness plugin):
  • .ai/handoff/init-ai-repo-handoff.md
  • .ai/traceability/graph.json
  • .ai/traceability/index.md
  • .ai/traceability/validation-report.md
  • docs/architecture/adr/0001-init.md
  • .ai/cascade/cascade-plan.json
  • .memory/human-override/custom-conventions.md
  • .memory/human-override/tribal-knowledge.md
  • .memory/self-learned/error-patterns.json
  • .memory/self-learned/module-complexity.json

── Next step: complete in-harness ─────────────────────────────

1. Install the ai-catapult plugin (install command lands in an upcoming release —
   for now, add the plugin manually or watch the repo):
     npx ai-catapult install

2. Open the scaffolded repo in Claude Code or Codex, then run:
     Claude Code:  /ai-catapult-init
     Codex:        invoke the ai-catapult-init skill

The ai-catapult-init skill will guide you through topology decisions,
ADRs, cascade configuration, and traceability — the judgment-laden
phases that require knowledge of your specific repository.
────────────────────────────────────────────────────────────────