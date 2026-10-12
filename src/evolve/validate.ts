/**
 * Recorded-judgment gate for `evolve --validate`.
 *
 * Accept iff R(T_val,k) > R_best. Early-stop iff R_best is the rubric maximum
 * (1.0). Otherwise revert to the last accepted state and drop the overlay.
 * R_best is the current catalog judgment, or the last accepted score after
 * that — never a skill-disabled baseline. The 1.0 stop and the $100 cycle
 * ceiling come from the master intake; neither number is taken from an
 * external paper. Judge calls stay out of band: this module only reads
 * records already on disk.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendAuditEntry } from './audit.ts';
import { dropFileHere, enterDirectory, entryKind, readFileHere, withBoundRoot } from './containment.ts';
import { sha256Hex } from './digest.ts';
import { EvolveError } from './errors.ts';
import { EVOLVE_DIR, evolvePaths, RUN_ID_PATTERN } from './layout.ts';
import { SKILL_NAME_PATTERN } from './proposals.ts';
import { recordTrace } from './write-once.ts';

export const CYCLE_BUDGET_USD = 100;
export const RUBRIC_MAXIMUM = 1;

export type GateCode = 'judgment_unbound' | 'cycle_budget_exhausted' | 'seed_not_catalog';
export type GateDecision = 'accept' | 'reject' | 'early-stop' | 'dispatch-allowed' | 'refused';
export type Lineage = 'S_0' | 'S_k-1';

export interface ValidateRequest {
  readonly action: 'accept' | 'dispatch';
  readonly catalogSha256: string;
  readonly cycleRunId: string;
  readonly expectedInvocations: readonly string[];
  readonly judgeModel: string;
  readonly recordedAt: string;
  readonly recorder: string;
  readonly seedJudgmentId: string;
  readonly seedRunId: string;
  readonly skill: string;
  readonly taskSetVersion: number;
}

export interface ValidateReport {
  readonly action: 'accept' | 'dispatch';
  readonly attributionGaps: readonly string[];
  readonly code: GateCode | null;
  readonly costUsd: number;
  readonly decision: GateDecision;
  readonly overlayDropped: boolean;
  readonly rBest: number | null;
  readonly rVal: number | null;
  readonly state: Lineage | null;
}

interface SeedView {
  readonly rubricSha256: string;
  readonly weightedAggregate: number;
}

interface Baseline {
  readonly nextK: number;
  readonly rBest: number;
  readonly rubricSha256: string;
  readonly state: Lineage;
}

interface Sample {
  readonly costUsd: number;
  readonly weightedAggregate: number;
}

interface ReadyCycle {
  readonly costUsd: number;
  readonly overlaySha: string;
  readonly samples: readonly Sample[];
}

type Loaded = { readonly kind: 'ready'; readonly baseline: Baseline; readonly cycle: ReadyCycle } | { readonly kind: 'report'; readonly report: ValidateReport };

export function renderReport(report: ValidateReport): string {
  return JSON.stringify({
    action: report.action,
    attributionGaps: report.attributionGaps,
    code: report.code,
    costUsd: report.costUsd,
    decision: report.decision,
    overlayDropped: report.overlayDropped,
    rBest: report.rBest,
    rVal: report.rVal,
    state: report.state,
  });
}

export function validateCycle(root: string, request: ValidateRequest): ValidateReport {
  assertRequest(request);
  const loaded = loadCycle(root, request);
  if (loaded.kind === 'report') return loaded.report;
  return applyEquation(root, request, loaded.baseline, loaded.cycle);
}

function assertRequest(request: ValidateRequest): void {
  if (!SKILL_NAME_PATTERN.test(request.skill)) {
    throw new EvolveError('unsafe-path', `skill name "${request.skill}" must match ${SKILL_NAME_PATTERN.toString()}`);
  }
  assertRunId(request.cycleRunId);
  assertRunId(request.seedRunId);
  if (!/^[0-9a-f]{64}$/.test(request.catalogSha256)) {
    throw new EvolveError('schema-violation', 'catalog sha256 must be 64 lowercase hex characters');
  }
}

function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new EvolveError('unsafe-path', `run id "${runId}" must match ${RUN_ID_PATTERN.toString()}`);
  }
}

function loadCycle(root: string, request: ValidateRequest): Loaded {
  const seed = readSeed(root, request);
  if (seed === null) return { kind: 'report', report: refuse(request, 'seed_not_catalog', false, 0, []) };
  const baseline = baselineOf(seed, readPrior(root, request));
  const judged = judgeSamples(root, request, baseline);
  if (judged.kind === 'report') return judged;
  return { kind: 'ready', baseline, cycle: judged.cycle };
}

function judgeSamples(root: string, request: ValidateRequest, baseline: Baseline): { kind: 'cycle'; cycle: ReadyCycle } | { kind: 'report'; report: ValidateReport } {
  const overlaySha = readOverlaySha(root, request.skill);
  const samples = overlaySha === null ? [] : readSamples(root, request);
  const gaps = missingInvocations(root, request);
  const binding = overlaySha === null ? 'candidate overlay missing' : unboundSample(samples, request, overlaySha);
  if (gaps.length > 0 || binding !== null) {
    return { kind: 'report', report: refuseBound(root, request, baseline, gaps, binding ?? 'unrecorded invocation') };
  }
  const costUsd = sumUsd(samples.map((sample) => sample.costUsd));
  if (costUsd > CYCLE_BUDGET_USD) {
    return { kind: 'report', report: refuseBudget(root, request, baseline, costUsd) };
  }
  return { kind: 'cycle', cycle: { costUsd, overlaySha: overlaySha ?? '', samples } };
}

function applyEquation(root: string, request: ValidateRequest, baseline: Baseline, cycle: ReadyCycle): ValidateReport {
  if (baseline.rBest === RUBRIC_MAXIMUM) return finishEarlyStop(root, request, baseline, cycle);
  if (request.action === 'dispatch') return finishDispatch(request, baseline, cycle);
  return finishScore(root, request, baseline, cycle);
}

function finishScore(root: string, request: ValidateRequest, baseline: Baseline, cycle: ReadyCycle): ValidateReport {
  const rVal = meanScore(cycle.samples.map((sample) => sample.weightedAggregate));
  if (rVal > baseline.rBest) return finishAccept(root, request, baseline, cycle, rVal);
  return finishReject(root, request, baseline, cycle, rVal);
}

function finishAccept(root: string, request: ValidateRequest, baseline: Baseline, cycle: ReadyCycle, rVal: number): ValidateReport {
  writeAccepted(root, request, baseline.nextK, cycle.overlaySha, rVal);
  writeAudit(root, request, baseline, 'Accepted', rVal, `accept: R=${String(rVal)} > R_best=${String(baseline.rBest)}`);
  return decided(request, 'accept', baseline, cycle.costUsd, rVal, false);
}

function finishReject(root: string, request: ValidateRequest, baseline: Baseline, cycle: ReadyCycle, rVal: number): ValidateReport {
  writeAudit(root, request, baseline, 'Rejected', rVal, `revert: drop overlay; R=${String(rVal)} <= R_best=${String(baseline.rBest)}`);
  dropOverlay(root, request.skill);
  return decided(request, 'reject', baseline, cycle.costUsd, rVal, true);
}

function finishEarlyStop(root: string, request: ValidateRequest, baseline: Baseline, cycle: ReadyCycle): ValidateReport {
  writeAudit(root, request, baseline, 'Rejected', baseline.rBest, 'early-stop: R_best at rubric maximum');
  dropOverlay(root, request.skill);
  return decided(request, 'early-stop', baseline, cycle.costUsd, null, true);
}

function finishDispatch(request: ValidateRequest, baseline: Baseline, cycle: ReadyCycle): ValidateReport {
  return decided(request, 'dispatch-allowed', baseline, cycle.costUsd, null, false);
}

function refuseBound(root: string, request: ValidateRequest, baseline: Baseline, gaps: readonly string[], reason: string): ValidateReport {
  writeAudit(root, request, baseline, 'Rejected', 0, unboundDiff(reason, gaps));
  const dropped = request.action === 'accept' && dropOverlay(root, request.skill);
  return refuse(request, 'judgment_unbound', dropped, 0, gaps, baseline);
}

function refuseBudget(root: string, request: ValidateRequest, baseline: Baseline, costUsd: number): ValidateReport {
  writeAudit(root, request, baseline, 'Rejected', 0, `cycle_budget_exhausted: recorded cost_usd ${String(costUsd)}`);
  const dropped = request.action === 'accept' && dropOverlay(root, request.skill);
  return refuse(request, 'cycle_budget_exhausted', dropped, costUsd, [], baseline);
}

function decided(
  request: ValidateRequest,
  decision: GateDecision,
  baseline: Baseline,
  costUsd: number,
  rVal: number | null,
  overlayDropped: boolean,
): ValidateReport {
  return {
    action: request.action,
    attributionGaps: [],
    code: null,
    costUsd,
    decision,
    overlayDropped,
    rBest: baseline.rBest,
    rVal,
    state: baseline.state,
  };
}

function refuse(
  request: ValidateRequest,
  code: GateCode,
  overlayDropped: boolean,
  costUsd: number,
  gaps: readonly string[],
  baseline?: Baseline,
): ValidateReport {
  return {
    action: request.action,
    attributionGaps: gaps,
    code,
    costUsd,
    decision: 'refused',
    overlayDropped,
    rBest: baseline?.rBest ?? null,
    rVal: null,
    state: baseline?.state ?? null,
  };
}

function unboundDiff(reason: string, gaps: readonly string[]): string {
  const lines = [`judgment_unbound: ${reason}`];
  for (const gap of gaps) lines.push(`attribution_gap: ${gap}`);
  return lines.join('\n');
}

function readSeed(root: string, request: ValidateRequest): SeedView | null {
  const record = readJudgment(root, request.seedRunId, request.seedJudgmentId);
  if (record === null) return null;
  if (record.overlaySha !== request.catalogSha256) return null;
  if (!inUnitInterval(record.weightedAggregate)) return null;
  return { rubricSha256: record.rubricSha256, weightedAggregate: record.weightedAggregate };
}

function baselineOf(seed: SeedView, prior: PriorState | null): Baseline {
  if (prior === null) {
    return { nextK: 1, rBest: seed.weightedAggregate, rubricSha256: seed.rubricSha256, state: 'S_0' };
  }
  return { nextK: prior.k + 1, rBest: prior.rBest, rubricSha256: seed.rubricSha256, state: 'S_k-1' };
}

interface PriorState {
  readonly k: number;
  readonly rBest: number;
}

function readPrior(root: string, request: ValidateRequest): PriorState | null {
  const dir = join(root, EVOLVE_DIR, 'raw', 'state');
  if (!isRealDirectory(dir)) return null;
  let best: PriorState | null = null;
  for (const name of readdirSync(dir).sort((left, right) => left.localeCompare(right))) {
    const parsed = priorFromFile(dir, name, request);
    if (parsed !== null && (best === null || parsed.k > best.k)) best = parsed;
  }
  return best;
}

function priorFromFile(dir: string, name: string, request: ValidateRequest): PriorState | null {
  const k = kFromName(request.skill, name);
  if (k === null) return null;
  const text = readRegular(join(dir, name));
  if (text === null) return null;
  return parsePrior(text, request.catalogSha256, k);
}

function kFromName(skill: string, name: string): number | null {
  const prefix = `accepted-${skill}-`;
  if (!name.startsWith(prefix) || !name.endsWith('.json')) return null;
  const digits = name.slice(prefix.length, -'.json'.length);
  if (!/^[1-9][0-9]*$/.test(digits)) return null;
  return Number(digits);
}

function parsePrior(text: string, catalogSha256: string, k: number): PriorState | null {
  const fields = parseObject(text);
  if (fields === null) return null;
  if (fields['catalog_sha256'] !== catalogSha256) return null;
  if (fields['k'] !== k) return null;
  const score = fields['r_best'];
  if (!inUnitInterval(score)) return null;
  return { k, rBest: score };
}

interface RawSample extends Sample {
  readonly judgeModel: string;
  readonly overlaySha: string;
  readonly rubricSha256: string;
  readonly taskSetVersion: number;
}

function readSamples(root: string, request: ValidateRequest): RawSample[] {
  const dir = join(root, EVOLVE_DIR, 'raw', request.cycleRunId);
  if (!isRealDirectory(dir)) return [];
  const samples: RawSample[] = [];
  for (const name of readdirSync(dir).sort((left, right) => left.localeCompare(right))) {
    const sample = sampleFromFile(dir, name, request.seedJudgmentId);
    if (sample !== null) samples.push(sample);
  }
  return samples;
}

function sampleFromFile(dir: string, name: string, seedId: string): RawSample | null {
  const id = judgmentIdFromName(name);
  if (id === null || id === seedId) return null;
  const text = readRegular(join(dir, name));
  if (text === null) return null;
  return asSample(parseObject(text));
}

function unboundSample(samples: readonly RawSample[], request: ValidateRequest, overlaySha: string): string | null {
  if (samples.length === 0) return 'no recorded candidate judgment';
  for (const sample of samples) {
    if (sample.overlaySha !== overlaySha) return 'candidate_overlay_sha256';
    if (sample.taskSetVersion !== request.taskSetVersion) return 'task_set_version';
    if (sample.judgeModel !== request.judgeModel) return 'judge_model';
  }
  return null;
}

function missingInvocations(root: string, request: ValidateRequest): string[] {
  const gaps: string[] = [];
  for (const id of request.expectedInvocations) {
    if (readJudgment(root, request.cycleRunId, id) === null) gaps.push(id);
  }
  return gaps.sort((left, right) => left.localeCompare(right));
}

function readJudgment(root: string, runId: string, id: string): RawSample | null {
  const text = readRegular(join(root, EVOLVE_DIR, 'raw', runId, `judgment-${id}.json`));
  if (text === null) return null;
  return asSample(parseObject(text));
}

function asSample(fields: Record<string, unknown> | null): RawSample | null {
  if (fields === null) return null;
  const costUsd = fields['cost_usd'];
  const weightedAggregate = fields['weighted_aggregate'];
  const overlaySha = fields['candidate_overlay_sha256'];
  const judgeModel = fields['judge_model'];
  const taskSetVersion = fields['task_set_version'];
  const rubricSha256 = fields['rubric_sha256'];
  if (typeof costUsd !== 'number' || typeof weightedAggregate !== 'number') return null;
  if (typeof overlaySha !== 'string' || typeof judgeModel !== 'string') return null;
  if (typeof taskSetVersion !== 'number' || typeof rubricSha256 !== 'string') return null;
  return { costUsd, judgeModel, overlaySha, rubricSha256, taskSetVersion, weightedAggregate };
}

function readOverlaySha(root: string, skill: string): string | null {
  return withBoundRoot(root, (anchor) => {
    const evolve = enterDirectory(EVOLVE_DIR, anchor);
    enterDirectory('proposals', evolve);
    const name = `${skill}.overlay`;
    if (entryKind(name) !== 'file') return null;
    return sha256Hex(readFileHere(name));
  });
}

function dropOverlay(root: string, skill: string): boolean {
  return withBoundRoot(root, (anchor) => {
    const evolve = enterDirectory(EVOLVE_DIR, anchor);
    enterDirectory('proposals', evolve);
    const name = `${skill}.overlay`;
    if (entryKind(name) !== 'file') return false;
    dropFileHere(name);
    return true;
  });
}

function writeAccepted(root: string, request: ValidateRequest, k: number, overlaySha: string, rBest: number): void {
  const body = `${JSON.stringify({
    catalog_sha256: request.catalogSha256,
    k,
    overlay_sha256: overlaySha,
    r_best: rBest,
    skill: request.skill,
  })}\n`;
  recordTrace(evolvePaths(root), 'state', `accepted-${request.skill}-${String(k)}.json`, body);
}

function writeAudit(
  root: string,
  request: ValidateRequest,
  baseline: Baseline,
  verdict: 'Accepted' | 'Rejected',
  score: number,
  diff: string,
): void {
  appendAuditEntry(evolvePaths(root), {
    metadata: {
      cycle: baseline.nextK,
      recorded_at: request.recordedAt,
      recorder: request.recorder,
      run_id: request.cycleRunId,
    },
    score: { rubric_sha256: baseline.rubricSha256, weighted_aggregate: score },
    target_skill: request.skill,
    unified_diff: diff,
    verdict,
  });
}

function sumUsd(values: readonly number[]): number {
  const cents = values.reduce((total, value) => total + Math.round(value * 100), 0);
  return cents / 100;
}

function meanScore(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const scaled = values.reduce((total, value) => total + Math.round(value * 1_000_000), 0);
  return Math.round(scaled / values.length) / 1_000_000;
}

function inUnitInterval(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 1;
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function judgmentIdFromName(name: string): string | null {
  if (!name.startsWith('judgment-') || !name.endsWith('.json')) return null;
  const id = name.slice('judgment-'.length, -'.json'.length);
  return id.length > 0 ? id : null;
}

function readRegular(path: string): string | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function isRealDirectory(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}
