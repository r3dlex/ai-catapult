/**
 * Exercise shipped public wrappers, never import their validator directly.
 *
 * TypeScript replacement owner for the retired first-party fixture
 * test/fixtures/readiness-delivery.py (JavaScript-to-TypeScript rename wave).
 * The vendored Python helper module vendor/skills/tests/readiness_fixture.py
 * stays byte-locked upstream, so its three helpers (fixture/write/digest) are
 * reimplemented here with byte-compatible output:
 *   json.dumps(value, indent=2) + '\n'  ==  JSON.stringify(value, null, 2) + '\n'
 * for the ASCII-only fixture data, and Path.resolve() realpath semantics carry
 * over via realpathSync.
 */
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir as tmpDir } from 'node:os';

type Obj = Record<string, unknown>;

function requireArg(flag: string): string {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  assert.ok(value !== undefined, `missing required argument ${flag}`);
  return value;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function obj(value: unknown): Obj {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value),
    `expected JSON object, got ${JSON.stringify(value)}`);
  return value as Obj;
}

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function write(root: string, path: string, value: unknown): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(value, null, 2) + '\n');
}

// Reimplementation of the byte-locked vendored readiness_fixture.py helpers.
function fixture(root: string): { bundle: Obj; context: Obj } {
  write(root, '.ai/matrix.json', {});
  write(root, '.ai/workflows/repo-workflow.json', { optional_branches: [] });
  write(root, '.ai/workflows/northstar-readiness-v1.json', { schema: 'readiness-contract/1', plans: [] });
  write(root, '.ai/traceability/graph.json', { schema_version: '1.1', root_repo_id: 'fixture', nodes: [
    { id: 'prd:fixture:chosen', type: 'prd', title: 'Chosen', status: 'active', repo_id: 'fixture', path: 'spec.md', backlinks: [] },
  ], edges: [] });
  for (const [name, text] of [['AGENTS.md', 'Fixture policy only'], ['spec.md', 'Exact specification'], ['evidence.txt', 'observed fixture result']] as Array<[string, string]>) {
    writeFileSync(join(root, name), text);
  }
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'tests/check.sh'), '#!/bin/sh\ntouch SHOULD_NOT_RUN\n');
  const repository = { id: 'fixture', root };
  const sources = [{ path: 'AGENTS.md', sha256: digest(join(root, 'AGENTS.md')) }];
  const policy = {
    schema: 'readiness-policy/1', repository, sources,
    gates: [{ id: 'fixture-proof', stage: 'implementation', scope: { goals: ['G1'] },
      dimension: 'fixtures', kind: 'file_digest', path: 'evidence.txt', sha256: digest(join(root, 'evidence.txt')) }],
    not_applicable: {
      owners: 'Single-agent fixture, no named-owner requirement',
      reviewer: 'No named reviewer requirement',
      tooling: 'Checked by verification validator',
      registration_approval: 'Disposable unprotected fixture',
      branch_target: 'No hosted operation at admission',
      harness_trust: 'No ticket connector',
    },
  };
  write(root, '.ai/policies/readiness-policy.json', policy);
  const goal = {
    id: 'G1', repository, issue_ref: 'local:G1', scope: ['tests/check.sh'],
    acceptance_criteria: ['Exact goal only'], dependencies: [], verification: ['bash tests/check.sh'],
    coverage_status: 'unknown', legacy_safe_tdd: true, legacy_risk_reason: 'Unmeasured fixture coverage',
    readiness: { preparation: 'unknown', implementation: 'ready', merge: 'unknown' },
  };
  const bundle: Obj = {
    schema: 'handoff-goals/1', id: 'chosen', repository,
    spec: { path: 'spec.md', sha256: digest(join(root, 'spec.md')) }, issue_ref: 'local:chosen',
    planning_complete: true, status: 'active', goals: [goal],
  };
  write(root, 'plan.json', bundle);
  const context: Obj = {
    schema: 'readiness-context/1', repository,
    policy: {
      sha256: digest(join(root, '.ai/policies/readiness-policy.json')),
      revision: 'simulated-review-1', issuer: 'fixture-reviewer',
    },
    sources, authority: {
      status: 'pass', stage: 'implementation', goals: ['G1'], issuer: 'simulated-runtime',
      subject_sha256: digest(join(root, 'plan.json')),
    },
    results: [], completed_goals: [],
  };
  write(root, 'context.json', context);
  return { bundle, context };
}

