# ADR-0001: TypeScript rename-wave packaging (build, shipped output, execution mechanism, local-ci/2 binding)

- **Status:** Accepted — 2026-10-10
- **Scope:** goal `tswc-ac-a2` (readiness generation `tswc-ai-catapult/ac3b276da28549b293a68f93058821febe1f7736a1f230a416ddc8c2aa7d2d1d`, AC-1..AC-8)
- **Recording homes:** this ADR is the TSF-04 recording home (every removed `.js`/`.sh`/`.py` first-party path → replacement owner) and the source-policy disposition record demanded by the retained C10.03 workspace rule for the A2-driven bootstrap/toolchain/output changes.

## Context

The repo-wide rename wave converts every first-party tracked `.js`, `.sh` and `.py`
source to strict TypeScript and removes the old paths in the same PR
(AC-1/AC-2), rewires `package.json`, the GitHub workflows, the README quick
start, and the hash-bound local-ci/2 source inventory (AC-3/AC-7), and keeps a
lint/typecheck gate set over the converted tree (AC-6). AGENTS.md's operating
contract stays normative throughout: ESM (`"type": "module"`), no external test
framework (`node --test`), no runtime npm dependencies.

## Decisions

### D1 — Build step

`npm run build` is `tsc -p tsconfig.build.json && node scripts/prepare-dist.ts`:

1. `tsc -p tsconfig.build.json` compiles `bin/`, `src/`, `scripts/` to
   `dist/<rootDir-path>/` with emitted `.js`, `.d.ts` and `.js.map`. This is the
   compile-clean proof of the wave and part of the shipped compiled output.
2. `scripts/prepare-dist.ts` (port of the removed `prepare-dist.sh`) stages the
   publishable payload trees into `dist/`: `dist/claude-plugin/`,
   `dist/codex-plugin/`, `dist/opencode-plugin/`, `dist/skill-templates/`,
   `dist/readme-contract/`, `dist/.ai/knowledge/contract/`,
   `dist/03-configure-generate/`, and `dist/matrix-runtime.py`, then snapshots
   the tree to `dist-snapshot/` (`scripts/snapshot-dist.ts`, port of the removed
   `snapshot-dist.sh`). `test/` consumes the snapshot through
   `AI_CATAPULT_DIST_ROOT=dist-snapshot` so suite runs and pack runs stay race-free.

`npm run prepack` is `node scripts/setup.ts && npm run build`:
`scripts/setup.ts` (port of the removed `setup.sh`) bootstraps `vendor/` from
the skills commit pinned by `skills.lock.json` before the build chain runs.

### D2 — Shipped compiled output (AC-3 interpretation, disclosed)

> Errata (review round 1, 2026-10-10): the bin map below is superseded — see Errata 1.

`package.json` `files[]` keeps `dist/`, `bin/`, `src/` and the `scripts/*.ts`
builders; the npm `bin` map is `"ai-catapult": "bin/ai-catapult.ts"`. AC-3's
parenthetical ("bin → dist output") is interpreted as the faithful rewire the
session decided: the emitted `dist/bin/ai-catapult.js` (+ `.d.ts`/map) and
`dist/src/*.js` are the compiled companions that ride the package, while the
`bin`-of-record stays the tracked `bin/ai-catapult.ts`, executed directly by
Node type stripping. `files[]` renames each `scripts/*.sh`/`scripts/*.js` entry
to its `.ts` replacement; `setup.sh`'s entry becomes `scripts/setup.ts`.

Zero runtime dependencies are preserved: `dependencies` stays empty;
`typescript`, `typescript-eslint`, `eslint`-related packages and `@types/node`
remain devDependencies only (AGENTS.md contract, master §2/§4.1).

Vendored artifact disclosure: `dist/matrix-runtime.py` is vendored Python
(`vendor/skills/scripts/matrix-contract.py`, pinned by `skills.lock.json`),
staged by `stage-matrix-runtime.ts`. It is not first-party implementation; the
repo's only first-party `.py` tail (`test/fixtures/readiness-delivery.py`)
converts to TypeScript (TSF-03) in the same PR.

