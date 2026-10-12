/**
 * TDD tests for tswc-ac-b3 — `ai-catapult evolve --validate`.
 *
 * Eq. 4 over recorded judgments: accept iff R(T_val,k) > R_best; early-stop
 * iff R_best is the rubric maximum 1.0; otherwise revert to S_{k-1} and drop
 * the overlay. R_best is seeded from the current catalog judgment, never a
 * skill-disabled baseline. A judgment not bound to the candidate overlay
 * hash, the frozen task-set version and the judge model is refused
 * `judgment_unbound`. Recorded per-cycle cost_usd past $100 is refused
 * `cycle_budget_exhausted`. Negative fixtures mutate a would-accept workspace
 * and prove each refusal fires. No numeric threshold is cited to the paper.
 *
 * Filesystem work stays in realpath'd mkdtemp dirs. Nothing in the checkout
 * is written except by the evidence recorder, outside this file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendWikiFile } from '../src/evolve/append-only.ts';
import { evolvePaths, initEvolveLayout } from '../src/evolve/layout.ts';
import { recordJudgment } from '../src/evolve/judgment.ts';
import { stageOverlay } from '../src/evolve/proposals.ts';
import { recordTrace } from '../src/evolve/write-once.ts';
import { validateCycle, type ValidateReport, type ValidateRequest } from '../src/evolve/validate.ts';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const BIN = join(REPO, 'bin/ai-catapult.ts');
const SKILL = 'evolution-rollout';
const CATALOG = 'a'.repeat(64);
const DISABLED = 'b'.repeat(64);
const MODEL = 'human-judge:out-of-band';
const TASK_VERSION = 1;
const RECORDED_AT = '2026-10-12T00:00:00Z';
const RECORDER = 'evolve-validate';
const SEED_RUN = 'seed-run';
const CYCLE_RUN = 'cycle-run';
const SEED_ID = 'seed-judgment';
const RUBRIC = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function makeRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'b3-validate-')));
  initEvolveLayout(root);
  return root;
}

function judgment(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    candidate_overlay_sha256: CATALOG,
    cost_usd: 1,
    judge_model: MODEL,
    judgment_id: SEED_ID,
    per_criterion_scores: [{ criterion: 'correctness', score: 1 }],
    recorded_at: RECORDED_AT,
    recorder: RECORDER,
    rubric_sha256: RUBRIC,
    run_id: SEED_RUN,
    skill_under_test: SKILL,
    task_set_id: 'ts-val',
    task_set_version: TASK_VERSION,
    verdict: 'Accepted',
    weighted_aggregate: 0.5,
    ...fields,
  };
}

function recordCatalog(
  root: string,
  sha: string,
  judgmentId = SEED_ID,
  baseline = 'current-catalog',
): void {
  recordTrace(evolvePaths(root), SEED_RUN, 'catalog-state.json', `${JSON.stringify({
    baseline,
    catalog_sha256: sha,
    judgment_id: judgmentId,
  })}\n`);
}

function recordSeed(root: string, score: number, overlaySha: string, cost = 1): void {
  recordJudgment(evolvePaths(root), judgment({
    candidate_overlay_sha256: overlaySha,
    cost_usd: cost,
    judgment_id: SEED_ID,
    run_id: SEED_RUN,
    weighted_aggregate: score,
  }));
}

function recordSample(
  root: string,
  id: string,
  score: number,
  overlaySha: string,
  cost: number,
  runId = CYCLE_RUN,
): void {
  recordJudgment(evolvePaths(root), judgment({
    candidate_overlay_sha256: overlaySha,
    cost_usd: cost,
    judgment_id: id,
    run_id: runId,
    weighted_aggregate: score,
  }));
}

function stage(root: string, label: string): string {
  const bytes = `overlay:${label}\n`;
  stageOverlay(evolvePaths(root), SKILL, bytes);
  return sha256(bytes);
}

interface Built {
  readonly overlaySha: string;
  readonly root: string;
}

function built(seedScore: number, samples: readonly number[], costs: readonly number[]): Built {
  const root = makeRoot();
  const overlaySha = stage(root, 'candidate');
  recordSeed(root, seedScore, CATALOG);
  recordCatalog(root, CATALOG);
  samples.forEach((score, index) => {
    recordSample(root, `sample-${index + 1}`, score, overlaySha, costs[index] ?? 1);
  });
  return { overlaySha, root };
}

function request(extra: Partial<ValidateRequest> = {}): ValidateRequest {
  return {
    action: 'accept',
    catalogSha256: CATALOG,
    cycleRunId: CYCLE_RUN,
    expectedInvocations: [],
    judgeModel: MODEL,
    recordedAt: RECORDED_AT,
    recorder: RECORDER,
    seedJudgmentId: SEED_ID,
    seedRunId: SEED_RUN,
    skill: SKILL,
    taskSetVersion: TASK_VERSION,
    ...extra,
  };
}

function overlayPresent(root: string): boolean {
  try {
    readFileSync(join(root, 'evolve/proposals', `${SKILL}.overlay`));
    return true;
  } catch {
    return false;
  }
}

function acceptedNames(root: string): string[] {
  try {
    return readdirSync(join(root, 'evolve/raw/state'))
      .filter((name) => name.startsWith(`accepted-${SKILL}-`) && name.endsWith('.json'))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function acceptedPersisted(root: string): boolean {
  return acceptedNames(root).length > 0;
}

function acceptedRecord(root: string, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, 'evolve/raw/state', name), 'utf8')) as Record<string, unknown>;
}

function skillImpact(root: string): string {
  return readFileSync(evolvePaths(root).wikiSkillImpactFile, 'utf8');
}

function mutateJudgment(root: string, runId: string, id: string, patch: Record<string, unknown>): void {
  const path = join(root, 'evolve/raw', runId, `judgment-${id}.json`);
  const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete record[key];
    else record[key] = value;
  }
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

function finish(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

void test('accept iff R(T_val) > R_best, seeded from the current catalog', () => {
  const { root } = built(0.5, [0.75, 0.75, 0.75], [10, 10, 10]);
  try {
    const report = validateCycle(root, request());
    assert.equal(report.decision, 'accept');
    assert.equal(report.code, null);
    assert.equal(report.state, 'S_0');
    assert.equal(report.rBest, 0.5);
    assert.equal(report.rVal, 0.75);
    assert.equal(report.overlayDropped, false);
    assert.equal(overlayPresent(root), true);
    assert.match(skillImpact(root), /Accepted/);
  } finally {
    finish(root);
  }
});

void test('equal score is not greater: revert and drop the overlay', () => {
  const { root } = built(0.5, [0.5, 0.5, 0.5], [1, 1, 1]);
  const logs = evolvePaths(root).wikiLogsFile;
  appendWikiFile(evolvePaths(root), 'logs.md', 'prior-learning\n');
  const logsBefore = readFileSync(logs, 'utf8');
  const impactBefore = skillImpact(root);
  try {
    const report = validateCycle(root, request());
    assert.equal(report.decision, 'reject');
    assert.equal(report.overlayDropped, true);
    assert.equal(overlayPresent(root), false);
    assert.equal(report.state, 'S_0');
    assert.equal(report.rBest, 0.5);
    assert.ok(readFileSync(logs, 'utf8').startsWith(logsBefore));
    assert.ok(skillImpact(root).startsWith(impactBefore));
    assert.match(skillImpact(root), /Rejected/);
  } finally {
    finish(root);
  }
});

void test('early-stop iff R_best is the rubric maximum 1.0', () => {
  const { root } = built(1, [1, 1, 1], [1, 1, 1]);
  try {
    const report = validateCycle(root, request());
    assert.equal(report.decision, 'early-stop');
    assert.equal(report.rBest, 1);
    assert.equal(report.overlayDropped, true);
    assert.equal(overlayPresent(root), false);
    assert.doesNotMatch(skillImpact(root), /"verdict":"Accepted"/);
  } finally {
    finish(root);
  }
});

void test('S_k-1 is the last accepted score and a worse overlay is dropped', () => {
  const root = makeRoot();
  try {
    const firstSha = stage(root, 'first');
    recordSeed(root, 0.5, CATALOG);
    recordCatalog(root, CATALOG);
    recordSample(root, 'sample-1', 0.75, firstSha, 1);
    recordSample(root, 'sample-2', 0.75, firstSha, 1);
    recordSample(root, 'sample-3', 0.75, firstSha, 1);
    assert.equal(validateCycle(root, request()).decision, 'accept');
    const secondSha = stage(root, 'second');
    recordSample(root, 'later-1', 0.625, secondSha, 1, 'later-run');
    recordSample(root, 'later-2', 0.625, secondSha, 1, 'later-run');
    recordSample(root, 'later-3', 0.625, secondSha, 1, 'later-run');
    const report = validateCycle(root, request({ cycleRunId: 'later-run' }));
    assert.equal(report.decision, 'reject');
    assert.equal(report.state, 'S_k-1');
    assert.equal(report.rBest, 0.75);
    assert.equal(report.overlayDropped, false);
    assert.equal(readFileSync(join(root, 'evolve/proposals', `${SKILL}.overlay`), 'utf8'), 'overlay:first\n');
  } finally {
    finish(root);
  }
});

void test('mean of three samples, not the max, decides R(T_val)', () => {
  const { root } = built(0.5, [0.25, 0.25, 0.75], [1, 1, 1]);
  try {
    const report = validateCycle(root, request());
    assert.equal(report.decision, 'reject');
    assert.ok(report.rVal !== null && report.rVal < 0.5);
  } finally {
    finish(root);
  }
});

void test('a skill-disabled seed is refused and is not used as R_best', () => {
  const root = makeRoot();
  try {
    const overlaySha = stage(root, 'candidate');
    recordSeed(root, 0.1, DISABLED);
    recordJudgment(evolvePaths(root), judgment({
      candidate_overlay_sha256: CATALOG,
      judgment_id: 'catalog-seed',
      weighted_aggregate: 0.8,
    }));
    recordCatalog(root, CATALOG, 'catalog-seed');
    recordSample(root, 'sample-1', 0.5, overlaySha, 1);
    const refused = validateCycle(root, request());
    assert.equal(refused.code, 'seed_not_catalog');
    assert.equal(refused.decision, 'refused');
    assert.notEqual(refused.decision, 'accept');
    const honored = validateCycle(root, request({ seedJudgmentId: 'catalog-seed' }));
    assert.equal(honored.rBest, 0.8);
    assert.equal(honored.decision, 'reject');
  } finally {
    finish(root);
  }
});

void test('mutation: overlay hash not bound to the candidate is judgment_unbound', () => {
  const { root } = built(0.5, [0.75], [1]);
  try {
    mutateJudgment(root, CYCLE_RUN, 'sample-1', { candidate_overlay_sha256: DISABLED });
    const report = validateCycle(root, request());
    assert.equal(report.code, 'judgment_unbound');
    assert.equal(report.decision, 'refused');
    assert.equal(overlayPresent(root), false);
  } finally {
    finish(root);
  }
});

void test('mutation: task-set version drift is judgment_unbound', () => {
  const { root } = built(0.5, [0.75], [1]);
  try {
    mutateJudgment(root, CYCLE_RUN, 'sample-1', { task_set_version: 2 });
    assert.equal(validateCycle(root, request()).code, 'judgment_unbound');
  } finally {
    finish(root);
  }
});

void test('mutation: a different judge model is judgment_unbound', () => {
  const { root } = built(0.5, [0.75], [1]);
  try {
    mutateJudgment(root, CYCLE_RUN, 'sample-1', { judge_model: 'other-model' });
    assert.equal(validateCycle(root, request()).code, 'judgment_unbound');
  } finally {
    finish(root);
  }
});

void test('an unrecorded invocation is an attribution gap and judgment_unbound', () => {
  const { root } = built(0.5, [0.75], [1]);
  try {
    const report = validateCycle(root, request({ expectedInvocations: ['sample-1', 'never-recorded'] }));
    assert.equal(report.code, 'judgment_unbound');
    assert.deepEqual(report.attributionGaps, ['never-recorded']);
    assert.match(skillImpact(root), /attribution_gap: never-recorded/);
  } finally {
    finish(root);
  }
});

void test('mutation: cost past $100 refuses accept with cycle_budget_exhausted', () => {
  const { root } = built(0.5, [0.75, 0.75, 0.75], [10, 10, 10]);
  try {
    mutateJudgment(root, CYCLE_RUN, 'sample-1', { cost_usd: 81 });
    const report = validateCycle(root, request());
    assert.equal(report.code, 'cycle_budget_exhausted');
    assert.equal(report.decision, 'refused');
    assert.equal(report.overlayDropped, true);
    assert.ok(report.costUsd > 100);
  } finally {
    finish(root);
  }
});

void test('spend of exactly $100 is not past the ceiling', () => {
  const { root } = built(0.5, [0.75, 0.75, 0.75], [40, 30, 30]);
  try {
    const report = validateCycle(root, request());
    assert.equal(report.code, null);
    assert.equal(report.decision, 'accept');
    assert.equal(report.costUsd, 100);
  } finally {
    finish(root);
  }
});

void test('dispatch refuses past $100 and does not drop the overlay', () => {
  const { root } = built(0.5, [0.75], [100.01]);
  try {
    const report = validateCycle(root, request({ action: 'dispatch' }));
    assert.equal(report.code, 'cycle_budget_exhausted');
    assert.equal(report.overlayDropped, false);
    assert.equal(overlayPresent(root), true);
  } finally {
    finish(root);
  }
});

void test('seed cost is not counted toward the cycle ceiling', () => {
  const { root } = built(0.5, [0.75], [10]);
  try {
    mutateJudgment(root, SEED_RUN, SEED_ID, { cost_usd: 95 });
    const report = validateCycle(root, request());
    assert.equal(report.code, null);
    assert.equal(report.costUsd, 10);
  } finally {
    finish(root);
  }
});

void test('reject restores the last accepted overlay bytes', () => {
  const root = makeRoot();
  try {
    const firstSha = stage(root, 'kept');
    recordSeed(root, 0.5, CATALOG);
    recordCatalog(root, CATALOG);
    recordSample(root, 'sample-1', 0.75, firstSha, 1);
    assert.equal(validateCycle(root, request()).decision, 'accept');
    const secondSha = stage(root, 'dropped');
    recordSample(root, 'later-1', 0.25, secondSha, 1, 'later-run');
    const report = validateCycle(root, request({ cycleRunId: 'later-run' }));
    assert.equal(report.decision, 'reject');
    assert.equal(readFileSync(join(root, 'evolve/proposals', `${SKILL}.overlay`), 'utf8'), 'overlay:kept\n');
  } finally {
    finish(root);
  }
});

void test('mutation: a missing judge_model is judgment_unbound and its cost is not omitted', () => {
  const { root } = built(0.5, [0.75], [1]);
  try {
    recordSample(root, 'hidden-spend', 0.75, sha256('overlay:candidate\n'), 200);
    mutateJudgment(root, CYCLE_RUN, 'hidden-spend', { judge_model: undefined });
    const report = validateCycle(root, request());
    assert.equal(report.code, 'judgment_unbound');
    assert.notEqual(report.decision, 'accept');
    assert.ok(report.costUsd >= 200);
  } finally {
    finish(root);
  }
});

void test('mutation: fractional cents past $100 refuse accept and dispatch', () => {
  const accepted = built(0.5, [0.75], [100.004]);
  const dispatched = built(0.5, [0.75], [100.004]);
  try {
    assert.equal(validateCycle(accepted.root, request()).code, 'cycle_budget_exhausted');
    const dispatch = validateCycle(dispatched.root, request({ action: 'dispatch' }));
    assert.equal(dispatch.code, 'cycle_budget_exhausted');
    assert.ok(dispatch.costUsd > 100);
  } finally {
    finish(accepted.root);
    finish(dispatched.root);
  }
});

void test('strict improvement is not rounded away, and a worse score is not rounded into a win', () => {
  const better = built(0.5, [0.5000001], [1]);
  const worse = makeRoot();
  try {
    assert.equal(validateCycle(better.root, request()).decision, 'accept');
    const overlaySha = stage(worse, 'candidate');
    recordSeed(worse, 0.5000006, CATALOG);
    recordCatalog(worse, CATALOG);
    recordSample(worse, 'sample-1', 0.50000059, overlaySha, 1);
    assert.equal(validateCycle(worse, request()).decision, 'reject');
  } finally {
    finish(better.root);
    finish(worse);
  }
});

void test('a cycle judgment that reuses the seed id in another run still counts toward spend', () => {
  const { root, overlaySha } = built(0.5, [0.75], [1]);
  try {
    recordSample(root, SEED_ID, 0.75, overlaySha, 200);
    const report = validateCycle(root, request());
    assert.equal(report.code, 'cycle_budget_exhausted');
    assert.notEqual(report.decision, 'accept');
  } finally {
    finish(root);
  }
});

void test('a negative cost cannot offset recorded spend', () => {
  const { root, overlaySha } = built(0.5, [0.75], [200]);
  try {
    recordSample(root, 'credit', 0.75, overlaySha, 1);
    mutateJudgment(root, CYCLE_RUN, 'credit', { cost_usd: -200 });
    const report = validateCycle(root, request());
    assert.equal(report.code, 'judgment_unbound');
    assert.notEqual(report.decision, 'accept');
    assert.ok(report.costUsd >= 200);
  } finally {
    finish(root);
  }
});

void test('a skill-disabled catalog-state is refused even when the caller passes its hash', () => {
  const root = makeRoot();
  try {
    const overlaySha = stage(root, 'candidate');
    recordSeed(root, 0.1, DISABLED);
    recordCatalog(root, DISABLED, SEED_ID, 'skill-disabled');
    recordSample(root, 'sample-1', 0.5, overlaySha, 1);
    const report = validateCycle(root, request({ catalogSha256: DISABLED }));
    assert.equal(report.code, 'seed_not_catalog');
    assert.notEqual(report.decision, 'accept');
  } finally {
    finish(root);
  }
});

void test('a score of 2 does not persist accepted state, and a later valid accept can', () => {
  const { root } = built(0.5, [0.75], [1]);
  try {
    mutateJudgment(root, CYCLE_RUN, 'sample-1', { weighted_aggregate: 2 });
    const failed = validateCycle(root, request());
    assert.equal(failed.code, 'judgment_unbound');
    assert.notEqual(failed.decision, 'accept');
    assert.equal(failed.overlayDropped, true);
    assert.equal(acceptedPersisted(root), false);
    assert.equal(overlayPresent(root), false);
    stage(root, 'candidate');
    mutateJudgment(root, CYCLE_RUN, 'sample-1', { weighted_aggregate: 0.8 });
    assert.equal(validateCycle(root, request()).decision, 'accept');
  } finally {
    finish(root);
  }
});

void test('scores of 2 and -0.5 are refused instead of averaged into an accept', () => {
  const { root } = built(0.5, [0.75, 0.75], [1, 1]);
  try {
    mutateJudgment(root, CYCLE_RUN, 'sample-1', { weighted_aggregate: 2 });
    mutateJudgment(root, CYCLE_RUN, 'sample-2', { weighted_aggregate: -0.5 });
    const report = validateCycle(root, request());
    assert.equal(report.code, 'judgment_unbound');
    assert.notEqual(report.decision, 'accept');
    assert.notEqual(report.rVal, 0.75);
    assert.equal(acceptedPersisted(root), false);
  } finally {
    finish(root);
  }
});

void test('rubric endpoints 0 and 1 stay inside the range', () => {
  const low = built(0.5, [0], [1]);
  const high = built(0.5, [1], [1]);
  try {
    const lowReport = validateCycle(low.root, request());
    assert.equal(lowReport.decision, 'reject');
    assert.equal(lowReport.code, null);
    assert.equal(validateCycle(high.root, request()).decision, 'accept');
  } finally {
    finish(low.root);
    finish(high.root);
  }
});

void test('mutation: seed judge_model drift is refused', () => {
  const { root } = built(0.5, [0.75], [1]);
  try {
    mutateJudgment(root, SEED_RUN, SEED_ID, { judge_model: 'other-model' });
    const report = validateCycle(root, request());
    assert.equal(report.code, 'judgment_unbound');
    assert.notEqual(report.decision, 'accept');
    assert.equal(acceptedPersisted(root), false);
  } finally {
    finish(root);
  }
});

void test('mutation: seed task_set_version drift is refused', () => {
  const { root } = built(0.5, [0.75], [1]);
  try {
    mutateJudgment(root, SEED_RUN, SEED_ID, { task_set_version: 2 });
    const report = validateCycle(root, request());
    assert.equal(report.code, 'judgment_unbound');
    assert.notEqual(report.decision, 'accept');
    assert.equal(acceptedPersisted(root), false);
  } finally {
    finish(root);
  }
});

void test('a failed accept validates the audit entry before any accepted-state write', () => {
  const { root } = built(0.5, [0.75], [1]);
  try {
    assert.throws(() => validateCycle(root, request({ recordedAt: 'not-a-date' })));
    assert.equal(acceptedPersisted(root), false);
    assert.equal(overlayPresent(root), true);
    assert.equal(validateCycle(root, request()).decision, 'accept');
  } finally {
    finish(root);
  }
});

void test('a failed audit append does not leave accepted state behind', () => {
  const directory = built(0.5, [0.75], [1]);
  const missing = built(0.5, [0.75], [1]);
  try {
    const asDirectory = evolvePaths(directory.root).wikiSkillImpactFile;
    const before = readFileSync(asDirectory, 'utf8');
    rmSync(asDirectory);
    mkdirSync(asDirectory);
    assert.throws(() => validateCycle(directory.root, request()));
    assert.equal(acceptedPersisted(directory.root), false);
    rmSync(asDirectory, { recursive: true, force: true });
    writeFileSync(asDirectory, before);
    assert.equal(validateCycle(directory.root, request()).decision, 'accept');

    const gone = evolvePaths(missing.root).wikiSkillImpactFile;
    rmSync(gone);
    assert.throws(() => validateCycle(missing.root, request()));
    assert.equal(acceptedPersisted(missing.root), false);
    writeFileSync(gone, '');
    assert.equal(validateCycle(missing.root, request()).decision, 'accept');
  } finally {
    finish(directory.root);
    finish(missing.root);
  }
});

void test('accepted state persists judge_model and task_set_version', () => {
  const { root } = built(0.5, [0.75], [1]);
  try {
    assert.equal(validateCycle(root, request()).decision, 'accept');
    const saved = acceptedNames(root).map((name) => acceptedRecord(root, name));
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.judge_model, MODEL);
    assert.equal(saved[0]?.task_set_version, TASK_VERSION);
    assert.equal(saved[0]?.r_best, 0.75);
  } finally {
    finish(root);
  }
});

void test('a changed binding does not accept against the stale accepted score', () => {
  const root = makeRoot();
  try {
    const firstSha = stage(root, 'first');
    recordSeed(root, 0.5, CATALOG);
    recordCatalog(root, CATALOG);
    recordSample(root, 'sample-1', 0.75, firstSha, 1);
    assert.equal(validateCycle(root, request()).decision, 'accept');
    mutateJudgment(root, SEED_RUN, SEED_ID, {
      judge_model: 'other-model',
      task_set_version: 2,
      weighted_aggregate: 1,
    });
    const secondSha = stage(root, 'second');
    recordSample(root, 'later-1', 0.9, secondSha, 1, 'later-run');
    mutateJudgment(root, 'later-run', 'later-1', { judge_model: 'other-model', task_set_version: 2 });
    const report = validateCycle(root, request({
      cycleRunId: 'later-run',
      judgeModel: 'other-model',
      taskSetVersion: 2,
    }));
    assert.notEqual(report.decision, 'accept');
    assert.equal(report.rBest, 1);
    assert.equal(report.decision, 'early-stop');
    const stale = acceptedNames(root).map((name) => acceptedRecord(root, name));
    assert.equal(stale.length, 1);
    assert.equal(stale[0]?.r_best, 0.75);
    assert.equal(stale[0]?.judge_model, MODEL);
    assert.equal(stale[0]?.task_set_version, TASK_VERSION);
  } finally {
    finish(root);
  }
});

void test('a judge_model change accepts against its own seed, not the stale score', () => {
  const root = makeRoot();
  try {
    const firstSha = stage(root, 'first');
    recordSeed(root, 0.5, CATALOG);
    recordCatalog(root, CATALOG);
    recordSample(root, 'sample-1', 0.75, firstSha, 1);
    assert.equal(validateCycle(root, request()).decision, 'accept');
    mutateJudgment(root, SEED_RUN, SEED_ID, { judge_model: 'other-model', weighted_aggregate: 0.4 });
    const secondSha = stage(root, 'second');
    recordSample(root, 'later-1', 0.6, secondSha, 1, 'later-run');
    mutateJudgment(root, 'later-run', 'later-1', { judge_model: 'other-model' });
    const accepted = validateCycle(root, request({ cycleRunId: 'later-run', judgeModel: 'other-model' }));
    assert.equal(accepted.decision, 'accept');
    assert.equal(accepted.rBest, 0.4);
    assert.equal(accepted.state, 'S_0');
    const records = acceptedNames(root).map((name) => acceptedRecord(root, name));
    const stale = records.find((record) => record.judge_model === MODEL);
    const fresh = records.find((record) => record.judge_model === 'other-model');
    assert.equal(stale?.r_best, 0.75);
    assert.equal(fresh?.r_best, 0.6);
    assert.equal(fresh?.task_set_version, TASK_VERSION);
    const worseSha = stage(root, 'worse-new');
    recordSample(root, 'drop-1', 0.5, worseSha, 1, 'drop-run');
    mutateJudgment(root, 'drop-run', 'drop-1', { judge_model: 'other-model' });
    const dropped = validateCycle(root, request({ cycleRunId: 'drop-run', judgeModel: 'other-model' }));
    assert.equal(dropped.decision, 'reject');
    assert.equal(dropped.state, 'S_k-1');
    assert.equal(dropped.rBest, 0.6);
    assert.equal(readFileSync(join(root, 'evolve/proposals', `${SKILL}.overlay`), 'utf8'), 'overlay:second\n');
    mutateJudgment(root, SEED_RUN, SEED_ID, { judge_model: MODEL, weighted_aggregate: 0.5 });
    const thirdSha = stage(root, 'third');
    recordSample(root, 'old-1', 0.2, thirdSha, 1, 'old-run');
    const restored = validateCycle(root, request({ cycleRunId: 'old-run' }));
    assert.equal(restored.state, 'S_k-1');
    assert.equal(restored.rBest, 0.75);
    assert.equal(restored.decision, 'reject');
    assert.equal(readFileSync(join(root, 'evolve/proposals', `${SKILL}.overlay`), 'utf8'), 'overlay:first\n');
  } finally {
    finish(root);
  }
});

void test('a task_set_version change does not keep the stale accepted score', () => {
  const root = makeRoot();
  try {
    const firstSha = stage(root, 'first');
    recordSeed(root, 0.5, CATALOG);
    recordCatalog(root, CATALOG);
    recordSample(root, 'sample-1', 0.75, firstSha, 1);
    assert.equal(validateCycle(root, request()).decision, 'accept');
    mutateJudgment(root, SEED_RUN, SEED_ID, { task_set_version: 2, weighted_aggregate: 0.4 });
    const secondSha = stage(root, 'second');
    recordSample(root, 'later-1', 0.55, secondSha, 1, 'later-run');
    mutateJudgment(root, 'later-run', 'later-1', { task_set_version: 2 });
    const report = validateCycle(root, request({ cycleRunId: 'later-run', taskSetVersion: 2 }));
    assert.equal(report.decision, 'accept');
    assert.equal(report.rBest, 0.4);
    assert.notEqual(report.rBest, 0.75);
    const fresh = acceptedNames(root).map((name) => acceptedRecord(root, name))
      .find((record) => record.task_set_version === 2);
    assert.equal(fresh?.judge_model, MODEL);
    assert.equal(fresh?.r_best, 0.55);
  } finally {
    finish(root);
  }
});

void test('an out-of-range score restores the last accepted overlay', () => {
  const root = makeRoot();
  try {
    const firstSha = stage(root, 'kept');
    recordSeed(root, 0.5, CATALOG);
    recordCatalog(root, CATALOG);
    recordSample(root, 'sample-1', 0.75, firstSha, 1);
    assert.equal(validateCycle(root, request()).decision, 'accept');
    const before = acceptedNames(root).map((name) => acceptedRecord(root, name));
    const secondSha = stage(root, 'candidate');
    recordSample(root, 'later-1', 0.9, secondSha, 1, 'later-run');
    mutateJudgment(root, 'later-run', 'later-1', { weighted_aggregate: 2 });
    const report = validateCycle(root, request({ cycleRunId: 'later-run' }));
    assert.equal(report.code, 'judgment_unbound');
    assert.notEqual(report.decision, 'accept');
    assert.equal(readFileSync(join(root, 'evolve/proposals', `${SKILL}.overlay`), 'utf8'), 'overlay:kept\n');
    assert.deepEqual(acceptedNames(root).map((name) => acceptedRecord(root, name)), before);
    assert.equal(before[0]?.r_best, 0.75);
  } finally {
    finish(root);
  }
});

void test('dispatch of an out-of-range score refuses without dropping the overlay', () => {
  const { root } = built(0.5, [0.75], [1]);
  try {
    mutateJudgment(root, CYCLE_RUN, 'sample-1', { weighted_aggregate: 2 });
    const report = validateCycle(root, request({ action: 'dispatch' }));
    assert.equal(report.code, 'judgment_unbound');
    assert.equal(report.overlayDropped, false);
    assert.equal(overlayPresent(root), true);
    assert.equal(acceptedPersisted(root), false);
  } finally {
    finish(root);
  }
});

void test('the same records produce the same report twice', () => {
  const left = built(0.5, [0.75, 0.75, 0.75], [10, 10, 10]);
  const right = built(0.5, [0.75, 0.75, 0.75], [10, 10, 10]);
  try {
    const a = validateCycle(left.root, request());
    const b = validateCycle(right.root, request());
    assert.deepEqual(a, b);
  } finally {
    finish(left.root);
    finish(right.root);
  }
});

void test('validate source cites no paper threshold and calls no judge', () => {
  const source = readFileSync(join(REPO, 'src/evolve/validate.ts'), 'utf8');
  const cli = readFileSync(join(REPO, 'src/evolve/cli.ts'), 'utf8');
  assert.equal(source.includes('arXiv'), false);
  assert.equal(source.includes('Date.now'), false);
  assert.equal(cli.includes('Date.now'), false);
  assert.equal(/openai|anthropic|fetch\(/.test(source), false);
});

function runCli(root: string, extra: readonly string[]): { code: number; json: ValidateReport | null; stderr: string } {
  const result = spawnSync(process.execPath, [BIN, 'evolve', '--validate', '--root', root, ...extra], {
    encoding: 'utf8',
  });
  const stdout = result.stdout.trim();
  return {
    code: result.status ?? 1,
    json: stdout.startsWith('{') ? JSON.parse(stdout) as ValidateReport : null,
    stderr: result.stderr,
  };
}

const CLI_FLAGS = [
  '--skill', SKILL,
  '--cycle-run', CYCLE_RUN,
  '--seed-run', SEED_RUN,
  '--seed-judgment', SEED_ID,
  '--catalog-sha256', CATALOG,
  '--task-set-version', String(TASK_VERSION),
  '--judge-model', MODEL,
  '--recorded-at', RECORDED_AT,
  '--recorder', RECORDER,
];

void test('CLI accept exits 0 and prints the decision', () => {
  const { root } = built(0.5, [0.75], [1]);
  try {
    const ran = runCli(root, CLI_FLAGS);
    assert.equal(ran.code, 0);
    assert.equal(ran.json?.decision, 'accept');
    assert.equal(ran.stderr, '');
  } finally {
    finish(root);
  }
});

void test('CLI unbound refusal prints judgment_unbound', () => {
  const { root } = built(0.5, [0.75], [1]);
  try {
    mutateJudgment(root, CYCLE_RUN, 'sample-1', { judge_model: 'other-model' });
    const ran = runCli(root, CLI_FLAGS);
    assert.notEqual(ran.code, 0);
    assert.match(ran.stderr, /^judgment_unbound\n$/);
    assert.equal(ran.json?.code, 'judgment_unbound');
  } finally {
    finish(root);
  }
});

void test('CLI budget refusal prints cycle_budget_exhausted', () => {
  const { root } = built(0.5, [0.75], [100.01]);
  try {
    const ran = runCli(root, CLI_FLAGS);
    assert.notEqual(ran.code, 0);
    assert.match(ran.stderr, /^cycle_budget_exhausted\n$/);
  } finally {
    finish(root);
  }
});

void test('CLI dispatch past the ceiling is cycle_budget_exhausted', () => {
  const { root } = built(0.5, [0.75], [100.01]);
  try {
    const ran = runCli(root, ['--dispatch', ...CLI_FLAGS]);
    assert.notEqual(ran.code, 0);
    assert.match(ran.stderr, /^cycle_budget_exhausted\n$/);
    assert.equal(overlayPresent(root), true);
  } finally {
    finish(root);
  }
});

void test('evolve --help names --validate and no judge runtime', () => {
  const result = spawnSync(process.execPath, [BIN, 'evolve', '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--validate/);
  assert.doesNotMatch(result.stdout, /openai|anthropic|llm/i);
});
