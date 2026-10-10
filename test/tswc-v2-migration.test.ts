// tswc-ac-a2 (A2-R): the readiness-contract/2 migration of the tswc-ai-catapult v1
// generation 676cafbc. Assertions only; no authority is granted or claimed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): Buffer => readFileSync(join(root, rel));
const sha256 = (rel: string): string => createHash('sha256').update(read(rel)).digest('hex');
const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const entries = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(entries).sort().map((key) => [key, sortKeys(entries[key])]));
  }
  return value;
};

type ArtifactRef = { path: string; sha256: string };

type RegistryPlan = {
  plan_id: string;
  id: string;
  generation: string;
  status: string;
  mode: string;
  policy_sha256: string;
  anchor_sha256: string;
  handoff_path: string;
  spec: ArtifactRef;
  artifacts: {
    bundle: ArtifactRef;
    graph: ArtifactRef;
    handoff: ArtifactRef;
    sidecar: ArtifactRef;
  };
};

type BundleGoal = {
  id: string;
  scope: string[];
  acceptance_criteria: string[];
  dependencies: string[];
  verification: string[];
  issue_ref: string;
  /** v1-only field carried by the legacy bundle's goals. */
  cross_lane_relationships?: string[];
  legacy_risk_reason?: string;
};

type Bundle = { schema: string; goals: BundleGoal[]; attachments: Record<string, string> };

type GraphNode = { type: string; id: string; goal_revision: string };

type Graph = { contract: string; plan_id: string; generation: string; goal_ids: string[]; nodes: GraphNode[] };

type SidecarEntry = {
  coverage_status: string;
  legacy_risk_reason: string;
  legacy_safe_tdd: boolean;
  readiness: Record<string, string>;
};

type Sidecar = { schema: string; plan_id: string; goals: Record<string, SidecarEntry> };

const V1_REGISTRY = '.ai/workflows/northstar-readiness-v1.json';
const V2_REGISTRY = '.ai/workflows/northstar-readiness-v2.json';
const LEGACY = '.ai/handoff/readiness-v1/tswc-ai-catapult';
const LEGACY_GENERATION = '676cafbc423bb3993ab6b847109923a2e871c92ca8c93650f04043af4ee67112';
const SPEC_PATH = 'docs/specifications/ACTIVE/typescript-wikiskill-convergence-tswc-ai-catapult.md';
const PLAN_ID = 'tswc-ai-catapult';
const GOAL_IDS = ['tswc-ac-a2', 'tswc-ac-b1', 'tswc-ac-b3', 'tswc-ac-b4', 'tswc-ac-b5'];
const POLICY_SHA256 = 'f1afba73d4c7282d9ea6038dfc8e390268fea8a11a13b86c648a224539730e0f';
const ANCHOR_SHA256 = '8b33406c8f2cfe54c0a4204f63ffa03e5c1a35aa0b648d0d3a7a35399ecb14f1';

const registeredPlan = (): RegistryPlan => {
  const registry = JSON.parse(read(V2_REGISTRY).toString('utf8')) as { plans: RegistryPlan[] };
  const plans = registry.plans.filter((plan) => plan.plan_id === PLAN_ID);
  assert.equal(plans.length, 1);
  const plan = plans[0];
  assert.ok(plan, 'exactly one live tswc-ai-catapult plan');
  return plan;
};