### D3 — Node/CI test-execution mechanism

`npm test` is `AI_CATAPULT_DIST_ROOT=dist-snapshot node --test test/*.test.ts`
(AGENTS.md: no external test framework). Two disclosed mechanics:

- **Glob scope is deliberate.** Main ran bare `node --test`, whose implicit
  discovery treats *every* file under a `test/` directory as a test file. Once
  the tracked `.ts` fixture `test/fixtures/readiness-delivery.ts` existed (its
  `.py` predecessor had been invisible to that discovery), plain `node --test`
  would pick it up as a test file and fail collection. The explicit
  `test/*.test.ts` glob scopes discovery to exactly the 37 suites.
- **Node floor is truthful to the runtime need.** `engines` moves from `">=18"`
  to `">=22.18"`: Node v22.18.0 (LTS line, release notes July 2025) is where
  running `.ts` entrypoints via type stripping is default-on, which is how the
  shipped `bin/ai-catapult.ts` and every test file execute. (Errata, review
  round 1: installed execution of the shipped CLI does NOT rely on type
  stripping — see Errata 1 and 2.) CI pins
  `node-version: '22'` on all four `ci.yml` jobs; workflow commands are rewired
  from shells to `node scripts/setup.ts`, `node scripts/verify-vendor.ts`, and
  (in `release.yml`) `node scripts/release-context.ts`, `node scripts/setup.ts`,
  `node scripts/verify-vendor.ts`, `node scripts/publish-both.ts` on both
  branches, `bin/ai-catapult.ts`, with the header comment flipped `.sh` → `.ts`.

### D4 — TSF-04: removed path → replacement owner (complete recording)

Every removed first-party path retires in this PR. Committed renames keep the
implementing module identical; entries below record the owner each old path
delegates to from this PR onward.

