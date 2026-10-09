// Pins the active ai-catapult readiness-policy/2 and the retained
// readiness-contract/1 generations. These checks grant no execution authority.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel));
const sha256 = (rel) => createHash('sha256').update(read(rel)).digest('hex');

const POLICY = '.ai/policies/readiness-policy.json';
const CI = '.ai/ci/local-ci.json';
const V1_REGISTRY = '.ai/workflows/northstar-readiness-v1.json';
const V2_REGISTRY = '.ai/workflows/northstar-readiness-v2.json';

// The generation this policy is bound to (readiness-contract/2, handoff-goals/2).
const GENERATION = '0516ba2ca7e9180e4235bd74680fe44d42875283a91e71e9f1987920e8cf88f0';
const HANDOFF = `.ai/handoff/readiness-v2/ach-catapult-delivery/${GENERATION}`;
const CANDIDATE = `${HANDOFF}/policy-candidate.json`;
const POLICY_SHA256 = 'f1afba73d4c7282d9ea6038dfc8e390268fea8a11a13b86c648a224539730e0f';
const ANCHOR_SHA256 = '8b33406c8f2cfe54c0a4204f63ffa03e5c1a35aa0b648d0d3a7a35399ecb14f1';

// policy/2 is fixed and plan-agnostic: exactly these fields, no extensions.
const POLICY_FIELDS = [
  'approval', 'branch_pattern', 'gates', 'identity_model', 'repository',
  'required_checks', 'reviewer_requirements', 'schema', 'skippable_checks',
  'sources', 'target', 'tools',
];
const GATE_KINDS = [
  'ownership', 'review', 'branch_target', 'tooling', 'file_digest',
  'git_ancestor', 'hosted_checks', 'plan_approval', 'fixture', 'harness_trust',
];
const NOT_APPLICABLE = { fixture: 'no-fixture-dependency', harness_trust: 'no-pinned-harness' };

// Every readiness-contract/1 generation and registry byte that must stay frozen (O10).
const V1_REGISTRY_SHA256 = '391dfc01a3d437cb7cf9acae6f44aab903e0a79424a7511a901b9cff976a705f';
const V1_GENERATIONS = {
  'xskp-p4-adopt-engine': {
    dir: '.ai/handoff/readiness-v1/xskp-p4-adopt-engine/92ecdb62b5807ba4cac0e274a9fe5a566292823d1f30214258d3aacd839524af',
    files: {
      'goals.json': '3222a2ea612cc19b51c6f9b3293e6d4d1b5613729c73398b45db88b33460ee1a',
      'graph.json': '2b3f321da80aa15575a946cdb8f55681c1ceee1510dea98aa377f37ab6a3ba10',
      'handoff.md': 'e11870c11c90b70e96850a6d3000b762d5432a434fe5632fb489f4fab34193cb',
    },
  },
  'tswc-ai-catapult': {
    dir: '.ai/handoff/readiness-v1/tswc-ai-catapult/676cafbc423bb3993ab6b847109923a2e871c92ca8c93650f04043af4ee67112',
    files: {
      'goals.json': '82b687b7321dbec724ffc647dbf6769112260cbb92d08e711a32ed160ddc88a9',
      'graph.json': '3fabe45122091cdb751fdb9f6be6426f9e53a5d7113bf041e5a30ea306c3b5b0',
      'handoff.md': 'eda129bef3dad166d76898a10994a6fbbbd8dd5330498207c75a76749fd67e78',
    },
  },
};

test('the active policy is the approved generation candidate, byte for byte', () => {
  const generation = JSON.parse(read(V2_REGISTRY)).plans
    .filter((plan) => plan.plan_id === 'ach-catapult-delivery');
  assert.equal(generation.length, 1, 'exactly one registered ai-catapult generation');
  const [plan] = generation;
  assert.equal(plan.status, 'active');
  assert.equal(plan.generation, GENERATION);
  assert.equal(plan.policy_sha256, POLICY_SHA256, 'generation binds this policy digest');
  assert.equal(plan.artifacts.policy_candidate.sha256, POLICY_SHA256, 'candidate digest is the policy digest');
  assert.equal(sha256(POLICY), POLICY_SHA256);
  assert.deepEqual(read(POLICY), read(CANDIDATE), 'the live policy must equal the generation candidate');
});

