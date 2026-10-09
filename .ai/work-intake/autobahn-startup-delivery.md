---
name: autobahn-startup-delivery
status: delivered
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

## Delivery reconciliation (2026-10-09)

The bounded startup repair is no longer in progress. It landed on `main` through
ai-catapult#50 (merge commit `a87c91258fddad854e250f80045688da147644b7`,
2026-10-03), which replay-committed the reviewed before/after repair as
`cherry-pick -x` of `d396341f2e5badec619894d00547487578f41484` (the bounded
startup validation) and `62600e48e43f9ccb0f5e07a28913af0990f36ca3` (the 0.4.3
release prep), then reconciled `skills.lock.json` onto skills `main`'s `#47` bump
at `26d25105b028903ea1b34aebe9fbf4595b550051`. The shipped `skills.lock.json`
records that lock (`ref: main`).

The pinned narrow backport `032df6b11cabf0567cbd132c4ac6c60fc37bff06` remains
reachable on the kept skills branch `fix/autobahn-startup-delivery-backport-20261002`;
it is not retired, rewritten or force-updated, and the historical evidence above
still records it as that delivery's reviewed skills commit.

Refreshed owner/state note for ai-catapult#46 (independently observed, not acted
on): historically open and owned by `br4vesirrobin`, head branch
`fix/autobahn-startup-delivery-20261002`; it is now `CLOSED` without a merge, its
delivery superseded by #50. This record never closes, rebases, pushes to or merges
#46, and it grants no authority over that PR's branch.