| Removed path | Replacement owner |
|---|---|
| `bin/ai-catapult.js` | `bin/ai-catapult.ts` |
| `src/ci-adapters-runtime.js` | `src/ci-adapters-runtime.ts` |
| `src/contract-drift.js` | `src/contract-drift.ts` |
| `src/graph-hooks.js` | `src/graph-hooks.ts` |
| `src/install.js` | `src/install.ts` |
| `src/knowledge.js` | `src/knowledge.ts` |
| `src/matrix-runtime.js` | `src/matrix-runtime.ts` |
| `src/readme-contract.js` | `src/readme-contract.ts` |
| `src/scaffold.js` | `src/scaffold.ts` |
| `src/skill-resolver.js` | `src/skill-resolver.ts` |
| `scripts/build-claude-plugin.sh` | `scripts/build-claude-plugin.ts` |
| `scripts/build-codex-plugin.sh` | `scripts/build-codex-plugin.ts` |
| `scripts/build-opencode-plugin.sh` | `scripts/build-opencode-plugin.ts` |
| `scripts/check-dead-refs.sh` | `scripts/check-dead-refs.ts` |
| `scripts/list-bundled-skills.js` | `scripts/list-bundled-skills.ts` |
| `scripts/prepare-dist.sh` | `scripts/prepare-dist.ts` |
| `scripts/publish-both.sh` | `scripts/publish-both.ts` |
| `scripts/regen-fixture.sh` | `scripts/regen-fixture.ts` |
| `scripts/release-context.sh` | `scripts/release-context.ts` |
| `scripts/resolve-vendor-skill.js` | `scripts/resolve-vendor-skill.ts` |
| `scripts/snapshot-dist.sh` | `scripts/snapshot-dist.ts` |
| `scripts/stage-ci-adapters-runtime.sh` | `scripts/stage-ci-adapters-runtime.ts` |
| `scripts/stage-matrix-runtime.sh` | `scripts/stage-matrix-runtime.ts` |
| `scripts/stage-readme-contract.sh` | `scripts/stage-readme-contract.ts` |
| `scripts/stage-skill-templates.sh` | `scripts/stage-skill-templates.ts` |
| `scripts/verify-vendor.sh` | `scripts/verify-vendor.ts` |
| `setup.sh` | `scripts/setup.ts` |
| `test/autobahn-startup.test.js` | `test/autobahn-startup.test.ts` |
| `test/bundled-skills.test.js` | `test/bundled-skills.test.ts` |
| `test/ci-adapters-distribution.test.js` | `test/ci-adapters-distribution.test.ts` |
| `test/claude-plugin.test.js` | `test/claude-plugin.test.ts` |
| `test/codex-plugin.test.js` | `test/codex-plugin.test.ts` |
| `test/contract-drift.test.js` | `test/contract-drift.test.ts` |
| `test/dead-refs.test.js` | `test/dead-refs.test.ts` |
| `test/dpua-distribution.test.js` | `test/dpua-distribution.test.ts` |
| `test/finish-prompt.test.js` | `test/finish-prompt.test.ts` |
| `test/graph-hooks.test.js` | `test/graph-hooks.test.ts` |
| `test/init.test.js` | `test/init.test.ts` |
| `test/install.test.js` | `test/install.test.ts` |
| `test/knowledge-conformance.test.js` | `test/knowledge-conformance.test.ts` |
| `test/knowledge-contract.test.js` | `test/knowledge-contract.test.ts` |
| `test/opencode-e2e.test.js` | `test/opencode-e2e.test.ts` |
| `test/opencode-host.test.js` | `test/opencode-host.test.ts` |
| `test/opencode-install.test.js` | `test/opencode-install.test.ts` |
| `test/opencode-plugin-build.test.js` | `test/opencode-plugin-build.test.ts` |
| `test/pack.test.js` | `test/pack.test.ts` |
| `test/packed-init.test.js` | `test/packed-init.test.ts` |
| `test/publish-both.test.js` | `test/publish-both.test.ts` |
| `test/publish-lifecycle.test.js` | `test/publish-lifecycle.test.ts` |
| `test/publish-recovery.test.js` | `test/publish-recovery.test.ts` |
| `test/readiness-delivery.test.js` | `test/readiness-delivery.test.ts` |
| `test/readiness-policy.test.js` | `test/readiness-policy.test.ts` |
| `test/readme-contract.test.js` | `test/readme-contract.test.ts` |
| `test/release-0.4.3.test.js` | `test/release-0.4.3.test.ts` |
| `test/release-dispatch.test.js` | `test/release-dispatch.test.ts` |
| `test/release-workflow.test.js` | `test/release-workflow.test.ts` |
| `test/scoped-mirror-staging.test.js` | `test/scoped-mirror-staging.test.ts` |
| `test/setup.test.js` | `test/setup.test.ts` |
| `test/skill-resolver.test.js` | `test/skill-resolver.test.ts` |
| `test/tswc-v2-migration.test.js` | `test/tswc-v2-migration.test.ts` |
| `test/vendor.test.js` | `test/vendor.test.ts` |
| `test/vendored-staleness.test.js` | `test/vendored-staleness.test.ts` |
| `test/version.test.js` | `test/version.test.ts` |
| `test/xskp-p4-v2-migration.test.js` | `test/xskp-p4-v2-migration.test.ts` |
| `test/fixtures/readiness-delivery.py` | `test/fixtures/readiness-delivery.ts` (TSF-03: project-owned Python delivery harness converted; retires the handwritten Python tail) |

Explicitly **retained** non-TS files (no conversion, with owner attribution):

- `test/fixtures/init-standalone/graph-automation/graph-refresh.sh` and
  `.../hook-body.sh` — the committed golden emitted tree of the init graph
  automation, attributed to the reviewed TypeScript generator (`src/graph-hooks.ts`);
  carried under the AC-2 emission disposition. Byte-identical fixtures; not
  handwritten repo implementation.
- `test/fixtures/init-standalone/.rules.ts` — fixture *data* for the emitted
  scaffold (a template render), not project implementation; excluded from
  `tsconfig` (via `include`/`exclude`) and from `eslint`.