// tswc-ac-a2, AC-6: goal_revision_v2 equals the content of the migrated v1
// goals, i.e. the canonical (sorted-key, compact) goal-revision/2 sha256.
// canonical() is python json.dumps(sort_keys=True, separators=(',', ':')), whose
// default ensure_ascii escapes every code unit above 127 as \uXXXX — replicate
// that here per UTF-16 unit (this content carries §/→/—; the P4 content is ASCII).
const pyStringify = (value: unknown): string => JSON.stringify(value)
  .replace(/[\u0080-\uFFFF]/g, (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`);
const revision = (goal: BundleGoal): string => createHash('sha256').update(pyStringify(sortKeys({
  schema: 'goal-revision/2',
  repository: 'ai-catapult',
  id: goal.id,
  scope: goal.scope,
  acceptance_criteria: goal.acceptance_criteria,
  dependencies: [...goal.dependencies].sort(),
  verification: goal.verification,
}))).digest('hex');

// The rebuilt tswc-ac-a2 (2026-10-08 TSF correction per FINAL-STATE.md TSF-01..08, recomputed at
// this registration's head after independent review round 1): the tracked 49 .js (12 non-test +
// 37 tests incl. this pin test) and 17 .sh (15 convert-and-remove, 2 emitted-template fixtures
// dispositioned on AC-2), plus the tracked Python delivery-harness conversion (TSF-03);
// b1/b3/b4/b5 carry v1 content verbatim. Pinned here exactly; the bundle must match.
const REBUILT_A2_SCOPE = [
  'bin',
  'src',
  'scripts',
  'setup.sh',
  'test',
  'package.json',
  'tsconfig.json',
  'eslint.config.js',
  'prek.toml',
  'docs/architecture/adr',
  '.ai/ci/local-ci.json',
];
const REBUILT_A2_ACCEPTANCE = [
  'AC-1: All first-party .js files are authored in strict TypeScript with ai-factory-grade flags and the old .js paths are removed in the same PR (TSF-01: no handwritten JS tail); the repo-wide rename wave lands as one PR and is the rename-first rebase base for the gates pinned in the plan_amendments attachment (mega-plan §2.5, W1). Registration-time tracked enumeration: 49 .js at this registration\'s head — 12 non-test under bin/, src/, scripts/ plus 37 tests under test/, including this registration\'s own pin test — and 48 at the decision-time base (12 non-test plus 36 tests); the counts are registration snapshots, not caps, and the wave re-enumerates tracked first-party .js at execution and converts all of them. The one tracked Python delivery harness test/fixtures/readiness-delivery.py (runnable Python, executed by test/readiness-delivery.test.js and hash-bound in .ai/ci/local-ci.json) converts in the same PR, retiring the handwritten Python tail (TSF-03) with its declared inventory entry refreshed (AC-7).',
  'AC-2: The shell wave dispositions every tracked .sh in the same PR: all 17 tracked at this registration\'s head — setup.sh, the 14 scripts/*.sh, and the two graph-automation golden emitted-output fixtures test/fixtures/init-standalone/graph-automation/{graph-refresh,hook-body}.sh. The 15 implementation shells (setup.sh plus the 14 scripts/*.sh) are removed and their logic is authored in strict TypeScript (TSF-01: no handwritten shell tail); the two fixtures are not handwritten repo implementation — they are the committed golden emitted tree of the ai-catapult init graph automation, regenerated by scripts/regen-fixture.sh, asserted against the emitted tree by test/init.test.js and consumed as the standalone delivery sandbox by test/readiness-delivery.test.js, with the runtime source of truth in the vendored ai-catapult-init git-hook wrapper/hook-body templates staged into dist/skill-templates/; git hooks execute under sh, so per the retained C10.03 rule they carry an explicit emission disposition: kept as tracked fixture data with no conversion, attributed to the reviewed TypeScript generator (the TSF-02 replacement-owner shape). tsc-generated JavaScript under dist/ is the shipped runtime attributable to the reviewed TypeScript build (TSF-02), not an alternate-language implementation.',
  'AC-3: package.json rewires to the compiled artifact (bin → dist output, files keeps dist/, prepack runs the build) with zero runtime dependencies preserved; typescript/eslint tooling is devDeps only (AGENTS.md contract, master §2/§4.1).',
  'AC-4: A packaging-change ADR lands in docs/architecture/adr/ (new directory) recording the build step, the shipped compiled output, the Node/CI test-execution mechanism (.ts tests under node --test on the CI Node pin) and the preserved zero-runtime-dep contract (master §4.1).',
  'AC-5: The two complexity-34/22 hotspots (src/install.js runInstall, src/graph-hooks.js runGraphHooksInstall at a87c912) are refactored under the §4.2 caps (cyclomatic 10 / cognitive 15) with behavior preserved by the existing suite.',
  'AC-6: Gates land and pass: strict tsc --noEmit typecheck and eslint over the converted tree (complexity 10 labeled project decision, sonarjs cognitive-complexity 15 documented default, no-floating-promises error), wired as prek hooks and package.json scripts (build/typecheck); v1\'s shellcheck/shfmt gates on the owned .sh implementation retire with AC-2\'s removals (the only tracked .sh remaining are the two AC-2-dispositioned emitted-template fixtures). Per-slice red-leg proof per §4.7 is recorded in .ai/evidence/tswc-ac-a2.json as negative fixtures: S1 toolchain (a seeded violation trips a gate), S2 rename (a residual old .js/.sh path reference fails typecheck/lookup), S3 packaging (the rewired package.json fails with dist/ absent), S4 local-ci (the refreshed inventory refuses drift).',
  'AC-7: The hash-bound .ai/ci/local-ci.json source inventory is refreshed for every touched file so the declared local CI stays green; verification stays npm test per the repo\'s documented local verification (README); the source-policy disposition and actual matched local-ci/2 support bind before final binding per the retained C10.03 workspace rule quoted in the plan_amendments attachment.',
  'AC-8: TSF-01..08 local mapping (typescript-only-plan-alignment-20261008/FINAL-STATE.md, per TSF-08): TSF-01 → AC-1/AC-2; TSF-02 → AC-2/AC-4; TSF-03 → AC-1 (not conforming at registration: the tracked, runnable Python delivery harness test/fixtures/readiness-delivery.py is project-owned; the wave converts it and retires the handwritten Python tail), guarded by the S1 negative fixtures; TSF-04 → AC-2/AC-3 with the recording home AC-4 (each removed .js/.sh/.py path retires in the same PR with its replacement owner recorded in the ADR); TSF-05 → the retained v1 generations and the v1 registry stay byte-unchanged immutable evidence; TSF-06 → every v1 functional criterion is preserved by AC-3..AC-7 with language as the only change; TSF-07 → the per-slice negative fixtures prove the final checks catch planted violations; TSF-08 → this mapping.',
];
const MASTER_INTAKE_PIN =
  'aitool-root .ai/work-intake/typescript-wikiskill-convergence.md ' +
  'sha256 5f54c26aa8017844b1ddf457a038d03411071a2c10aad891ce42b0ea19f2ed38 ' +
  '(byte-level pin; root-workspace work-intake file, tracked at the aitool root)';
const SCOPED_INTAKE_PIN =
  'aitool-root .ai/work-intake/tswc-ai-catapult.md ' +
  'sha256 f46bd0e5f2b1f1a106597fe57c1d0cfbc8c4efdc183103ad3b3860459e8631f4';
const SOURCE_POLICY_DISPOSITION =
  '"A2-driven bootstrap/toolchain/output changes require explicit source-policy disposition ' +
  'and actual matched local-ci/2 support before final binding."';
const AMENDED_ATTACHMENT_KEYS = [
  'consensus_plan', 'cross_lane', 'd1_gate', 'harness_scope', 'interview_record',
  'master_intake', 'megaplan', 'paper_boundary', 'plan_amendments', 'rename_wave',
  'root_pin_note', 'scoped_intake',
].sort();

const loadBundle = (): { plan: RegistryPlan; bundle: Bundle; legacy: Bundle } => {
  const plan = registeredPlan();
  const bundle = JSON.parse(read(plan.artifacts.bundle.path).toString('utf8')) as Bundle;
  const legacy = JSON.parse(read(join(LEGACY, LEGACY_GENERATION, 'goals.json')).toString('utf8')) as Bundle;
  return { plan, bundle, legacy };
};

void test('the v2 registry registers exactly one live tswc-ai-catapult generation', () => {
  const registry = JSON.parse(read(V2_REGISTRY).toString('utf8')) as { schema: string };
  assert.equal(registry.schema, 'readiness-contract/2');
  const plan = registeredPlan();
  assert.equal(plan.id, `northstar-plan-${PLAN_ID}`);
  assert.match(plan.generation, /^[a-f0-9]{64}$/);
  assert.equal(plan.status, 'active');
  assert.equal(plan.mode, 'live');
  assert.equal(plan.handoff_path, plan.artifacts.handoff.path);
  assert.equal(plan.spec.path, SPEC_PATH);
  assert.equal(plan.spec.sha256, sha256(plan.spec.path));
  assert.equal(plan.policy_sha256, POLICY_SHA256);
  assert.equal(plan.anchor_sha256, ANCHOR_SHA256);
  const prefix = plan.artifacts.bundle.path.replace(/\/goals\.json$/, '');
  assert.equal(plan.artifacts.bundle.path, `${prefix}/goals.json`);
  assert.equal(plan.artifacts.graph.path, `${prefix}/graph.json`);
  assert.equal(plan.artifacts.handoff.path, `${prefix}/handoff.md`);
  assert.equal(plan.artifacts.sidecar.path, `${prefix}/sidecar.json`);
  assert.equal(sha256(plan.artifacts.bundle.path), plan.artifacts.bundle.sha256);
  assert.equal(sha256(plan.artifacts.graph.path), plan.artifacts.graph.sha256);
  assert.equal(sha256(plan.artifacts.handoff.path), plan.artifacts.handoff.sha256);
  assert.deepEqual(
    readdirSync(join(root, prefix)).sort(),
    ['goals.json', 'graph.json', 'handoff.md', 'sidecar.json'],
  );
});

void test('the migrated goals carry b1/b3/b4/b5 verbatim, rebuild a2 with the TSF correction and re-pin the attachments', () => {
  const { bundle, legacy } = loadBundle();
  assert.equal(bundle.schema, 'handoff-goals/2');
  assert.deepEqual(bundle.goals.map((goal) => goal.id), GOAL_IDS);
  for (const goal of bundle.goals) {
    assert.deepEqual(Object.keys(goal).sort(),
      ['acceptance_criteria', 'dependencies', 'id', 'issue_ref', 'scope', 'verification']);
  }
  // The retirement carries, unmerged count derived there — dependency chains verbatim:
  assert.deepEqual(
    bundle.goals.map((goal) => goal.dependencies),
    [[], [], ['tswc-ac-b1', 'tswc-ac-a2'], ['tswc-ac-b1', 'tswc-ac-b3'], ['tswc-ac-a2', 'tswc-ac-b3']],
    'b1 keeps no bundle dependency (fleet decision); b3/b4/b5 keep the v1 edges',
  );
  for (const goalId of GOAL_IDS.slice(1)) {
    const goal = bundle.goals.find((entry) => entry.id === goalId);
    const source = legacy.goals.find((entry) => entry.id === goalId);
    assert.ok(goal && source, `${goalId} exists in the legacy bundle`);
    assert.deepEqual(goal.scope, source.scope, `${goalId} scope verbatim`);
    assert.deepEqual(goal.acceptance_criteria, source.acceptance_criteria, `${goalId} ACs verbatim`);
    assert.deepEqual(goal.verification, source.verification, `${goalId} verification verbatim`);
    assert.equal(goal.issue_ref, source.issue_ref);
  }
  const a2 = bundle.goals.find((goal) => goal.id === 'tswc-ac-a2');
  assert.ok(a2, 'a2 goal present');
  assert.deepEqual(a2.scope, REBUILT_A2_SCOPE, 'a2 scope: v1 plus setup.sh');
  assert.deepEqual(a2.acceptance_criteria, REBUILT_A2_ACCEPTANCE, 'a2 TSF-corrected ACs');
  assert.deepEqual(a2.verification, ['npm run build', 'npm run typecheck', 'npm test', 'git diff --check'],
    'verification keeps the v1 four commands');
  // Attachments: the decided deltas only.
  const attachments = bundle.attachments;
  assert.deepEqual(Object.keys(attachments).sort(), AMENDED_ATTACHMENT_KEYS);
  assert.equal(attachments.master_intake, MASTER_INTAKE_PIN);
  assert.equal(attachments.scoped_intake, SCOPED_INTAKE_PIN);
  assert.equal(attachments.rename_wave, legacy.attachments.rename_wave);
  const carry = (goalId: string): string => {
    const goal = legacy.goals.find((entry) => entry.id === goalId);
    const first = goal?.cross_lane_relationships?.[0];
    assert.ok(first, `${goalId} keeps its legacy cross_lane_relationships`);
    return first;
  };
  const crossLane = attachments.cross_lane;
  const planAmendments = attachments.plan_amendments;
  assert.ok(crossLane && planAmendments, 'cross_lane and plan_amendments attachments present');
  assert.ok(crossLane.includes(carry('tswc-ac-b1')), 'b1 prose moved to the plan level');
  assert.ok(crossLane.includes(carry('tswc-ac-b5')), 'b5 prose moved to the plan level');
  assert.ok(crossLane.includes('never cross-repo bundle dependencies'));
  assert.ok(planAmendments.includes(LEGACY_GENERATION));
  assert.ok(planAmendments.includes('typescript-only-plan-alignment-20261008/FINAL-STATE.md'));
  assert.ok(planAmendments.includes('no handwritten JS/shell/Python tail'));
  assert.ok(planAmendments.includes('49 .js (12 non-test under bin/, src/, scripts/ plus 37 tests under test/, including this registration\'s pin test'));
  assert.ok(planAmendments.includes('all 17 tracked .sh (setup.sh plus the 14 scripts/*.sh converted and removed'));
  assert.ok(planAmendments.includes('emission disposition on AC-2'));
  assert.ok(planAmendments.includes('draft generation 01369bfd876b44fbfb992fe0c4b9585ef22da730ad26106b7b39c4ed667040d3'));
  assert.ok(planAmendments.includes('XSKP P4-03..05'));
  assert.ok(planAmendments.includes(SOURCE_POLICY_DISPOSITION));
});

void test('goal_revision_v2 in the generation graph hashes exactly the migrated goal content', () => {
  const { plan, bundle } = loadBundle();
  const graph = JSON.parse(read(plan.artifacts.graph.path).toString('utf8')) as Graph;
  assert.equal(graph.contract, 'readiness-contract/2');
  assert.equal(graph.plan_id, PLAN_ID);
  assert.deepEqual(graph.goal_ids, GOAL_IDS);
  for (const goal of bundle.goals) {
    const node = graph.nodes.find((entry) =>
      entry.type === 'plan' && entry.id === `plan:ai-catapult:${PLAN_ID}:${goal.id}:${graph.generation}`);
    assert.ok(node, `plan node for ${goal.id}`);
    assert.equal(node.goal_revision, revision(goal), `${goal.id} goal_revision_v2`);
  }
});

void test('the empty-hold sidecar carries readiness unknown, the legacy risk reasons and nothing held', () => {
  const { plan } = loadBundle();
  const sidecar = JSON.parse(read(plan.artifacts.sidecar.path).toString('utf8')) as Sidecar;
  const { legacy } = loadBundle();
  assert.equal(sidecar.schema, 'readiness-sidecar/1');
  assert.equal(sidecar.plan_id, PLAN_ID);
  assert.deepEqual(Object.keys(sidecar.goals).sort(), GOAL_IDS);
  for (const goalId of GOAL_IDS) {
    const entry = sidecar.goals[goalId];
    assert.ok(entry, `sidecar entry for ${goalId}`);
    assert.deepEqual(Object.keys(entry).sort(),
      ['coverage_status', 'legacy_risk_reason', 'legacy_safe_tdd', 'readiness']);
    assert.deepEqual(entry.readiness, { implementation: 'unknown', merge: 'unknown', preparation: 'unknown' });
    assert.equal(entry.legacy_safe_tdd, true);
    const source = legacy.goals.find((goal) => goal.id === goalId);
    assert.ok(source, `${goalId} exists in the legacy bundle`);
    assert.equal(entry.legacy_risk_reason, source.legacy_risk_reason, `${goalId} legacy_risk_reason carried verbatim`);
    assert.ok(entry.legacy_risk_reason.length > 0);
    assert.equal(entry.coverage_status, 'unknown');
  }
});

void test('every retained v1 tswc-ai-catapult generation and the v1 registry stay byte-unchanged', () => {
  const generations: Record<string, Record<string, string>> = {
    [LEGACY_GENERATION]: {
      'goals.json': '82b687b7321dbec724ffc647dbf6769112260cbb92d08e711a32ed160ddc88a9',
      'graph.json': '3fabe45122091cdb751fdb9f6be6426f9e53a5d7113bf041e5a30ea306c3b5b0',
      'handoff.md': 'eda129bef3dad166d76898a10994a6fbbbd8dd5330498207c75a76749fd67e78',
    },
  };
  for (const [generation, files] of Object.entries(generations)) {
    for (const [name, digest] of Object.entries(files)) {
      assert.equal(sha256(`${LEGACY}/${generation}/${name}`), digest, `${generation}/${name}`);
    }
  }
  assert.equal(sha256(V1_REGISTRY), '391dfc01a3d437cb7cf9acae6f44aab903e0a79424a7511a901b9cff976a705f');
});