// Pins the active XSKP P4 readiness policy. These checks grant no execution authority.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const POLICY_PATH = '.ai/policies/readiness-policy.json';
const POLICY_SHA256 = '3ff4515609748c9dfbb08643eb913977fb7a12ac84ffb9f4b35985f9489cfed2';
const PREVIOUS_POLICY_SHA256 = '41d01478582a12b98fba2d6fc96c5769870e20b8ac7b728f624c3bffc65b52b1';
const GENERATION = '92ecdb62b5807ba4cac0e274a9fe5a566292823d1f30214258d3aacd839524af';
const BUNDLE_PATH = `.ai/handoff/readiness-v1/xskp-p4-adopt-engine/${GENERATION}/goals.json`;
const BUNDLE_SHA256 = '3222a2ea612cc19b51c6f9b3293e6d4d1b5613729c73398b45db88b33460ee1a';
const BRANCHES = {
  'XSKP-P4-01': 'feat/knowledge-contract-XSKP-P4-01',
  'XSKP-P4-02': 'feat/knowledge-read-verbs-XSKP-P4-02',
  'XSKP-P4-03': 'feat/knowledge-write-verbs-XSKP-P4-03',
  'XSKP-P4-04': 'feat/adopt-inventory-XSKP-P4-04',
  'XSKP-P4-05': 'feat/adopt-apply-init-XSKP-P4-05',
};
// goal_revision() from autobahn readiness-contract/1 over the frozen bundle above.
const REVISIONS = {
  'XSKP-P4-01': 'aa008a6e96ca4efad004df5edea44889c5c8066f498025accd96c99de9c2ee7e',
  'XSKP-P4-02': '7e8039ab8d5edd3a353062540da2b402b0f1fe5130c0cfe0462f20aafe385815',
  'XSKP-P4-03': 'b41121e1a34b8cee485c019526b1aec05d925adc7a2afdd0d2074fc21beaa2d4',
  'XSKP-P4-04': '6a69d65835a1b10cf924fde3c2da4523b939ebe034f6714878abbb5a99f47102',
  'XSKP-P4-05': 'c4ae861e8809a22ad41ab95679c2d9f9158fc6de468066b47ef968c02492e72b',
};

const sha256 = (rel) => createHash('sha256').update(readFileSync(join(root, rel))).digest('hex');
const policy = JSON.parse(readFileSync(join(root, POLICY_PATH), 'utf8'));
const bundle = JSON.parse(readFileSync(join(root, BUNDLE_PATH), 'utf8'));
const byKind = (kind) => policy.gates.filter((g) => g.kind === kind);

test('policy digest is the exact revision submitted for approval', () => {
  assert.equal(sha256(POLICY_PATH), POLICY_SHA256);
  assert.equal(policy.extensions?.supersedes_policy_sha256, PREVIOUS_POLICY_SHA256);
});

test('policy targets the frozen P4 generation and is pending approval', () => {
  assert.equal(policy.schema, 'readiness-policy/1');
  assert.deepEqual(policy.repository, bundle.repository);
  assert.equal(sha256(BUNDLE_PATH), BUNDLE_SHA256);
  assert.equal(policy.extensions.active_plan, 'xskp-p4-adopt-engine');
  assert.equal(policy.extensions.generation, GENERATION);
  assert.equal(policy.extensions.approval_status, 'pending-independent-approval');
});

test('sources are current and cover AGENTS.md', () => {
  const paths = policy.sources.map((s) => s.path);
  assert.equal(new Set(paths).size, paths.length);
  assert.ok(paths.includes('AGENTS.md'));
  for (const ref of policy.sources) assert.equal(sha256(ref.path), ref.sha256, ref.path);
});

test('existing ownership and npm gates are retained', () => {
  const ids = Object.fromEntries(policy.gates.map((g) => [g.id, g]));
  assert.deepEqual([ids['own-execution']?.stage, ids['own-execution']?.binding.roles], ['implementation', ['owner']]);
  assert.deepEqual([ids['own-review']?.stage, ids['own-review']?.binding.roles], ['merge', ['reviewer']]);
  assert.deepEqual(ids['tool-present']?.binding, { tool: 'npm' });
  for (const id of ['own-execution', 'own-review', 'tool-present']) assert.deepEqual(ids[id].scope, { repository: true });
});

test('branch binding is exact per goal and targets main', () => {
  const gates = byKind('branch_target');
  assert.equal(gates.length, 5);
  const actual = {};
  for (const gate of gates) {
    assert.equal(gate.stage, 'implementation');
    assert.deepEqual(Object.keys(gate.scope), ['goals']);
    assert.equal(gate.scope.goals.length, 1);
    const [goal] = gate.scope.goals;
    assert.ok(!(goal in actual), goal);
    assert.equal(gate.binding.target, 'main');
    actual[goal] = gate.binding.branch;
  }
  assert.deepEqual(actual, BRANCHES);
  assert.ok(!('branch_target' in policy.not_applicable));
});

test('approval is per goal revision, not inferred from registration', () => {
  assert.ok(!('registration_approval' in policy.not_applicable));
  const gates = byKind('protected_approval');
  assert.equal(gates.length, 5);
  for (const gate of gates) {
    const { subject } = gate.binding;
    assert.equal(gate.stage, 'implementation');
    assert.equal(subject.mode, 'goal-scope');
    assert.deepEqual(gate.scope, { goals: [subject.goal] });
    assert.equal(subject.goal_sha256, REVISIONS[subject.goal]);
  }
  assert.deepEqual(new Set(gates.map((g) => g.binding.subject.goal)), new Set(Object.keys(REVISIONS)));
});

test('tooling is observed per tool, never exempted', () => {
  assert.ok(!('tooling' in policy.not_applicable));
  const gates = byKind('tooling');
  assert.deepEqual(new Set(gates.map((g) => g.binding.tool)), new Set(['npm', 'node', 'git', 'bash', 'tar']));
  for (const gate of gates) {
    assert.equal(gate.stage, 'implementation');
    assert.deepEqual(gate.scope, { repository: true });
  }
});

test('default-branch publication (B5) is a gate, not a receipt', () => {
  const gates = policy.gates.filter((g) => g.id === 'planning-inputs-on-main');
  assert.equal(gates.length, 1);
  assert.deepEqual(gates[0], {
    id: 'planning-inputs-on-main', kind: 'independent_result', responsible: gates[0].responsible,
    scope: { repository: true }, stage: 'implementation',
  });
});

test('only current-bundle scopes, no new exemptions, no authority claims', () => {
  const goals = new Set(bundle.goals.map((g) => g.id));
  const ids = policy.gates.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const gate of policy.gates) {
    if (gate.scope.repository === true) continue;
    assert.deepEqual(Object.keys(gate.scope), ['goals']);
    for (const g of gate.scope.goals) assert.ok(goals.has(g), g);
  }
  assert.deepEqual(Object.keys(policy.not_applicable).sort(), ['fixtures', 'harness_trust']);
  for (const reason of Object.values(policy.not_applicable)) {
    assert.doesNotMatch(reason, /single-maintainer|verified present|planning_complete=true|self-sign/i);
  }
  for (const key of ['authority', 'results', 'completed_goals']) assert.ok(!(key in policy), key);
  for (const goal of bundle.goals) assert.equal(goal.owner, 'unassigned');
});