- `eslint.config.js` — ESLint flat config must be a JS module; it is tooling
  configuration, not implementation, and disables type-aware rules for itself
  and any transitional `.js` via the existing `**/*.js` override.

Added modules with no removed predecessor (extracted during the port):
`src/paths.ts`, `scripts/build-plugin-lib.ts`, `scripts/stage-knowledge-contract.ts`.

After this PR the tracked first-party source tree contains no `.js`, `.sh` or
`.py` implementation: the only tracked non-TS code files are the three retained
surface entries above (verified by `git ls-files | grep -E "\\.(js|sh|py)$"`).

### D5 — local-ci/2 refresh and bootstrap binding (AC-7)

`.ai/ci/local-ci.json` stays `schema: local-ci/2`, hash-pinned per file for
every touched source and workflow (AC-7: "refreshed for every touched file"),
and `verification` stays `["npm test"]` per the repo's documented local
verification (README). Bootstrap is `["npm ci"]` (re-approval amendment below).
Disclosure trail:

- The vendored byte-locked contract allows bootstrap only in three forms:
  `npm ci`, `npm ci --ignore-scripts`, or `bash <pinned source>`. Post-wave,
  the `bash <pinned source>` form is impossible (`setup.sh` no longer exists and
  the vendored contract has no `node <pinned source>` bootstrap form). The npm
  forms require a pinned `package-lock.json`, which is therefore tracked,
  committed, kept in sync, and added to the pinned source set. Matched support
  was verified against the vendored authority
  (`vendor/skills/tests/local_ci_contract_v2_test.py` /
  `vendor/skills/04-validate-handoff/autobahn/lib/local_ci_contract.py`) —
  actual matched local-ci/2 support, not a policy assumption.
- **Source-policy disposition** (retained C10.03 workspace rule, verbatim from
  the plan_amendments attachment): *"A2-driven bootstrap/toolchain/output
  changes require explicit source-policy disposition and actual matched
  local-ci/2 support before final binding."* This ADR is that explicit
  disposition for the bootstrap change (`npm ci --ignore-scripts`), the
  toolchain changes (tsconfig/tsconfig.build, `eslint.config.js`, prek hooks,
  package.json scripts/engines/files/bin), the output changes (dist-emitted
  compiled output, dist-snapshot consumption), and the workflow/README rewires.
- The refreshed record is re-validated through the vendored driver
  (`bash vendor/skills/04-validate-handoff/autobahn/local-ci.sh --root .`),
  which verifies every pin's presence and sha256 before executing bootstrap +
  verification; the S4 negative fixture proves the same driver refuses drift.
- **Round-5 amendment (review round 4 gap, 2026-10-10):** the
  `npm ci --ignore-scripts` bootstrap never populated `vendor/skills` —
  `--ignore-scripts` skips all root lifecycle hooks, so a fresh gate workspace
  failed at pretest/build with `ERROR: vendor/skills not found`. The declared
  bootstrap is now plain `["npm ci"]` and `package.json` gained a root
  `"prepare": "node scripts/setup.ts"` lifecycle hook that provisions the
  vendor checkout (empirically: `npm ci` runs root `prepare`; `npm ci
  --ignore-scripts` skips it, which is exactly why the old form left the
  workspace empty). The lockfile is byte-unchanged by adding the hook (no
  `hasInstallScript` churn; `npm ci` does not rewrite the lock), and no
  third-party dependency in the lock carries install scripts, so the plain
  form runs no foreign lifecycle code. Consumer exposure of the published
  hook was measured, not assumed: a registry-faithful install (packument +
  tarball fetched over HTTP) of a prepare-only package runs **no** scripts at
  consumer install time, with and without a `hasInstallScript` packument
  flag — npm runs `prepare` for git/folder installs, not registry installs.
  Belt-and-suspenders: `stageScopedPackage` now deletes `prepare` alongside
  prepack/pretest/test so the staged scoped pack still runs zero scripts, the
  staged-lifecycle regression filter gained `prepare`, and prepack keeps its
  explicit `node scripts/setup.ts` for the publish lanes.

