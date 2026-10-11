/**
 * TDD tests for ACH-C-04 — `ai-catapult backfill --policy-v2`.
 *
 * The goal record's acceptance criteria are the spec:
 *   1. runs only when invoked explicitly (never from init or install) and writes
 *      the baseline policy/2 candidate only when the repo has no policy, or a v1
 *      policy whose registry has no active plan;
 *   2. decides activity by calling the vendored `contract-run.sh inventory-v1`
 *      (never by reimplementing inventory): in-flight = active, completed is not
 *      active, unstarted and partly merged are not active but are listed as
 *      requiring migration of their unmerged goals (O10), an unreachable hosted
 *      API is active;
 *   3. fails closed: one consolidated report naming every active plan, a refusal
 *      on a policy/2 with different bytes, no writes of approvals/anchors/
 *      readiness contexts, nothing outside --root, refuses symlinked or
 *      out-of-root targets;
 *   4. is idempotent and ledgered: a second run with the same inputs is a no-op
 *      that exits 0, every run appends one line to
 *      `.ai/drift/backfill-ledger.jsonl`, `--dry-run` prints the unified diff
 *      without writing anything.
 *
 * Fixture fates are driven through the vendored inventory seam (an in-process
 * runner that returns the `v1-inventory/1` result the driver would print) —
 * exactly the observer pattern: a test adapter exists only in-process. The
 * production runner is separately exercised against a fake vendored
 * `contract-run.sh` that records its exact argv, so the call itself is observed.
 *
 * Expected policy bytes are computed in this file directly from the vendored
 * template, never by importing the implementation's renderer.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveVendorSkill } from '../src/skill-resolver.ts';
import {
  BACKFILL_HELP,
  runBackfill,
  type InventoryOutcome,
  type InventoryReport,
  type InventoryRunner,
} from '../src/backfill.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const bin = join(repoRoot, 'bin/ai-catapult.ts');
const realSkills = join(repoRoot, 'vendor/skills');
const realTemplates = join(resolveVendorSkill(realSkills, 'ai-catapult-init'), 'templates');
const realPolicyTemplate = join(realTemplates, 'dot-ai/policies/readiness-policy.json');

const POLICY_REL = '.ai/policies/readiness-policy.json';
const LEDGER_REL = '.ai/drift/backfill-ledger.jsonl';
const STAMP = new Date('2026-10-10T22:01:03Z');

type Obj = Record<string, unknown>;

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** A realpath'd fixture root: the CLI refuses a symlinked final root component. */
function fixtureRoot(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function write(root: string, rel: string, content: string): void {
  const target = join(root, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Independent rendering of the baseline candidate: the vendored template with {{REPO_ID}}. */
function candidate(repoId: string): string {
  return readFileSync(realPolicyTemplate, 'utf8').replaceAll('{{REPO_ID}}', repoId);
}

/** The `v1-inventory/1` report shape the vendored driver prints. */
function inventoryReport(entries: Array<Obj>): InventoryReport {
  return {
    schema: 'v1-inventory/1',
    registry: '.ai/workflows/northstar-readiness-v1.json',
    target: 'refs/remotes/origin/main',
    entries,
  };
}

function ok(entries: Array<Obj>): InventoryOutcome {
  return { exitCode: 0, report: inventoryReport(entries) };
}

function busy(entries: Array<Obj>): InventoryOutcome {
  return { exitCode: 1, report: { ...inventoryReport(entries), refusals: [{ code: 'v1_inventory_in_flight' }] } };
}

type ModuleRun = { code: number; out: string; err: string };

function runModule(
  argv: string[],
  options: { root: string; inventory?: InventoryRunner | undefined; templatesDir?: string; vendorSkillsDir?: string | undefined; at?: Date },
): ModuleRun {
  const out: string[] = [];
  const err: string[] = [];
  const code = runBackfill(argv, {
    templatesDir: options.templatesDir ?? realTemplates,
    vendorSkillsDir: options.vendorSkillsDir,
    inventory: options.inventory,
    now: () => options.at ?? STAMP,
    io: { out: (text) => out.push(text), err: (text) => err.push(text) },
  });
  return { code, out: out.join(''), err: err.join('') };
}

function reportOf(run: ModuleRun): Obj {
  return JSON.parse(run.out) as Obj;
}

function refusalsOf(run: ModuleRun): Array<Obj> {
  const refusals = reportOf(run).refusals;
  assert.ok(Array.isArray(refusals), `report must carry refusals: ${run.out}${run.err}`);
  return refusals as Array<Obj>;
}

function ledgerLines(root: string): Array<Obj> {
  const path = join(root, LEDGER_REL);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Obj);
}

/** Recursive path -> sha256 snapshot for the "nothing else is written" assertions. */
function snapshot(root: string): Map<string, string> {
  const result = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).split(sep).join('/');
      if (entry.isDirectory()) walk(full);
      else result.set(rel, sha256(readFileSync(full, 'utf8')));
    }
  };
  walk(realpathSync(root));
  return result;
}

