// tswc-ac-a2 (A2-R): the readiness-contract/2 migration of the tswc-ai-catapult v1
// generation 676cafbc. Assertions only; no authority is granted or claimed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel));
const sha256 = (rel) => createHash('sha256').update(read(rel)).digest('hex');
const sortKeys = (value) => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
};

const V1_REGISTRY = '.ai/workflows/northstar-readiness-v1.json';
const V2_REGISTRY = '.ai/workflows/northstar-readiness-v2.json';
const LEGACY = '.ai/handoff/readiness-v1/tswc-ai-catapult';
const LEGACY_GENERATION = '676cafbc423bb3993ab6b847109923a2e871c92ca8c93650f04043af4ee67112';
const SPEC_PATH = 'docs/specifications/ACTIVE/typescript-wikiskill-convergence-tswc-ai-catapult.md';
const PLAN_ID = 'tswc-ai-catapult';
const GOAL_IDS = ['tswc-ac-a2', 'tswc-ac-b1', 'tswc-ac-b3', 'tswc-ac-b4', 'tswc-ac-b5'];
const POLICY_SHA256 = 'f1afba73d4c7282d9ea6038dfc8e390268fea8a11a13b86c648a224539730e0f';
const ANCHOR_SHA256 = '8b33406c8f2cfe54c0a4204f63ffa03e5c1a35aa0b648d0d3a7a35399ecb14f1';

const registeredPlan = () => {
  const registry = JSON.parse(read(V2_REGISTRY));
  const plans = registry.plans.filter((plan) => plan.plan_id === PLAN_ID);
  assert.equal(plans.length, 1);
  return plans[0];
};