### D6 — Gate wiring and the lint decision (AC-6)

`package.json` scripts: `build`, `typecheck` (`tsc --noEmit`), `lint`
(`eslint .`), `test`; prek hooks in `prek.toml`: `typecheck`
(`npm run typecheck`) and `eslint` on changed `.ts` files. Rule set over the
converted tree: `complexity 10` (project decision, recorded in
`eslint.config.js`), `sonarjs/cognitive-complexity 15` (documented plugin
default kept explicit), `@typescript-eslint/no-floating-promises` at `error`
with **no carve-outs**. v1's shellcheck/shfmt gates on owned `.sh` retire with
the AC-2 removals.

Disclosed lint-wave decision: the planned
`allowForKnownSafePromises: [{ from: 'package', name: 'Promise', package: 'node:test' }]`
override was **evaluated and rejected empirically** — `@types/node` 26.6.5
types `test()` as returning the common-lib `Promise<void>`, so a package-name
specifier never matches (verified against typescript-eslint 8.71.1 on this
tree). Scoping `{ from: 'lib', name: 'Promise' }` to test files was rejected
because it disables the rule inside test bodies. The chosen pattern keeps the
rule at plain `error` and expresses node:test's canonical top-level
registration as `void test(...)` — the rule's own documented
explicitly-ignored operator — so the registration promises are marked safe at
the only place they legitimately float, while any *other* floating promise
(including one introduced inside a test body) still fails the gate. In the same
pass: two await-less `before(async () => …)` hooks were demoted to sync
callbacks (`require-await`), six dead declarations were removed, and the three
complexity-11/12 hotspots in the converted harness/test were refactored
(`assertCase`/`isDependencyCase` extraction in the fixture; lane-extraction into
`assertVendoredLane`/`assertPackedLane`) rather than disabled.

## Errata — blinded review round 1 (2026-10-10, PR #61)

The independent blinded review returned REQUEST_CHANGES with three majors and
one follow-on defect was proven while chasing them green. Each is closed by a
failing-first test (captures under the session receipts, `phase-g/`).

1. **Bin map (supersedes the D2 sentence recording the npm `bin` map).** D2
   recorded `"bin": { "ai-catapult": "bin/ai-catapult.ts" }`. Installed use
   breaks that map: npm puts the package inside `node_modules`, where Node
   refuses type stripping (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so
   the installed CLI could not run at all. The bin map is now
   `"ai-catapult": "dist/bin/ai-catapult.js"`. `bin/ai-catapult.ts` stays
   tracked and shipped as the development entrypoint; the compiled
   `dist/bin/ai-catapult.js` is the bin-of-record for installed execution.
   Regression: `test/installed-bin.test.ts` (map + staged-install execution).
2. **Entry guard.** The port guarded
   the `bin/ai-catapult.ts` module body with
   `process.argv[1] === fileURLToPath(import.meta.url)`. v1 ran the body
   unconditionally. Through npm's bin symlink chain (`<prefix>/bin/ai-catapult`
   → `node_modules/.bin/ai-catapult` → entry file), `process.argv[1]` is the
   invoked link path while `import.meta.url` resolves the entry's real path, so
   the guard never matched and the CLI silently printed nothing and exited 0.
   The entry body is unconditional `run()` again (v1-faithful). Regression:
   `test/installed-bin.test.ts` (symlink dispatch).
3. **Scoped-mirror prepack (closes the D1 sibling of the v0.2.0 127).**
   `"prepack": "node scripts/setup.ts && npm run build"` still ran inside the
   staged `@r3dlex/ai-catapult` mirror, whose `files[]` copy lacks `tsc`,
   `tsconfig.build.json`, and `scripts/prepare-dist.ts`. The static
   prepack-vs-`files` checks only see literal `scripts/*` invocations and passed
   this form; the mirror either exited 127 (v0.2.0's incident class through a
   new hole) or silently rebuilt from a half-staged tree. `stageScopedPackage`
   now deletes `prepack`, `pretest` and `test` from the staged package.json:
   the staged tree is a complete built artifact and packs with zero lifecycle
   scripts. Regression: `test/scoped-mirror-staging.test.ts` (real staged-pack
   run, scriptless and complete).
