// ACH-C-05: the readiness-contract/2 migration of the xskp-p4-adopt-engine v1
// generation 92ecdb62. Assertions only; no authority is granted or claimed.
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
const LEGACY = '.ai/handoff/readiness-v1/xskp-p4-adopt-engine';
const LEGACY_GENERATION = '92ecdb62b5807ba4cac0e274a9fe5a566292823d1f30214258d3aacd839524af';
const PLAN_ID = 'xskp-p4-adopt-engine';
const GOAL_IDS = ['XSKP-P4-01', 'XSKP-P4-02', 'XSKP-P4-03', 'XSKP-P4-04', 'XSKP-P4-05'];
const POLICY_SHA256 = 'f1afba73d4c7282d9ea6038dfc8e390268fea8a11a13b86c648a224539730e0f';
const ANCHOR_SHA256 = '8b33406c8f2cfe54c0a4204f63ffa03e5c1a35aa0b648d0d3a7a35399ecb14f1';

const registeredPlan = () => {
  const registry = JSON.parse(read(V2_REGISTRY));
  const plans = registry.plans.filter((plan) => plan.plan_id === PLAN_ID);
  assert.equal(plans.length, 1);
  return plans[0];
};

// ACH-C-05, AC-Test: goal_revision_v2 equals the content of the migrated v1
// goals, i.e. the canonical (sorted-key, compact) goal-revision/2 sha256.
const revision = (goal) => createHash('sha256').update(JSON.stringify(sortKeys({
  schema: 'goal-revision/2',
  repository: 'ai-catapult',
  id: goal.id,
  scope: goal.scope,
  acceptance_criteria: goal.acceptance_criteria,
  dependencies: [...goal.dependencies].sort(),
  verification: goal.verification,
}))).digest('hex');

test('the v2 registry registers exactly one live xskp-p4-adopt-engine generation', () => {
  const registry = JSON.parse(read(V2_REGISTRY));
  assert.equal(registry.schema, 'readiness-contract/2');
  const plan = registeredPlan();
  assert.equal(plan.id, `northstar-plan-${PLAN_ID}`);
  assert.match(plan.generation, /^[a-f0-9]{64}$/);
  assert.equal(plan.status, 'active');
  assert.equal(plan.mode, 'live');
  assert.equal(plan.handoff_path, plan.artifacts.handoff.path);
  assert.equal(plan.spec.path,
    'docs/specifications/ACTIVE/cross-surface-knowledge-publication-xskp-p4-adopt-engine.md');
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

test('the migrated goals equal the content projected from the unmerged legacy v1 goals', () => {
  const plan = registeredPlan();
  const bundle = JSON.parse(read(plan.artifacts.bundle.path));
  const legacy = JSON.parse(read(join(LEGACY, LEGACY_GENERATION, 'goals.json')));
  assert.equal(bundle.schema, 'handoff-goals/2');
  assert.deepEqual(bundle.repository, { id: 'ai-catapult' });
  assert.deepEqual(bundle.spec,
    { path: 'docs/specifications/ACTIVE/cross-surface-knowledge-publication-xskp-p4-adopt-engine.md' });
  assert.deepEqual(bundle.goals.map((goal) => goal.id), GOAL_IDS);
  for (const goal of bundle.goals) {
    const source = legacy.goals.find((entry) => entry.id === goal.id);
    assert.ok(source, `${goal.id} exists in the legacy bundle`);
    // Content only: id, scope, acceptance_criteria, dependencies, verification, issue_ref.
    assert.deepEqual(Object.keys(goal).sort(),
      ['acceptance_criteria', 'dependencies', 'id', 'issue_ref', 'scope', 'verification']);
    assert.deepEqual(goal.scope, source.scope);
    assert.deepEqual(goal.acceptance_criteria, source.acceptance_criteria);
    assert.deepEqual(goal.verification, source.verification);
    assert.equal(goal.issue_ref, source.issue_ref);
  }
  // The 5-deep chain is preserved from the legacy bundle, unmerged count derived there:
  assert.equal(legacy.goals.length, GOAL_IDS.length);
  assert.deepEqual(
    bundle.goals.map((goal) => goal.dependencies),
    [[], ['XSKP-P4-01'], ['XSKP-P4-02'], ['XSKP-P4-03'], ['XSKP-P4-04']],
    'XSKP-P4-01..05 keep the 5-deep sequential dependency chain',
  );
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
  assert.equal(sidecar.schema, 'readiness-sidecar/1');
  assert.equal(sidecar.plan_id, PLAN_ID);
  assert.deepEqual(Object.keys(sidecar.goals).sort(), GOAL_IDS);
  for (const goalId of GOAL_IDS) {
    const entry = sidecar.goals[goalId];
    assert.deepEqual(Object.keys(entry).sort(),
      ['coverage_status', 'legacy_risk_reason', 'legacy_safe_tdd', 'readiness']);
    assert.deepEqual(entry.readiness, { implementation: 'unknown', merge: 'unknown', preparation: 'unknown' });
    assert.equal(entry.legacy_safe_tdd, true);
    assert.ok(typeof entry.legacy_risk_reason === 'string' && entry.legacy_risk_reason.length > 0,
      `${goalId} legacy_risk_reason`);
    assert.equal(entry.coverage_status, 'unknown');
  }
});

test('every retained v1 xskp-p4-adopt-engine generation and the v1 registry stay byte-unchanged', () => {
  const generations = {
    [LEGACY_GENERATION]: {
      'goals.json': '3222a2ea612cc19b51c6f9b3293e6d4d1b5613729c73398b45db88b33460ee1a',
      'graph.json': '2b3f321da80aa15575a946cdb8f55681c1ceee1510dea98aa377f37ab6a3ba10',
      'handoff.md': 'e11870c11c90b70e96850a6d3000b762d5432a434fe5632fb489f4fab34193cb',
    },
    'ed0b95f763c33548d3f313ccc3cd0e62f41dbe22501b4e6d1128d0bd029a2897': {
      'goals.json': '159737c64c9f1b47ba98676811a9ba961e957fb0a8d7521cfe77b513425d7055',
      'graph.json': '9aedf8ada23ab608b296b344c9c48eb70fc0b7ad8a7704bfde37ec309c71689d',
      'handoff.md': 'e11870c11c90b70e96850a6d3000b762d5432a434fe5632fb489f4fab34193cb',
    },
    '93c64059b73f049b708baf459f711732749c6fa50635a8f6b50a0e0250530ceb': {
      'goals.json': '7b201186818ac2bd94164daa9c1efb4e961c796e05609824e98cb3849d1926ed',
      'graph.json': '615cca8a6f3926b993cbed7f6959afe5c45534893b3e1057ce75c17b8d222789',
      'handoff.md': 'e11870c11c90b70e96850a6d3000b762d5432a434fe5632fb489f4fab34193cb',
    },
  };
  for (const [generation, files] of Object.entries(generations)) {
    for (const [name, digest] of Object.entries(files)) {
      assert.equal(sha256(`${LEGACY}/${generation}/${name}`), digest, `${generation}/${name}`);
    }
  }
  assert.equal(sha256(V1_REGISTRY), '391dfc01a3d437cb7cf9acae6f44aab903e0a79424a7511a901b9cff976a705f');
});