test('the policy conforms to readiness-policy/2 and stays plan-agnostic', () => {
  const policy = JSON.parse(read(POLICY));
  assert.deepEqual(Object.keys(policy).sort(), [...POLICY_FIELDS].sort(), 'exactly the fixed policy fields');
  assert.equal(policy.schema, 'readiness-policy/2');
  assert.deepEqual(policy.repository, { id: 'ai-catapult' });
  assert.equal(policy.identity_model, 'multi');
  assert.deepEqual(policy.reviewer_requirements, { independent_lane: true });
  assert.deepEqual(policy.required_checks, ['test', 'vendor', 'codex-plugin', 'plugin-claude']);
  assert.deepEqual(policy.skippable_checks, []);
  assert.deepEqual(policy.tools, ['bash', 'python3', 'git', 'ssh-keygen', 'gh', 'node', 'npm', 'tar']);
  assert.deepEqual(policy.sources, ['AGENTS.md', 'CLAUDE.md', 'CONTEXT.md', 'GEMINI.md']);
  assert.equal(policy.branch_pattern, '^(feat|fix|chore)/<plan_id>-<goal_id>$');
  assert.equal(policy.target, 'main');
  assert.deepEqual(policy.approval, {
    accept: ['agent-self', 'ssh-tag', 'in-session'],
    anchor_sha256: ANCHOR_SHA256,
    default_mode: 'agent',
    max_age_days: 14,
  });
});

test('every gate is repository-scoped, uniquely named and of a fixed kind', () => {
  const policy = JSON.parse(read(POLICY));
  assert.ok(Array.isArray(policy.gates) && policy.gates.length > 0);
  const ids = policy.gates.map((gate) => gate.id);
  assert.equal(new Set(ids).size, ids.length, 'gate ids are unique');
  for (const gate of policy.gates) {
    assert.ok(GATE_KINDS.includes(gate.kind), gate.id);
    assert.deepEqual(gate.scope, { repository: true }, `${gate.id} is repository-scoped`);
    assert.deepEqual(Object.keys(gate.scope), ['repository'], `${gate.id} carries no per-goal scope`);
    if ('not_applicable' in gate) {
      assert.deepEqual(gate.not_applicable, { reason: NOT_APPLICABLE[gate.kind] }, gate.id);
      assert.ok(!('binding' in gate), gate.id);
    }
  }
  for (const kind of ['hosted_checks', 'review']) {
    assert.equal(policy.gates.filter((gate) => gate.kind === kind && gate.stage === 'merge').length, 1, kind);
  }
  assert.ok(!('extensions' in policy), 'a plan-agnostic policy carries no extensions');
});

test('no plan or goal id from either registry leaks into the policy', () => {
  const policy = read(POLICY).toString('utf8');
  const ids = new Set();
  for (const path of [V1_REGISTRY, V2_REGISTRY]) {
    for (const plan of JSON.parse(read(path)).plans) {
      ids.add(plan.id);
      ids.add(plan.plan_id);
      for (const goal of JSON.parse(read(plan.artifacts.bundle.path)).goals) ids.add(goal.id);
    }
  }
  assert.ok(ids.has('xskp-p4-adopt-engine') && ids.has('tswc-ai-catapult') && ids.has('XSKP-P4-01'));
  for (const id of ids) assert.ok(!policy.includes(id), `${id} must not appear in the policy`);
});

test('retained readiness-contract/1 generations and the v1 registry are byte-unchanged', () => {
  const registry = JSON.parse(read(V1_REGISTRY));
  assert.equal(registry.schema, 'readiness-contract/1');
  assert.deepEqual(registry.plans.map((plan) => plan.plan_id).sort(),
    Object.keys(V1_GENERATIONS).sort());
  for (const [plan, generation] of Object.entries(V1_GENERATIONS)) {
    for (const [file, digest] of Object.entries(generation.files)) {
      assert.equal(sha256(`${generation.dir}/${file}`), digest, `${plan}/${file}`);
    }
  }
  assert.equal(sha256(V1_REGISTRY), V1_REGISTRY_SHA256);
});

test('the local CI contract is local-ci/2 with the declared isolated workspace', () => {
  const record = JSON.parse(read(CI));
  assert.deepEqual(Object.keys(record).sort(),
    ['schema', 'sources', 'verification', 'workflows', 'workspace']);
  assert.equal(record.schema, 'local-ci/2');
  assert.deepEqual(record.workspace, {
    bootstrap: ['bash setup.sh'],
    dependencies: ['vendor'],
    outputs: ['dist', 'dist-snapshot'],
  });
  assert.deepEqual(record.verification, ['npm test']);
  assert.ok('setup.sh' in record.sources, 'the bash bootstrap source stays pinned');
});