function assertUnchanged(before: Map<string, string>, after: Map<string, string>, allowedNew: string[]): void {
  for (const [path, digest] of before) {
    assert.equal(after.get(path), digest, `${path} must stay byte-unchanged`);
  }
  for (const path of after.keys()) {
    if (!before.has(path) && !allowedNew.includes(path)) {
      assert.fail(`unexpected new path written: ${path}`);
    }
  }
}

// ---------------------------------------------------------------------------
// A fake vendored skills tree: catalog + ai-catapult-init templates (a byte
// copy of the real policy template) + an autobahn contract-run.sh that records
// its argv and replays a fixture report/exit code.
// ---------------------------------------------------------------------------

const FAKE_INVENTORY_SCRIPT = `#!/usr/bin/env bash
set -eu
d="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
printf '%s\\n' "$@" >> "$d/calls.txt"
if [ -f "$d/report.json" ]; then cat "$d/report.json"; fi
if [ -f "$d/exit_code" ]; then exit "$(cat "$d/exit_code")"; fi
exit 0
`;

type FakeVendor = { skills: string; autobahn: string; calls: string };

function fakeVendor(): FakeVendor {
  const skills = join(fixtureRoot('backfill-vendor-'), 'skills');
  mkdirSync(skills, { recursive: true });
  const autobahn = join(skills, '04-validate-handoff/autobahn');
  const initTemplates = join(skills, '03-configure-generate/ai-catapult-init/templates');
  const catalog = JSON.parse(readFileSync(join(realSkills, 'catalog.json'), 'utf8')) as { skills: Array<Obj> };
  catalog.skills = [
    { name: 'autobahn', source_path: '04-validate-handoff/autobahn' },
    { name: 'ai-catapult-init', source_path: '03-configure-generate/ai-catapult-init' },
  ];
  writeFileSync(join(skills, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  write(skills, '04-validate-handoff/autobahn/SKILL.md', '---\nname: autobahn\ndescription: fake\n---\n\nfixture\n');
  write(skills, '04-validate-handoff/autobahn/contract-run.sh', FAKE_INVENTORY_SCRIPT);
  chmodSync(join(autobahn, 'contract-run.sh'), 0o755);
  write(skills, '03-configure-generate/ai-catapult-init/SKILL.md', '---\nname: ai-catapult-init\ndescription: fake\n---\n\nfixture\n');
  write(initTemplates, 'boundary-manifest.json', `${JSON.stringify({
    paths: [{ path: POLICY_REL, classification: 'mechanical', template: 'dot-ai/policies/readiness-policy.json' }],
  }, null, 2)}\n`);
  write(initTemplates, 'dot-ai/policies/readiness-policy.json', readFileSync(realPolicyTemplate, 'utf8'));
  // resolveVendorSkill validates that the four graph-automation templates exist.
  for (const rel of ['graph-automation/config.json', 'graph-automation/graph-refresh.sh', 'graph-automation/harness-hooks.json', 'graph-automation/hook-body.sh']) {
    write(initTemplates, rel, '{}\n');
  }
  return { skills, autobahn, calls: join(autobahn, 'calls.txt') };
}

function setFakeInventory(vendor: FakeVendor, outcome: { report?: unknown; exitCode?: number }): void {
  if (outcome.report === undefined) rmSync(join(vendor.autobahn, 'report.json'), { force: true });
  else writeFileSync(join(vendor.autobahn, 'report.json'), `${JSON.stringify(outcome.report)}\n`);
  if (outcome.exitCode === undefined) rmSync(join(vendor.autobahn, 'exit_code'), { force: true });
  else writeFileSync(join(vendor.autobahn, 'exit_code'), `${outcome.exitCode}\n`);
}

function runCli(args: string[], env: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
}

// ---------------------------------------------------------------------------
// AC-1: explicit entry point; the write conditions
// ---------------------------------------------------------------------------

void test('ACH-C-04 backfill: a fresh repository writes the baseline policy/2 and one ledger line', () => {
  const root = fixtureRoot('backfill-fresh-');
  const repoId = root.split('/').at(-1) ?? '';
  const run = runModule(['--policy-v2', '--root', root], { root, inventory: () => ok([]) });

  assert.equal(run.code, 0, run.err);
  assert.equal(readFileSync(join(root, POLICY_REL), 'utf8'), candidate(repoId));
  const report = reportOf(run);
  assert.equal(report.schema, 'backfill-report/1');
  assert.equal(report.command, 'backfill --policy-v2');
  assert.equal(report.repository_id, repoId);
  assert.equal(report.result, 'written');
  assert.equal(report.before_sha256, null);
  assert.equal(report.after_sha256, sha256(candidate(repoId)));

  const ledger = ledgerLines(root);
  assert.equal(ledger.length, 1);
  const line = ledger[0] ?? {};
  assert.deepEqual(Object.keys(line), [
    'schema', 'command', 'repository_id', 'before_sha256', 'after_sha256', 'at', 'result',
  ]);
  assert.equal(line.schema, 'backfill-ledger/1');
  assert.equal(line.command, 'backfill --policy-v2');
  assert.equal(line.repository_id, repoId);
  assert.equal(line.before_sha256, null);
  assert.equal(line.after_sha256, sha256(candidate(repoId)));
  assert.match(String(line.at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(line.result, 'written');
});

void test('ACH-C-04 backfill: a rerun with the same inputs is a no-op that exits 0', () => {
  const root = fixtureRoot('backfill-rerun-');
  const inventory: InventoryRunner = () => ok([]);
  const first = runModule(['--policy-v2', '--root', root], { root, inventory });
  assert.equal(first.code, 0, first.err);
  const policy = readFileSync(join(root, POLICY_REL), 'utf8');

  const second = runModule(['--policy-v2', '--root', root], { root, inventory });
  assert.equal(second.code, 0, second.err);
  assert.equal(reportOf(second).result, 'no-op');
  assert.equal(readFileSync(join(root, POLICY_REL), 'utf8'), policy);
  const ledger = ledgerLines(root);
  assert.equal(ledger.length, 2, 'every run appends one line');
  assert.equal(ledger[0]?.result, 'written');
  assert.equal(ledger[1]?.result, 'no-op');
  assert.equal(ledger[1]?.before_sha256, ledger[1]?.after_sha256);
});

void test('ACH-C-04 backfill: a v1 policy with no active plan is replaced by the baseline candidate', () => {
  const root = fixtureRoot('backfill-v1-');
  const v1 = '{\n  "schema": "readiness-policy/1",\n  "repository": { "id": "kept-id" }\n}\n';
  write(root, POLICY_REL, v1);
  const run = runModule(['--policy-v2', '--root', root], { root, inventory: () => ok([]) });

  assert.equal(run.code, 0, run.err);
  const report = reportOf(run);
  assert.equal(report.result, 'written');
  assert.equal(report.repository_id, 'kept-id', 'the v1 policy repository id is preserved');
  assert.equal(report.before_sha256, sha256(v1));
  assert.equal(readFileSync(join(root, POLICY_REL), 'utf8'), candidate('kept-id'));
  assert.equal(ledgerLines(root).at(-1)?.result, 'written');
});

void test('ACH-C-04 backfill: an unsupported policy schema refuses', () => {
  const root = fixtureRoot('backfill-schema-');
  write(root, POLICY_REL, '{"schema": "readiness-policy/3"}\n');
  const run = runModule(['--policy-v2', '--root', root], { root, inventory: () => ok([]) });
  assert.equal(run.code, 1);
  assert.equal(refusalsOf(run)[0]?.code, 'policy_unsupported');
  assert.equal(readFileSync(join(root, POLICY_REL), 'utf8'), '{"schema": "readiness-policy/3"}\n');
  assert.equal(ledgerLines(root).at(-1)?.result, 'refused');
});

// ---------------------------------------------------------------------------
// AC-2: activity comes from the vendored inventory, in-flight only
// ---------------------------------------------------------------------------

void test('ACH-C-04 backfill: a single in-flight plan refuses with one consolidated report and writes no policy', () => {
  const root = fixtureRoot('backfill-active-');
  const run = runModule(['--policy-v2', '--root', root], {
    root,
    inventory: () => busy([{ id: 'northstar-plan-tswc-ai-catapult', plan_id: 'tswc-ai-catapult', fate: 'in-flight', unmerged: ['tswc-ac-a2'] }]),
  });
  assert.equal(run.code, 1);
  const refusals = refusalsOf(run);
  assert.equal(refusals.length, 1, 'exactly one consolidated report');
  assert.equal(refusals[0]?.code, 'plan_in_flight');
  assert.match(String(refusals[0]?.detail), /northstar-plan-tswc-ai-catapult/);
  assert.equal(reportOf(run).result, 'refused');
  assert.equal(existsSync(join(root, POLICY_REL)), false, 'nothing written while a plan is active');
  assert.equal(ledgerLines(root).at(-1)?.result, 'refused');
  assert.match(run.err, /refused/);
});

void test('ACH-C-04 backfill: a two-plan P4/TSWC registry refuses when the in-flight second entry is the only active plan', () => {
  const root = fixtureRoot('backfill-twoplan-');
  const run = runModule(['--policy-v2', '--root', root], {
    root,
    inventory: () => busy([
      { id: 'northstar-plan-xskp-p4-adopt-engine', plan_id: 'xskp-p4-adopt-engine', fate: 'unstarted', unmerged: ['XSKP-P4-01', 'XSKP-P4-02'] },
      { id: 'northstar-plan-tswc-ai-catapult', plan_id: 'tswc-ai-catapult', fate: 'in-flight', unmerged: ['tswc-ac-a2', 'tswc-ac-b1'] },
    ]),
  });
  assert.equal(run.code, 1, 'an in-flight second entry cannot be missed');
  const detail = String(refusalsOf(run)[0]?.detail);
  assert.match(detail, /northstar-plan-tswc-ai-catapult/);
  assert.doesNotMatch(detail, /xskp-p4-adopt-engine/, 'the unstarted entry is not active');
  const migrations = reportOf(run).migrations;
  assert.ok(Array.isArray(migrations));
  assert.equal((migrations as Array<Obj>).length, 1, 'the unstarted plan is listed for migration');
  assert.equal((migrations as Array<Obj>)[0]?.plan_id, 'xskp-p4-adopt-engine');
  assert.equal(existsSync(join(root, POLICY_REL)), false);
});

void test('ACH-C-04 backfill: one consolidated report names every active plan', () => {
  const root = fixtureRoot('backfill-both-');
  const run = runModule(['--policy-v2', '--root', root], {
    root,
    inventory: () => busy([
      { id: 'northstar-plan-xskp-p4-adopt-engine', plan_id: 'xskp-p4-adopt-engine', fate: 'in-flight' },
      { id: 'northstar-plan-tswc-ai-catapult', plan_id: 'tswc-ai-catapult', fate: 'in-flight' },
    ]),
  });
  assert.equal(run.code, 1);
  const refusals = refusalsOf(run);
  assert.equal(refusals.length, 1);
  const detail = String(refusals[0]?.detail);
  assert.match(detail, /northstar-plan-xskp-p4-adopt-engine/);
  assert.match(detail, /northstar-plan-tswc-ai-catapult/);
});

void test('ACH-C-04 backfill: completed plans are not active and are not listed for migration', () => {
  const root = fixtureRoot('backfill-completed-');
  const run = runModule(['--policy-v2', '--root', root], {
    root,
    inventory: () => ok([
      { id: 'northstar-plan-tswc-ai-catapult', plan_id: 'tswc-ai-catapult', fate: 'completed', unmerged: [] },
    ]),
  });
  assert.equal(run.code, 0, run.err);
  assert.equal(reportOf(run).result, 'written');
  assert.deepEqual(reportOf(run).migrations, []);
});

void test('ACH-C-04 backfill: an unstarted plan is not active but is listed for migration of its unmerged goals', () => {
  const root = fixtureRoot('backfill-unstarted-');
  const run = runModule(['--policy-v2', '--root', root], {
    root,
    inventory: () => ok([
      { id: 'northstar-plan-xskp-p4-adopt-engine', plan_id: 'xskp-p4-adopt-engine', fate: 'unstarted', unmerged: ['XSKP-P4-01', 'XSKP-P4-02'] },
    ]),
  });
  assert.equal(run.code, 0, run.err);
  assert.equal(reportOf(run).result, 'written');
  const migrations = reportOf(run).migrations as Array<Obj>;
  assert.equal(migrations.length, 1);
  assert.equal(migrations[0]?.fate, 'unstarted');
  assert.deepEqual(migrations[0]?.goals, ['XSKP-P4-01', 'XSKP-P4-02']);
});

void test('ACH-C-04 backfill: a partly merged plan lists only its unmerged goals', () => {
  const root = fixtureRoot('backfill-partly-');
  const run = runModule(['--policy-v2', '--root', root], {
    root,
    inventory: () => ok([
      {
        id: 'northstar-plan-xskp-p4-adopt-engine',
        plan_id: 'xskp-p4-adopt-engine',
        fate: 'partly-merged',
        merged: [{ goal: 'XSKP-P4-01', pr: 60, merge_commit: '0'.repeat(40) }],
        unmerged: ['XSKP-P4-02', 'XSKP-P4-03'],
      },
    ]),
  });
  assert.equal(run.code, 0, run.err);
  const migrations = reportOf(run).migrations as Array<Obj>;
  assert.equal(migrations[0]?.fate, 'partly-merged');
  assert.deepEqual(migrations[0]?.goals, ['XSKP-P4-02', 'XSKP-P4-03']);
});

void test('ACH-C-04 backfill: an unreachable hosted API counts as active and refuses', () => {
  const root = fixtureRoot('backfill-unreachable-');
  const run = runModule(['--policy-v2', '--root', root], {
    root,
    inventory: () => busy([
      { id: 'northstar-plan-tswc-ai-catapult', plan_id: 'tswc-ai-catapult', fate: 'in-flight', ambiguous: [{ goal: null, pr: null, reason: 'hosted_unreachable' }] },
    ]),
  });
  assert.equal(run.code, 1);
  assert.equal(refusalsOf(run)[0]?.code, 'plan_in_flight');
  assert.equal(existsSync(join(root, POLICY_REL)), false);
});

void test('ACH-C-04 backfill: a crashed, malformed or unattributable inventory refuses', () => {
  const crashed = fixtureRoot('backfill-crash-');
  const crash = runModule(['--policy-v2', '--root', crashed], { root: crashed, inventory: () => ({ exitCode: null, error: 'spawn failed' }) });
  assert.equal(crash.code, 1);
  assert.equal(refusalsOf(crash)[0]?.code, 'inventory_unreachable');
  assert.equal(existsSync(join(crashed, POLICY_REL)), false);

  const malformed = fixtureRoot('backfill-malformed-');
  const bad = runModule(['--policy-v2', '--root', malformed], { root: malformed, inventory: () => ({ exitCode: 0, report: { schema: 'something-else' } }) });
  assert.equal(bad.code, 1);
  assert.equal(refusalsOf(bad)[0]?.code, 'inventory_invalid');

  const unknown = fixtureRoot('backfill-unknown-fate-');
  const unattributable = runModule(['--policy-v2', '--root', unknown], {
    root: unknown,
    inventory: () => ok([{ id: 'northstar-plan-mystery', fate: 'maybe' }]),
  });
  assert.equal(unattributable.code, 1);
  assert.equal(refusalsOf(unattributable)[0]?.code, 'inventory_unattributable');
  assert.equal(existsSync(join(unknown, POLICY_REL)), false);
});

void test('ACH-C-04 backfill: an inventory exit 1 without an in-flight entry still refuses', () => {
  const root = fixtureRoot('backfill-exit1-');
  const run = runModule(['--policy-v2', '--root', root], {
    root,
    inventory: () => ({ exitCode: 1, report: { ...inventoryReport([{ id: 'northstar-plan-xskp-p4-adopt-engine', fate: 'unstarted' }]), refusals: [{ code: 'driver_not_base_copy' }] } }),
  });
  assert.equal(run.code, 1);
  assert.equal(refusalsOf(run)[0]?.code, 'inventory_refused');
  assert.equal(existsSync(join(root, POLICY_REL)), false);
});

// ---------------------------------------------------------------------------
// AC-3: fail-closed policy comparison, no foreign writes, symlink refusal
// ---------------------------------------------------------------------------

void test('ACH-C-04 backfill: a policy/2 with different bytes refuses', () => {
  const root = fixtureRoot('backfill-v2-differs-');
  const repoId = root.split('/').at(-1) ?? '';
  const different = candidate(repoId).replace('"identity_model": "multi"', '"identity_model": "single"');
  write(root, POLICY_REL, different);
  const run = runModule(['--policy-v2', '--root', root], { root, inventory: () => ok([]) });
  assert.equal(run.code, 1);
  assert.equal(refusalsOf(run)[0]?.code, 'policy_v2_differs');
  assert.equal(readFileSync(join(root, POLICY_REL), 'utf8'), different);
  assert.equal(ledgerLines(root).at(-1)?.result, 'refused');
});

void test('ACH-C-04 backfill: a policy/2 with identical bytes is a no-op', () => {
  const root = fixtureRoot('backfill-v2-same-');
  const repoId = root.split('/').at(-1) ?? '';
  write(root, POLICY_REL, candidate(repoId));
  const run = runModule(['--policy-v2', '--root', root], { root, inventory: () => ok([]) });
  assert.equal(run.code, 0, run.err);
  assert.equal(reportOf(run).result, 'no-op');
  assert.equal(readFileSync(join(root, POLICY_REL), 'utf8'), candidate(repoId));
});

void test('ACH-C-04 backfill: never writes approvals, anchors or readiness contexts', () => {
  const root = fixtureRoot('backfill-untouched-');
  write(root, '.ai/approvals/ach-catapult-delivery/fake.json', '{"keep": true}\n');
  write(root, '.ai/approvals/ach-catapult-delivery/fake.json.sig', 'signature\n');
  write(root, '.ai/handoff/readiness-v2/plan/fake/goals.json', '{"keep": true}\n');
  write(root, '.ai/execution/context/default.json', '{"keep": true}\n');
  write(root, '.ai/workflows/northstar-readiness-v1.json', '{"schema": "readiness-contract/1", "plans": []}\n');
  write(root, '.ai/drift/last-drift.json', '{"keep": true}\n');
  const before = snapshot(root);
  const run = runModule(['--policy-v2', '--root', root], { root, inventory: () => ok([]) });
  assert.equal(run.code, 0, run.err);
  assertUnchanged(before, snapshot(root), [POLICY_REL, LEDGER_REL]);
});

void test('ACH-C-04 backfill: refuses a symlinked root and writes nothing', () => {
  const real = fixtureRoot('backfill-real-');
  const link = join(fixtureRoot('backfill-link-'), 'repo');
  symlinkSync(real, link);
  const run = runModule(['--policy-v2', '--root', link], { root: link, inventory: () => ok([]) });
  assert.equal(run.code, 1);
  assert.equal(refusalsOf(run)[0]?.code, 'root_symlinked');
  assert.equal(existsSync(join(real, POLICY_REL)), false);
  assert.equal(ledgerLines(real).length, 0, 'a refused symlinked root is not ledgered inside its target');
});

void test('ACH-C-04 backfill: refuses an out-of-root .ai symlink and leaves the outside directory untouched', () => {
  const outside = fixtureRoot('backfill-outside-');
  const root = fixtureRoot('backfill-escape-');
  symlinkSync(outside, join(root, '.ai'));
  const run = runModule(['--policy-v2', '--root', root], { root, inventory: () => ok([]) });
  assert.equal(run.code, 1);
  assert.equal(refusalsOf(run)[0]?.code, 'path_symlinked');
  assert.deepEqual(readdirSync(outside), [], 'nothing may be written outside --root');
});

void test('ACH-C-04 backfill: refuses a symlinked policy file', () => {
  const outside = fixtureRoot('backfill-policy-outside-');
  const target = join(outside, 'readiness-policy.json');
  writeFileSync(target, '{"schema": "readiness-policy/2"}\n');
  const root = fixtureRoot('backfill-policy-link-');
  mkdirSync(join(root, '.ai/policies'), { recursive: true });
  symlinkSync(target, join(root, POLICY_REL));
  const run = runModule(['--policy-v2', '--root', root], { root, inventory: () => ok([]) });
  assert.equal(run.code, 1);
  assert.equal(refusalsOf(run)[0]?.code, 'path_symlinked');
  assert.equal(readFileSync(target, 'utf8'), '{"schema": "readiness-policy/2"}\n');
});

// ---------------------------------------------------------------------------
// AC-4: dry-run, usage surface
// ---------------------------------------------------------------------------

void test('ACH-C-04 backfill: --dry-run prints the diff and writes nothing', () => {
  const root = fixtureRoot('backfill-dry-fresh-');
  const repoId = root.split('/').at(-1) ?? '';
  const run = runModule(['--policy-v2', '--root', root, '--dry-run'], { root, inventory: () => ok([]) });
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /^--- a\/\.ai\/policies\/readiness-policy\.json$/m);
  assert.match(run.out, /^\+\+\+ b\/\.ai\/policies\/readiness-policy\.json$/m);
  assert.match(run.out, /^@@ -0,0 \+1,\d+ @@$/m);
  assert.ok(run.out.split('\n').some((line) => line === '+  "schema": "readiness-policy/2",'), 'added candidate lines must be printed');
  assert.equal(existsSync(join(root, POLICY_REL)), false, 'dry-run must not write the policy');
  assert.equal(existsSync(join(root, LEDGER_REL)), false, 'dry-run must not write the ledger');
  assert.equal(existsSync(join(root, '.ai/drift')), false);
  const expected = candidate(repoId).split('\n').filter((line, index, all) => !(index === all.length - 1 && line === ''));
  const added = run.out.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'));
  assert.equal(added.length, expected.length, 'every candidate line is shown as an addition');
});

void test('ACH-C-04 backfill: --dry-run of an active refusal refuses and writes nothing', () => {
  const root = fixtureRoot('backfill-dry-active-');
  const run = runModule(['--policy-v2', '--root', root, '--dry-run'], {
    root,
    inventory: () => busy([{ id: 'northstar-plan-tswc-ai-catapult', plan_id: 'tswc-ai-catapult', fate: 'in-flight' }]),
  });
  assert.equal(run.code, 1);
  assert.equal(refusalsOf(run)[0]?.code, 'plan_in_flight');
  assert.equal(existsSync(join(root, POLICY_REL)), false);
  assert.equal(existsSync(join(root, LEDGER_REL)), false);
});

void test('ACH-C-04 backfill: --dry-run of a v1 replacement prints removed and added lines and writes nothing', () => {
  const root = fixtureRoot('backfill-dry-v1-');
  const v1 = '{\n  "schema": "readiness-policy/1"\n}\n';
  write(root, POLICY_REL, v1);
  const run = runModule(['--policy-v2', '--root', root, '--dry-run'], { root, inventory: () => ok([]) });
  assert.equal(run.code, 0, run.err);
  assert.ok(run.out.split('\n').includes('-  "schema": "readiness-policy/1"'), 'removed v1 line');
  assert.ok(run.out.split('\n').includes('+  "schema": "readiness-policy/2",'), 'added v2 line');
  assert.equal(readFileSync(join(root, POLICY_REL), 'utf8'), v1);
  assert.equal(existsSync(join(root, LEDGER_REL)), false);
});

void test('ACH-C-04 backfill: --dry-run with no changes prints no diff', () => {
  const root = fixtureRoot('backfill-dry-noop-');
  const repoId = root.split('/').at(-1) ?? '';
  write(root, POLICY_REL, candidate(repoId));
  const run = runModule(['--policy-v2', '--root', root, '--dry-run'], { root, inventory: () => ok([]) });
  assert.equal(run.code, 0, run.err);
  assert.equal(run.out, '');
  assert.equal(existsSync(join(root, LEDGER_REL)), false);
});

void test('ACH-C-04 backfill: usage errors exit 2 without touching the root', () => {
  const root = fixtureRoot('backfill-usage-');
  for (const argv of [
    ['--root', root],
    ['--policy-v2', '--root', root, '--force'],
    ['--policy-v2', '--root', root, 'extra'],
    ['--policy-v2', '--root'],
  ]) {
    const run = runModule(argv, { root, inventory: () => ok([]) });
    assert.equal(run.code, 2, `usage error for ${argv.join(' ')}: ${run.out}${run.err}`);
    assert.match(run.err, /backfill --help/);
    assert.equal(run.out, '');
  }
  assert.deepEqual(readdirSync(root), [], 'usage errors must write nothing');
});

void test('ACH-C-04 backfill: --help exits 0 and documents the command', () => {
  const root = fixtureRoot('backfill-help-');
  const run = runModule(['--help'], { root, inventory: () => ok([]) });
  assert.equal(run.code, 0);
  assert.match(run.out, /--policy-v2/);
  assert.match(run.out, /--dry-run/);
  assert.equal(run.out, `${BACKFILL_HELP}\n`);
});

// ---------------------------------------------------------------------------
// The production runner: the vendored contract-run.sh is what gets called
// ---------------------------------------------------------------------------

void test('ACH-C-04 backfill: the production runner calls the vendored contract-run.sh with inventory-v1 --root', () => {
  const vendor = fakeVendor();
  const root = fixtureRoot('backfill-runner-');
  setFakeInventory(vendor, { report: inventoryReport([]), exitCode: 0 });
  const run = runModule(['--policy-v2', '--root', root], {
    root,
    templatesDir: join(vendor.skills, '03-configure-generate/ai-catapult-init/templates'),
    vendorSkillsDir: vendor.skills,
  });
  assert.equal(run.code, 0, run.err);
  assert.equal(readFileSync(vendor.calls, 'utf8'), `inventory-v1\n--root\n${root}\n`, 'exact argv');
  assert.equal(existsSync(join(root, POLICY_REL)), true);

  const active = fixtureRoot('backfill-runner-active-');
  setFakeInventory(vendor, {
    report: { ...inventoryReport([{ id: 'northstar-plan-tswc-ai-catapult', plan_id: 'tswc-ai-catapult', fate: 'in-flight' }]), refusals: [{ code: 'v1_inventory_in_flight' }] },
    exitCode: 1,
  });
  const refused = runModule(['--policy-v2', '--root', active], {
    root: active,
    templatesDir: join(vendor.skills, '03-configure-generate/ai-catapult-init/templates'),
    vendorSkillsDir: vendor.skills,
  });
  assert.equal(refused.code, 1);
  assert.equal(refusalsOf(refused)[0]?.code, 'plan_in_flight');
});

void test('ACH-C-04 backfill: the production runner refuses when the vendored script is absent', () => {
  const vendor = fakeVendor();
  rmSync(join(vendor.autobahn, 'contract-run.sh'));
  const root = fixtureRoot('backfill-runner-missing-');
  const run = runModule(['--policy-v2', '--root', root], {
    root,
    templatesDir: join(vendor.skills, '03-configure-generate/ai-catapult-init/templates'),
    vendorSkillsDir: vendor.skills,
  });
  assert.equal(run.code, 1);
  assert.equal(refusalsOf(run)[0]?.code, 'inventory_unavailable');
  assert.equal(existsSync(join(root, POLICY_REL)), false);
});

// ---------------------------------------------------------------------------
// CLI seam: the real bin entry point, and the explicit-only contract
// ---------------------------------------------------------------------------

void test('ACH-C-04 backfill: the CLI writes the policy at --root end to end', () => {
  const vendor = fakeVendor();
  const root = fixtureRoot('backfill-cli-');
  const repoId = root.split('/').at(-1) ?? '';
  setFakeInventory(vendor, { report: inventoryReport([]), exitCode: 0 });
  const run = runCli(['backfill', '--policy-v2', '--root', root], { AI_CATAPULT_VENDOR_SKILLS: vendor.skills });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.equal(readFileSync(join(root, POLICY_REL), 'utf8'), candidate(repoId));
  assert.equal((JSON.parse(run.stdout) as Obj).result, 'written');

  const dry = runCli(['backfill', '--policy-v2', '--root', root, '--dry-run'], { AI_CATAPULT_VENDOR_SKILLS: vendor.skills });
  assert.equal(dry.status, 0, `${dry.stdout}\n${dry.stderr}`);
  assert.equal(dry.stdout, '', 'an identical policy has no diff');
});

void test('ACH-C-04 backfill: the top-level help lists backfill and backfill --help exits 0', () => {
  const top = runCli(['--help']);
  assert.equal(top.status, 0, top.stderr);
  assert.match(top.stdout, /backfill/);
  const help = runCli(['backfill', '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--policy-v2/);
});

void test('ACH-C-04 backfill: init does not run backfill', () => {
  const target = fixtureRoot('backfill-init-');
  const run = runCli(['init', target]);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.equal(existsSync(join(target, POLICY_REL)), true, 'init writes its own baseline policy');
  assert.equal(existsSync(join(target, LEDGER_REL)), false, 'init must never run backfill');
});

void test('ACH-C-04 backfill: install does not run backfill', () => {
  const cwd = fixtureRoot('backfill-install-');
  const run = spawnSync(process.execPath, [bin, 'install'], {
    encoding: 'utf8',
    cwd,
    env: {
      ...process.env,
      HOME: '/nonexistent-no-home',
      CODEX_HOME: '/nonexistent-no-codex',
      XDG_CONFIG_HOME: '/nonexistent-no-xdg',
    },
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.equal(existsSync(join(cwd, LEDGER_REL)), false, 'install must never run backfill');
});

void test('ACH-C-04 backfill: the written policy is byte-identical to what init writes for the same repository id', () => {
  const parent = fixtureRoot('backfill-parity-');
  const initTarget = join(parent, 'a', 'parity-repo');
  const backfillTarget = join(parent, 'b', 'parity-repo');
  mkdirSync(initTarget, { recursive: true });
  mkdirSync(backfillTarget, { recursive: true });
  const init = runCli(['init', initTarget]);
  assert.equal(init.status, 0, `${init.stdout}\n${init.stderr}`);

  const vendor = fakeVendor();
  setFakeInventory(vendor, { report: inventoryReport([]), exitCode: 0 });
  const run = runCli(['backfill', '--policy-v2', '--root', backfillTarget], { AI_CATAPULT_VENDOR_SKILLS: vendor.skills });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.deepEqual(
    readFileSync(join(backfillTarget, POLICY_REL)),
    readFileSync(join(initTarget, POLICY_REL)),
    'backfill and init must emit identical baseline policy bytes',
  );
});

void test('ACH-C-04 backfill: a directory root is required', () => {
  const root = fixtureRoot('backfill-file-');
  const file = join(root, 'not-a-dir');
  writeFileSync(file, 'x\n');
  const run = runModule(['--policy-v2', '--root', file], { root, inventory: () => ok([]) });
  assert.equal(run.code, 1);
  assert.equal(refusalsOf(run)[0]?.code, 'root_not_directory');

  const missing = runModule(['--policy-v2', '--root', join(root, 'missing')], { root, inventory: () => ok([]) });
  assert.equal(missing.code, 1);
  assert.equal(refusalsOf(missing)[0]?.code, 'root_missing');
});

void test('ACH-C-04 backfill: the policy template is read through the vendored boundary manifest', () => {
  const vendor = fakeVendor();
  rmSync(join(vendor.skills, '03-configure-generate/ai-catapult-init/templates/boundary-manifest.json'));
  const root = fixtureRoot('backfill-template-');
  const run = runModule(['--policy-v2', '--root', root], {
    root,
    templatesDir: join(vendor.skills, '03-configure-generate/ai-catapult-init/templates'),
    inventory: () => ok([]),
  });
  assert.equal(run.code, 1);
  assert.equal(refusalsOf(run)[0]?.code, 'template_missing');
  assert.equal(existsSync(join(root, POLICY_REL)), false);
});