4. **Mode fidelity on the compiled bin (proven while chasing 1–2 green).**
   tsc emits 0644, npm's POSIX bin shim resolves exec permission on its target,
   so every installed invocation died EACCES even with the JS target. The
   tracked `bin/ai-catapult.ts` keeps its 0755 mode; `prepare-dist.ts` now
   chmods `dist/bin/ai-catapult.js` to 0755 so the shipped artifact carries
   mode fidelity. Red/green: `phase-g/mode-red-staged-install.txt` vs
   `phase-g/installed-bin-green2.txt`.
5. **Staged-copy dist source (exposed by the first vendored-driver run after
   the landing captures).** The round's staged-install regression copied the
   LIVE `dist/` mid-suite, where plugin tests wipe and rebuild `dist/`
   concurrently — nondeterministically racing a half-wiped staging source (one
   driver run: `ERR_MODULE_NOT_FOUND dist/src/scaffold.js`; suite runs: passed
   by timing). `stageScopedPackage` gained an optional `distSource` option and
   the regression supplies `dist/` from the stable `dist-snapshot/`, the same
   trade `packed-init.test.ts` makes for its `npm pack`; snapshot copies
   preserve file modes so the 0755 bin bit survives. The publish path is
   unchanged — it still packs the live, freshly built `dist/`.
6. **Scoped-only root build and staged-runtime completeness (review round 2
   of this PR).** The scoped-only retry (`--package @r3dlex/ai-catapult`)
   dispatches no root pack, so nothing ran the root prepack's
   `npm run build`: from a clean checkout (no tsc, no `dist/`) the staged
   mirror carried no compiled runtime and npm packed it, warning
   "No bin file found" — the pack-side round-1 finding's publish-dispatch
   sibling. `runScopedPublish` now fresh-builds the root runtime before
   staging (`npm run build`, exiting with npm's status — the unscoped
   prepack's fail-closed clean-checkout class; in `both` mode this rebuilds
   what the unscoped prepack just produced, one tsc cycle for a uniform
   contract) and refuses to publish a staged tree missing the executable
   `dist/bin/ai-catapult.js` or `skills.lock.json`: the mirror packs with
   zero lifecycle scripts, so nothing downstream can rebuild it. Regressions:
   `test/publish-both.test.ts` (clean-checkout red, incomplete-runtime red,
   complete-runtime green through the sandboxed publish) and the
   `test/publish-recovery.test.ts` run-build stub.

## Consequences

- Consumers and contributors need Node ≥ 22.18 (engines-enforced), matching the
  default-on type-stripping floor the shipped `.ts` entrypoints require.
- `npm ci` bootstrap (root `prepare` vendors `vendor/skills`) obliges a
  committed, in-sync `package-lock.json`; it is pinned in the local-ci record.
  The published tarball's `prepare` never runs at registry consumer installs
  (measured, see the round-5 amendment in D5); the staged scoped mirror strips
  it so its pack runs zero scripts.
- Sibling lanes (tswc-ac-b1/b3/b4/b5) and downstream external gates rebase on
  this tree and ship in TypeScript; this ADR is their packaging baseline.
- Golden fixtures stay byte-exact: the two graph-automation `.sh` fixtures and
  the vendored pins (`skills.lock.json`, commit `28f813bf…`) are untouched by
  this packaging change.

## Verification links

- Gates: `npm run build`, `npm run typecheck`, `npm run lint`, `npm test`
  (301/301 — 297 at plan execution, +4 review-round regression tests),
  `prek run --all-files`.
- Negative fixtures (S1–S4) and determinism digests:
  `.ai/evidence/tswc-ac-a2.json`.
- Local-ci record: `.ai/ci/local-ci.json` (local-ci/2, vendored-validated).