// tswc-ac-a2, AC-6: goal_revision_v2 equals the content of the migrated v1
// goals, i.e. the canonical (sorted-key, compact) goal-revision/2 sha256.
// canonical() is python json.dumps(sort_keys=True, separators=(',', ':')), whose
// default ensure_ascii escapes every code unit above 127 as \uXXXX — replicate
// that here per UTF-16 unit (this content carries §/→/—; the P4 content is ASCII).
const pyStringify = (value) => JSON.stringify(value)
  .replace(/[\u0080-\uFFFF]/g, (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`);
const revision = (goal) => createHash('sha256').update(pyStringify(sortKeys({
  schema: 'goal-revision/2',
  repository: 'ai-catapult',
  id: goal.id,
  scope: goal.scope,
  acceptance_criteria: goal.acceptance_criteria,
  dependencies: [...goal.dependencies].sort(),
  verification: goal.verification,
}))).digest('hex');

// The rebuilt tswc-ac-a2 (2026-10-08 TSF correction, FINAL-STATE.md TSF-01..08):
// the verified 48 .js (12 non-test + 36 test) and 15 .sh convert; b1/b3/b4/b5
// carry v1 content verbatim. Pinned here exactly; the bundle must match.
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
  'AC-1: All 48 first-party .js files (12 non-test under bin/, src/, scripts/ plus 36 tests under test/) are authored in strict TypeScript with ai-factory-grade flags and the old .js paths are removed in the same PR (TSF-01: no handwritten JS tail); the repo-wide rename wave lands as one PR and is the rename-first rebase base for the gates pinned in the plan_amendments attachment (mega-plan §2.5, W1).',
  'AC-2: The shell wave converts in the same PR: the 15 first-party .sh files (setup.sh plus the 14 scripts/*.sh) are removed and their logic is authored in strict TypeScript (TSF-01: no handwritten shell tail); tsc-generated JavaScript under dist/ is the shipped runtime attributable to the reviewed TypeScript build (TSF-02), not an alternate-language implementation.',
  'AC-3: package.json rewires to the compiled artifact (bin → dist output, files keeps dist/, prepack runs the build) with zero runtime dependencies preserved; typescript/eslint tooling is devDeps only (AGENTS.md contract, master §2/§4.1).',
  'AC-4: A packaging-change ADR lands in docs/architecture/adr/ (new directory) recording the build step, the shipped compiled output, the Node/CI test-execution mechanism (.ts tests under node --test on the CI Node pin) and the preserved zero-runtime-dep contract (master §4.1).',
  'AC-5: The two complexity-34/22 hotspots (src/install.js runInstall, src/graph-hooks.js runGraphHooksInstall at a87c912) are refactored under the §4.2 caps (cyclomatic 10 / cognitive 15) with behavior preserved by the existing suite.',
  'AC-6: Gates land and pass: strict tsc --noEmit typecheck and eslint over the converted tree (complexity 10 labeled project decision, sonarjs cognitive-complexity 15 documented default, no-floating-promises error), wired as prek hooks and package.json scripts (build/typecheck); v1\'s shellcheck/shfmt gates on owned .sh retire with AC-2 (no owned .sh remains). Per-slice red-leg proof per §4.7 is recorded in .ai/evidence/tswc-ac-a2.json as negative fixtures: S1 toolchain (a seeded violation trips a gate), S2 rename (a residual old .js/.sh path reference fails typecheck/lookup), S3 packaging (the rewired package.json fails with dist/ absent), S4 local-ci (the refreshed inventory refuses drift).',
  'AC-7: The hash-bound .ai/ci/local-ci.json source inventory is refreshed for every touched file so the declared local CI stays green; verification stays npm test per the repo\'s documented local verification (README); the source-policy disposition and actual matched local-ci/2 support bind before final binding per the retained C10.03 workspace rule quoted in the plan_amendments attachment.',
  'AC-8: TSF-01..08 local mapping (typescript-only-plan-alignment-20261008/FINAL-STATE.md, per TSF-08): TSF-01 → AC-1/AC-2; TSF-02 → AC-2/AC-4; TSF-03 → conforming today (no project-owned Python in the tree), guarded by the S1 negative fixtures; TSF-04 → AC-2/AC-3 (each removed .js/.sh path retires in the same PR with its replacement owner recorded in the ADR); TSF-05 → the retained v1 generations and the v1 registry stay byte-unchanged immutable evidence; TSF-06 → every v1 functional criterion is preserved by AC-3..AC-7 with language as the only change; TSF-07 → the per-slice negative fixtures prove the final checks catch planted violations; TSF-08 → this mapping.',
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

test('the v2 registry registers exactly one live tswc-ai-catapult generation', () => {
  const registry = JSON.parse(read(V2_REGISTRY));
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
  const prefix = `${plan.artifacts.bundle.path.replace(/\/goals\.json$/, '')}`;
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

test('the migrated goals carry b1/b3/b4/b5 verbatim, rebuild a2 with the TSF correction and re-pin the attachments', () => {
  const plan = registeredPlan();
  const bundle = JSON.parse(read(plan.artifacts.bundle.path));
  const legacy = JSON.parse(read(join(LEGACY, LEGACY_GENERATION, 'goals.json')));
  assert.equal(bundle.schema, 'handoff-goals/2');
  assert.deepEqual(bundle.repository, { id: 'ai-catapult' });
  assert.deepEqual(bundle.spec, { path: SPEC_PATH });
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
    assert.ok(source, `${goalId} exists in the legacy bundle`);
    assert.deepEqual(goal.scope, source.scope, `${goalId} scope verbatim`);
    assert.deepEqual(goal.acceptance_criteria, source.acceptance_criteria, `${goalId} ACs verbatim`);
    assert.deepEqual(goal.verification, source.verification, `${goalId} verification verbatim`);
    assert.equal(goal.issue_ref, source.issue_ref);
  }
  const a2 = bundle.goals.find((goal) => goal.id === 'tswc-ac-a2');
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
  const carry = (goalId) => legacy.goals.find((entry) => entry.id === goalId).cross_lane_relationships[0];
  assert.ok(attachments.cross_lane.includes(carry('tswc-ac-b1')), 'b1 prose moved to the plan level');
  assert.ok(attachments.cross_lane.includes(carry('tswc-ac-b5')), 'b5 prose moved to the plan level');
  assert.ok(attachments.cross_lane.includes('never cross-repo bundle dependencies'));
  assert.ok(attachments.plan_amendments.includes(LEGACY_GENERATION));
  assert.ok(attachments.plan_amendments.includes('typescript-only-plan-alignment-20261008/FINAL-STATE.md'));
  assert.ok(attachments.plan_amendments.includes('no handwritten JS/shell tail'));
  assert.ok(attachments.plan_amendments.includes('the verified 48 (12 non-test under bin/, src/, scripts/ plus 36 tests under test/)'));
  assert.ok(attachments.plan_amendments.includes('15 first-party .sh files (setup.sh plus the 14 scripts/*.sh)'));
  assert.ok(attachments.plan_amendments.includes('XSKP P4-03..05'));
  assert.ok(attachments.plan_amendments.includes(SOURCE_POLICY_DISPOSITION));
});

test('goal_revision_v2 in the generation graph hashes exactly the migrated goal content', () => {
  const plan = registeredPlan();
  const bundle = JSON.parse(read(plan.artifacts.bundle.path));
  const graph = JSON.parse(read(plan.artifacts.graph.path));
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

test('the empty-hold sidecar carries readiness unknown, the legacy risk reasons and nothing held', () => {
  const plan = registeredPlan();
  const sidecar = JSON.parse(read(plan.artifacts.sidecar.path));
  const legacy = JSON.parse(read(join(LEGACY, LEGACY_GENERATION, 'goals.json')));
  assert.equal(sidecar.schema, 'readiness-sidecar/1');
  assert.equal(sidecar.plan_id, PLAN_ID);
  assert.deepEqual(Object.keys(sidecar.goals).sort(), GOAL_IDS);
  for (const goalId of GOAL_IDS) {
    const entry = sidecar.goals[goalId];
    assert.deepEqual(Object.keys(entry).sort(),
      ['coverage_status', 'legacy_risk_reason', 'legacy_safe_tdd', 'readiness']);
    assert.deepEqual(entry.readiness, { implementation: 'unknown', merge: 'unknown', preparation: 'unknown' });
    assert.equal(entry.legacy_safe_tdd, true);
    const source = legacy.goals.find((goal) => goal.id === goalId);
    assert.equal(entry.legacy_risk_reason, source.legacy_risk_reason, `${goalId} legacy_risk_reason carried verbatim`);
    assert.ok(entry.legacy_risk_reason.length > 0);
    assert.equal(entry.coverage_status, 'unknown');
  }
});

test('every retained v1 tswc-ai-catapult generation and the v1 registry stay byte-unchanged', () => {
  const generations = {
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