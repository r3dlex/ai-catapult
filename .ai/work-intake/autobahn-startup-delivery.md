---
name: autobahn-startup-delivery
status: in-progress
---

# Deliver the bounded Autobahn startup repair

User explicitly requested the repair across canonical skills, ai-catapult,
ai-factory and affected local consumers. One packaging PR delivers only the
reviewed helper repair; it is not implementation of Northstar small-work profiles.

## Acceptance and bounded plan

1. Preserve the current deployed skill tree except the input repair and evidence.
   Pin the immutable narrow backport `032df6b11cabf0567cbd132c4ac6c60fc37bff06`.
   Avoid unrelated newer invocation and staleness-policy changes.
2. Lock public behavior with unchanged acceptance-linked RED→GREEN checks.
   All three hosts reject missing values and invalid supplied goals promptly
   (exit 2, empty stdout), including under an otherwise valid override.
   Valid goal mapping and override behavior remain unchanged.
3. Rebuild and validate Claude, Codex and OpenCode payloads; compare exact source
   bytes and run all packaging tests. Refresh existing supporting local-CI hashes
   without changing verification or hosted scheduling/merge policy.
4. Independently review, push this repo-owned PR, and install through the existing
   supported installer. Installation does not enable or reload a host.
5. Retry only exact registered `SWP-ROOT-01` admission. Missing readiness/live
   authority stops before engine dispatch, rather than rewriting its artifacts.

## Evidence and exclusions

- [Observed gate-compatible TDD](../evidence/autobahn-startup-delivery.json).
- [Public before/after evidence](../evidence/autobahn-startup-delivery/evidence.json).
- No model/provider changes, runtime inference, downloads or reference-repo edits.
- ai-factory and other managed consumers were audited: no affected executable
  copy/call exists outside canonical skills and ai-catapult vendor/builds.
- Hosted CI, merge admission/authority, installed activation and SWP execution
  readiness remain separate findings; nothing in this issue grants them.
- No prior three-attempt history exists for this independently requested delivery
  repair; verification retries do not authorize an extra implementation attempt.