const call = (script: string, ...args: string[]): SpawnSyncReturns<string> =>
  spawnSync('bash', [script, ...args], { encoding: 'utf8', timeout: 20_000 });

// stdout fragments each named case must surface (python asserts kept verbatim).
const FRAGMENTS: Record<string, string[]> = {
  'blocked-direct': ['goal_not_ready'],
  'no-selection': ['selection_required'],
  'legacy-direct-no-fallback': ['migration_required:direct-goal/1'],
  'missing-fixture': ['gate_failed', 'fixture-proof:'],
};

const skillsRoot = requireArg('--skills-root');
const repoRootArg = requireArg('--repo-root');
// Retained as a required flag for CLI parity with the retired .py although the
// reimplemented helpers no longer need a Python import path.
requireArg('--fixture-source');

const results: Obj = {};

function isDependencyCase(name: string): boolean {
  return (name.startsWith('missing-') && name !== 'missing-fixture') || name.startsWith('mixed-');
}

function assertCase(name: string, result: SpawnSyncReturns<string>, success: boolean): void {
  assert.ok((result.status === 0) === success,
    `${name}: expected ${success ? 'exit 0' : 'failure'}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
}

function verdict(name: string, result: SpawnSyncReturns<string>, success: boolean): SpawnSyncReturns<string> {
  assertCase(name, result, success);
  const dependencyCase = isDependencyCase(name);
  if (dependencyCase) {
    assert.ok(`${result.stdout}${result.stderr}`.includes('dependency_failed'),
      `${name}: dependency_failed required\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
  for (const fragment of FRAGMENTS[name] ?? []) {
    assert.ok(result.stdout.includes(fragment), `${name}: ${fragment} required\nstdout: ${result.stdout}`);
  }
  const entry: Obj = { verdict: success ? 'accepted' : 'rejected' };
  if (!dependencyCase) {
    entry['report'] = JSON.parse(result.stdout) as Obj;
  }
  if (success) {
    const report = obj(entry['report']);
    if ('plan_id' in report) {
      assert.equal(report['plan_id'], 'chosen', JSON.stringify(report));
      assert.deepEqual(report['repository'], { id: 'fixture', root: realpathSync(repoRootArg) }, JSON.stringify(report));
      assert.deepEqual(report['goals'], ['G1'], JSON.stringify(report));
      assert.deepEqual(report['specification'], bundleRef['spec'], JSON.stringify(report));
      assert.deepEqual(report['handoff'], publishedEntry, JSON.stringify(report));
    }
  }
  results[name] = entry;
  return result;
}

let bundleRef: Obj;
let publishedEntry: Obj;

const flatLayout = !isDir(join(skillsRoot, '04-validate-handoff/autobahn'));
const auto = flatLayout ? join(skillsRoot, 'skills/autobahn') : join(skillsRoot, '04-validate-handoff/autobahn');
const north = flatLayout ? join(skillsRoot, 'skills/northstar') : join(skillsRoot, '02-govern-plan/northstar');

const temp = mkdtempSync(tmpDir() + '/readiness-public-');
try {
  const root = realpathSync(repoRootArg);
  assert.ok(readdirSync(root).length === 0, 'caller must supply an empty owned temporary repo');
  const { bundle, context } = fixture(root);
  bundleRef = bundle;
  const published = verdict('publish',
    call(join(north, 'handoff-write.sh'), '--root', root, '--bundle', join(root, 'plan.json')), true);
  publishedEntry = obj(obj(JSON.parse(published.stdout))['published']);
  obj(context['authority'])['subject_sha256'] = obj(obj(publishedEntry['artifacts'])['bundle'])['sha256'];
  write(root, 'context.json', context);
  const selected = ['--root', root, '--handoff', String(publishedEntry['id']), '--goal-id', 'G1', '--context', join(root, 'context.json')];
  verdict('exact', call(join(auto, 'prereq-check.sh'), ...selected), true);
  const planning = verdict('planning-without-context',
    call(join(auto, 'prereq-check.sh'), ...selected.slice(0, -2), '--stage', 'planning'), true);
  const planningReport = obj(JSON.parse(planning.stdout));
  assert.ok(!planningReport['execution_ready'] && !planningReport['dispatch_authorized'], JSON.stringify(planningReport));
  const perGoalG1 = obj(obj(planningReport['per_goal'])['G1']);
  assert.deepEqual(Object.keys(perGoalG1).sort(), ['implementation', 'merge', 'preparation'], JSON.stringify(planningReport));
  assert.ok(Object.values(perGoalG1).every((stage) => obj(stage)['status'] === 'unknown'), JSON.stringify(planningReport));
  write(root, '.ai/workflows/repo-workflow.json', { optional_branches: [{ id: 'northstar-handoff-unrelated', status: 'available' }] });
  write(root, '.ai/handoff/northstar-unrelated.md', {});
  verdict('no-selection', call(join(auto, 'prereq-check.sh'), '--root', root), false);
  verdict('unrelated-selection',
    call(join(auto, 'prereq-check.sh'), '--root', root, '--handoff', 'unrelated', '--goal-id', 'G1', '--context', join(root, 'context.json')), false);
  verdict('exact-with-unrelated', call(join(auto, 'prereq-check.sh'), ...selected), true);
  write(root, 'legacy.json', { id: 'legacy', implementation_ready: true });
  verdict('legacy-direct-no-fallback', call(join(auto, 'prereq-check.sh'), '--root', root, '--goal', join(root, 'legacy.json')), false);
  const blocked = structuredClone(bundle);
  const blockedGoal = obj((blocked['goals'] as Obj[])[0]);
  obj(blockedGoal['readiness'])['implementation'] = 'blocked';
  write(root, 'blocked.json', { schema: 'direct-goal/1', bundle: blocked });
  obj(context['authority'])['subject_sha256'] = digest(join(root, 'blocked.json'));
  write(root, 'context.json', context);
  verdict('blocked-direct',
    call(join(auto, 'prereq-check.sh'), '--root', root, '--goal', join(root, 'blocked.json'), '--context', join(root, 'context.json')), false);
  obj(context['authority'])['subject_sha256'] = obj(obj(publishedEntry['artifacts'])['bundle'])['sha256'];
  write(root, 'context.json', context);
  rmSync(join(root, 'evidence.txt'));
  verdict('missing-fixture', call(join(auto, 'prereq-check.sh'), ...selected), false);
  assert.ok(!existsSync(join(root, 'SHOULD_NOT_RUN')), 'readiness must never execute verification');
  for (const missing of ['autobahn', 'northstar']) {
    const flat = join(temp, `missing-${missing}`);
    mkdirSync(flat, { recursive: true });
    const retained = missing === 'autobahn' ? 'northstar' : 'autobahn';
    cpSync(retained === 'northstar' ? north : auto, join(flat, retained), { recursive: true });
    const script = join(flat, retained, retained === 'northstar' ? 'handoff-write.sh' : 'prereq-check.sh');
    const callArgs = retained === 'northstar'
      ? ['--root', root, '--bundle', join(root, 'plan.json')]
      : selected;
    verdict(`missing-${missing}`, call(script, ...callArgs), false);
  }
  const mixed = join(temp, 'mixed');
  mkdirSync(mixed, { recursive: true });
  for (const [name, dir] of [['northstar', north], ['autobahn', auto]] as const) {
    cpSync(dir, join(mixed, name), { recursive: true });
  }
  const dependencyPath = join(mixed, 'northstar/readiness-dependency.json');
  const data = JSON.parse(readFileSync(dependencyPath, 'utf8')) as Obj;
  data['release_fingerprint'] = 'different-release';
  writeFileSync(dependencyPath, JSON.stringify(data));
  verdict('mixed-producer', call(join(mixed, 'northstar/handoff-write.sh'), '--root', root, '--bundle', join(root, 'plan.json')), false);
  verdict('mixed-consumer', call(join(mixed, 'autobahn/prereq-check.sh'), ...selected), false);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const sortedResults = Object.fromEntries(
  Object.entries(results).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
);
process.stdout.write(`${JSON.stringify(sortedResults)}\n`);