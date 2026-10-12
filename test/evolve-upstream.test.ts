/**
 * TDD tests for tswc-ac-b4 — accepted overlay to a stub skills SSOT.
 *
 * Accept: one skill PR, then a runtime lock SHA bump, then revendor, then
 * per-host payload rebuilds through resolveBundledSkills. Reject: drop the
 * overlay, keep the wiki, write nothing upstream. A mutated lock SHA is
 * refused before any payload rewrite. The stub is a local git repo. This
 * file never pushes and never opens a PR on github.com/r3dlex/skills.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendWikiFile } from '../src/evolve/append-only.ts';
import { evolvePaths, initEvolveLayout } from '../src/evolve/layout.ts';
import { recordJudgment } from '../src/evolve/judgment.ts';
import { stageOverlay } from '../src/evolve/proposals.ts';
import { recordTrace } from '../src/evolve/write-once.ts';
import { validateCycle, type ValidateRequest } from '../src/evolve/validate.ts';
import { flowUpstream, rebuildPayloads, verifyHandoff, type UpstreamFlowReport } from '../src/evolve/upstream.ts';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const BIN = join(REPO, 'bin/ai-catapult.ts');
const PACKAGE_LOCK = readFileSync(join(REPO, 'skills.lock.json'), 'utf8');
const SKILL = 'evolution-rollout';
const CATALOG = 'c'.repeat(64);
const MODEL = 'human-judge:out-of-band';
const TASK_VERSION = 1;
const RECORDED_AT = '2026-10-12T00:00:00Z';
const RECORDER = 'evolve-upstream';
const OVERLAY = '---\nname: evolution-rollout\n---\n# evolved rollout\n';
const REAL_SKILLS = 'https://github.com/r3dlex/skills.git';

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'evolve-stub',
      GIT_AUTHOR_EMAIL: 'stub@example.invalid',
      GIT_COMMITTER_NAME: 'evolve-stub',
      GIT_COMMITTER_EMAIL: 'stub@example.invalid',
    },
  });
  assert.equal(result.status, 0, `${args.join(' ')} failed: ${result.stderr}`);
  return (result.stdout ?? '').trim();
}

function writeInitSkill(root: string): void {
  const skill = join(root, '03-configure-generate/ai-catapult-init');
  const templates = join(skill, 'templates');
  mkdirSync(join(templates, 'graph-automation'), { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: ai-catapult-init\n---\n# init\n');
  writeFileSync(join(templates, 'boundary-manifest.json'), '{"paths":[]}\n');
  for (const name of ['config.json', 'graph-refresh.sh', 'harness-hooks.json', 'hook-body.sh']) {
    writeFileSync(join(templates, 'graph-automation', name), '{}\n');
  }
}

function writeNamedSkill(root: string, name: string, body: string): void {
  const dir = join(root, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body);
}

function catalogEntry(name: string, hosts?: readonly string[]): Record<string, unknown> {
  const entry: Record<string, unknown> = { name, source_path: `skills/${name}` };
  if (hosts !== undefined) entry.supported_hosts = [...hosts];
  return entry;
}

function writeCatalog(root: string): void {
  const skills = [
    { name: 'ai-catapult-init', source_path: '03-configure-generate/ai-catapult-init' },
    catalogEntry(SKILL),
    catalogEntry('claude-only', ['claude-code']),
    catalogEntry('omc-host-only', ['omc']),
  ];
  writeFileSync(join(root, 'catalog.json'), `${JSON.stringify({ skills }, null, 2)}\n`);
}

function initStub(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'b4-upstream-')));
  git(root, ['init', '-q', '-b', 'main']);
  writeInitSkill(root);
  writeNamedSkill(root, SKILL, '---\nname: evolution-rollout\n---\n# baseline\n');
  writeNamedSkill(root, 'claude-only', '---\nname: claude-only\n---\n# claude\n');
  writeNamedSkill(root, 'omc-host-only', '---\nname: omc-host-only\n---\n# omc\n');
  writeCatalog(root);
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'catalog']);
  return root;
}

function commitCount(root: string): string {
  return git(root, ['rev-list', '--count', 'HEAD']);
}

function writeLock(file: string, repo: string, sha: string): void {
  writeFileSync(file, `${JSON.stringify({ repo, ref: 'main', sha }, null, 2)}\n`);
}

function readSha(file: string): string {
  return (JSON.parse(readFileSync(file, 'utf8')) as { sha: string }).sha;
}

function acceptWorkspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'b4-evolve-')));
  initEvolveLayout(root);
  stageOverlay(evolvePaths(root), SKILL, OVERLAY);
  const digest = createHash('sha256').update(OVERLAY).digest('hex');
  recordTrace(evolvePaths(root), 'seed-run', 'catalog-state.json', `${JSON.stringify({
    baseline: 'current-catalog',
    catalog_sha256: CATALOG,
    judgment_id: 'seed-judgment',
  })}\n`);
  recordJudgment(evolvePaths(root), {
    candidate_overlay_sha256: CATALOG,
    cost_usd: 1,
    judge_model: MODEL,
    judgment_id: 'seed-judgment',
    per_criterion_scores: [{ criterion: 'correctness', score: 1 }],
    recorded_at: RECORDED_AT,
    recorder: RECORDER,
    rubric_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    run_id: 'seed-run',
    skill_under_test: SKILL,
    task_set_id: 'ts-val',
    task_set_version: TASK_VERSION,
    verdict: 'Accepted',
    weighted_aggregate: 0.4,
  });
  recordJudgment(evolvePaths(root), {
    candidate_overlay_sha256: digest,
    cost_usd: 1,
    judge_model: MODEL,
    judgment_id: 'sample-1',
    per_criterion_scores: [{ criterion: 'correctness', score: 1 }],
    recorded_at: RECORDED_AT,
    recorder: RECORDER,
    rubric_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    run_id: 'cycle-run',
    skill_under_test: SKILL,
    task_set_id: 'ts-val',
    task_set_version: TASK_VERSION,
    verdict: 'Accepted',
    weighted_aggregate: 0.8,
  });
  const request: ValidateRequest = {
    action: 'accept',
    catalogSha256: CATALOG,
    cycleRunId: 'cycle-run',
    expectedInvocations: [],
    judgeModel: MODEL,
    recordedAt: RECORDED_AT,
    recorder: RECORDER,
    seedJudgmentId: 'seed-judgment',
    seedRunId: 'seed-run',
    skill: SKILL,
    taskSetVersion: TASK_VERSION,
  };
  const report = validateCycle(root, request);
  assert.equal(report.decision, 'accept');
  return root;
}

function fixture(): { lockFile: string; payload: string; root: string; stub: string; vendor: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'b4-fixture-')));
  const stub = initStub();
  const vendor = join(root, 'vendor', 'skills');
  const payload = join(root, 'payload');
  const lockFile = join(root, 'skills.lock.json');
  mkdirSync(vendor, { recursive: true });
  writeFileSync(join(vendor, 'IN_PLACE_SENTINEL'), 'do-not-keep\n');
  writeLock(lockFile, stub, git(stub, ['rev-parse', 'HEAD']));
  return { lockFile, payload, root, stub, vendor };
}

function finish(paths: readonly string[]): void {
  for (const path of paths) rmSync(path, { recursive: true, force: true });
}

void test('package skills.lock.json is not the runtime bump target', () => {
  assert.equal(readFileSync(join(REPO, 'skills.lock.json'), 'utf8'), PACKAGE_LOCK);
  assert.match(PACKAGE_LOCK, /28f813bf9fd767960b96e9d54857964de8181a53/);
});

void test('accept publishes one skill, bumps the lock, revendors, and rebuilds payloads', () => {
  const box = fixture();
  const evolve = acceptWorkspace();
  const before = commitCount(box.stub);
  const catalogBefore = git(box.stub, ['rev-parse', 'HEAD:catalog.json']);
  appendWikiFile(evolvePaths(evolve), 'logs.md', 'kept-learning\n');
  const logs = readFileSync(evolvePaths(evolve).wikiLogsFile, 'utf8');
  try {
    const report: UpstreamFlowReport = flowUpstream({
      decision: 'accept',
      lockFile: box.lockFile,
      payloadRoot: box.payload,
      repoRoot: REPO,
      root: evolve,
      skill: SKILL,
      upstreamDir: box.stub,
      vendorDir: box.vendor,
    });
    assert.equal(report.decision, 'accept');
    assert.equal(report.code, null);
    assert.equal(report.overlayDropped, false);
    assert.equal(report.skillFiles.length, 1);
    assert.equal(report.skillFiles[0], `skills/${SKILL}/SKILL.md`);
    assert.equal(report.pullRequest?.number, 1);
    assert.equal(report.pullRequest?.files[0], `skills/${SKILL}/SKILL.md`);
    assert.equal(git(box.stub, ['branch', '--list', report.pullRequest?.branch ?? '']), report.pullRequest?.branch);
    assert.notEqual(commitCount(box.stub), before);
    assert.equal(git(box.stub, ['rev-parse', 'HEAD:catalog.json']), catalogBefore);
    assert.equal(readFileSync(join(box.stub, 'skills', SKILL, 'SKILL.md'), 'utf8'), OVERLAY);
    assert.equal(readSha(box.lockFile), git(box.stub, ['rev-parse', 'HEAD']));
    assert.equal(readFileSync(join(box.vendor, 'HEAD_SHA'), 'utf8').trim(), readSha(box.lockFile));
    assert.equal(git(box.vendor, ['rev-parse', 'HEAD']), readSha(box.lockFile));
    assert.equal(readFileSync(join(box.vendor, 'skills', SKILL, 'SKILL.md'), 'utf8'), OVERLAY);
    assert.equal(exists(join(box.vendor, 'IN_PLACE_SENTINEL')), false);
    assert.equal(readFileSync(evolvePaths(evolve).wikiLogsFile, 'utf8'), logs);
    assert.equal(exists(join(box.payload, 'omc-plugin')), false);
    assert.equal(exists(join(box.payload, 'omx-plugin')), false);
    assert.equal(exists(join(box.payload, 'oh-my-openagent')), false);
    assert.equal(exists(join(box.payload, 'claude-plugin', 'skills', 'claude-only', 'SKILL.md')), true);
    assert.equal(exists(join(box.payload, 'codex-plugin', 'skills', 'claude-only')), false);
    assert.equal(exists(join(box.payload, 'claude-plugin', 'skills', 'omc-host-only')), false);
    assert.equal(exists(join(box.payload, 'opencode-plugin', 'command', 'autobahn.md')), true);
    assert.equal(exists(join(box.payload, 'opencode-plugin', 'command', 'northstar.md')), true);
    assert.equal(exists(join(box.payload, 'opencode-plugin', 'opencode.json')), false);
    assert.equal(exists(join(box.payload, 'opencode-plugin', 'opencode.jsonc')), false);
    const manifest = JSON.parse(readFileSync(join(box.payload, 'opencode-plugin', '.opencode-plugin', 'plugin.json'), 'utf8')) as { plugins?: unknown };
    assert.equal(manifest.plugins, undefined);
    const parity = JSON.parse(readFileSync(join(box.payload, 'harness-parity.json'), 'utf8')) as {
      'omo-ai': string;
      omc: string;
      omx: string;
      opencode: string;
      pluginArray: boolean;
    };
    assert.equal(parity.omc, 'claude-plugin');
    assert.equal(parity.omx, 'codex-plugin');
    assert.equal(parity.opencode, 'commands+skills');
    assert.equal(parity['omo-ai'], 'standalone');
    assert.equal(parity.pluginArray, false);
    verifyHandoff(box.lockFile, box.vendor);
  } finally {
    finish([box.root, box.stub, evolve]);
  }
});

void test('reject drops the overlay, keeps the wiki, and does not write upstream', () => {
  const box = fixture();
  const evolve = realpathSync(mkdtempSync(join(tmpdir(), 'b4-reject-')));
  initEvolveLayout(evolve);
  stageOverlay(evolvePaths(evolve), SKILL, OVERLAY);
  appendWikiFile(evolvePaths(evolve), 'logs.md', 'kept-learning\n');
  appendWikiFile(evolvePaths(evolve), 'skill-impact.md', 'kept-impact\n');
  const logs = readFileSync(evolvePaths(evolve).wikiLogsFile, 'utf8');
  const impact = readFileSync(evolvePaths(evolve).wikiSkillImpactFile, 'utf8');
  const head = git(box.stub, ['rev-parse', 'HEAD']);
  const lock = readFileSync(box.lockFile, 'utf8');
  try {
    const report = flowUpstream({
      decision: 'reject',
      lockFile: box.lockFile,
      payloadRoot: box.payload,
      repoRoot: REPO,
      root: evolve,
      skill: SKILL,
      upstreamDir: box.stub,
      vendorDir: box.vendor,
    });
    assert.equal(report.decision, 'reject');
    assert.equal(report.code, null);
    assert.equal(report.overlayDropped, true);
    assert.equal(report.upstreamWrites, 0);
    assert.equal(exists(join(evolve, 'evolve/proposals', `${SKILL}.overlay`)), false);
    assert.equal(readFileSync(evolvePaths(evolve).wikiLogsFile, 'utf8'), logs);
    assert.equal(readFileSync(evolvePaths(evolve).wikiSkillImpactFile, 'utf8'), impact);
    assert.equal(git(box.stub, ['rev-parse', 'HEAD']), head);
    assert.equal(git(box.stub, ['branch', '--list']), '* main');
    assert.equal(readFileSync(box.lockFile, 'utf8'), lock);
    assert.equal(readFileSync(join(box.vendor, 'IN_PLACE_SENTINEL'), 'utf8'), 'do-not-keep\n');
    assert.equal(exists(join(box.payload, 'claude-plugin')), false);
  } finally {
    finish([box.root, box.stub, evolve]);
  }
});

void test('red-leg fixture: a mutated lock SHA is refused before payload rewrite', () => {
  const box = fixture();
  const evolve = acceptWorkspace();
  try {
    const report = flowUpstream({
      decision: 'accept',
      lockFile: box.lockFile,
      payloadRoot: box.payload,
      repoRoot: REPO,
      root: evolve,
      skill: SKILL,
      upstreamDir: box.stub,
      vendorDir: box.vendor,
    });
    assert.equal(report.decision, 'accept');
    const lock = JSON.parse(readFileSync(box.lockFile, 'utf8')) as { sha: string };
    lock.sha = 'f'.repeat(64);
    writeFileSync(box.lockFile, `${JSON.stringify(lock)}\n`);
    writeFileSync(join(box.payload, 'MARKER'), 'before\n');
    assert.throws(() => verifyHandoff(box.lockFile, box.vendor), /handoff_sha_mismatch/);
    assert.throws(() => rebuildPayloads({
      lockFile: box.lockFile,
      payloadRoot: box.payload,
      repoRoot: REPO,
      vendorDir: box.vendor,
    }), /handoff_sha_mismatch/);
    assert.equal(readFileSync(join(box.payload, 'MARKER'), 'utf8'), 'before\n');
    const cli = spawnSync(process.execPath, [
      BIN, 'evolve', '--upstream', '--verify-handoff',
      '--lock', box.lockFile,
      '--vendor', box.vendor,
    ], { encoding: 'utf8' });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /handoff_sha_mismatch/);
  } finally {
    finish([box.root, box.stub, evolve]);
  }
});

void test('a real skills remote is refused and no commit is created', () => {
  const box = fixture();
  const evolve = acceptWorkspace();
  const head = git(box.stub, ['rev-parse', 'HEAD']);
  git(box.stub, ['remote', 'add', 'origin', REAL_SKILLS]);
  try {
    const report = flowUpstream({
      decision: 'accept',
      lockFile: box.lockFile,
      payloadRoot: box.payload,
      repoRoot: REPO,
      root: evolve,
      skill: SKILL,
      upstreamDir: box.stub,
      vendorDir: box.vendor,
    });
    assert.equal(report.decision, 'refused');
    assert.equal(report.code, 'upstream_refused');
    assert.equal(report.upstreamWrites, 0);
    assert.equal(git(box.stub, ['rev-parse', 'HEAD']), head);
  } finally {
    finish([box.root, box.stub, evolve]);
  }
});

function flow(box: { lockFile: string; payload: string; stub: string; vendor: string }, evolve: string, repoRoot = REPO) {
  return flowUpstream({
    decision: 'accept',
    lockFile: box.lockFile,
    payloadRoot: box.payload,
    repoRoot,
    root: evolve,
    skill: SKILL,
    upstreamDir: box.stub,
    vendorDir: box.vendor,
  });
}

void test('a catalog alias sharing the skill path is not a single-skill publish', () => {
  const box = fixture();
  const evolve = acceptWorkspace();
  const catalog = JSON.parse(readFileSync(join(box.stub, 'catalog.json'), 'utf8')) as { skills: Array<Record<string, unknown>> };
  catalog.skills.push({ name: 'omc-alias', source_path: `skills/${SKILL}`, supported_hosts: ['omc'] });
  writeFileSync(join(box.stub, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  git(box.stub, ['add', 'catalog.json']);
  git(box.stub, ['commit', '-q', '-m', 'alias']);
  const head = git(box.stub, ['rev-parse', 'HEAD']);
  writeLock(box.lockFile, box.stub, head);
  try {
    const report = flow(box, evolve);
    assert.equal(report.decision, 'refused');
    assert.equal(report.code, 'not_single_skill');
    assert.equal(report.upstreamWrites, 0);
    assert.equal(git(box.stub, ['rev-parse', 'HEAD']), head);
  } finally {
    finish([box.root, box.stub, evolve]);
  }
});

void test('a lock SHA that is not the upstream HEAD is refused before any commit', () => {
  const box = fixture();
  const evolve = acceptWorkspace();
  const head = git(box.stub, ['rev-parse', 'HEAD']);
  const lock = JSON.parse(readFileSync(box.lockFile, 'utf8')) as { ref: string; repo: string; sha: string };
  lock.sha = 'f'.repeat(40);
  writeFileSync(box.lockFile, `${JSON.stringify(lock, null, 2)}\n`);
  try {
    const report = flow(box, evolve);
    assert.equal(report.decision, 'refused');
    assert.equal(report.code, 'handoff_sha_mismatch');
    assert.equal(git(box.stub, ['rev-parse', 'HEAD']), head);
    assert.equal(readSha(box.lockFile), 'f'.repeat(40));
  } finally {
    finish([box.root, box.stub, evolve]);
  }
});

void test('a case-variant skills remote is refused and creates no commit', () => {
  const box = fixture();
  const evolve = acceptWorkspace();
  const head = git(box.stub, ['rev-parse', 'HEAD']);
  git(box.stub, ['remote', 'add', 'origin', 'https://github.com/R3DLEX/skills.git']);
  try {
    const report = flow(box, evolve);
    assert.equal(report.decision, 'refused');
    assert.equal(report.code, 'upstream_refused');
    assert.equal(git(box.stub, ['rev-parse', 'HEAD']), head);
  } finally {
    finish([box.root, box.stub, evolve]);
  }
});

void test('assume-unchanged hides an edited vendored SKILL.md from status but not from handoff', () => {
  const box = fixture();
  const evolve = acceptWorkspace();
  const injected = 'assume-unchanged-injected\n';
  const relative = `skills/${SKILL}/SKILL.md`;
  try {
    const report = flow(box, evolve);
    assert.equal(report.decision, 'accept');
    git(box.vendor, ['update-index', '--assume-unchanged', '--', relative]);
    writeFileSync(join(box.vendor, relative), injected);
    const hidden = git(box.vendor, ['status', '--porcelain', '--untracked-files=all']);
    assert.equal(hidden.includes(relative), false);
    const codexSkill = join(box.payload, 'codex-plugin', 'skills', SKILL, 'SKILL.md');
    assert.equal(readFileSync(codexSkill, 'utf8'), OVERLAY);
    writeFileSync(join(box.payload, 'MARKER'), 'before\n');
    assert.throws(() => verifyHandoff(box.lockFile, box.vendor), /handoff_sha_mismatch/);
    assert.throws(() => rebuildPayloads({
      lockFile: box.lockFile,
      payloadRoot: box.payload,
      repoRoot: REPO,
      vendorDir: box.vendor,
    }), /handoff_sha_mismatch/);
    assert.equal(readFileSync(join(box.payload, 'MARKER'), 'utf8'), 'before\n');
    assert.equal(readFileSync(codexSkill, 'utf8'), OVERLAY);
    assert.equal(readFileSync(codexSkill, 'utf8').includes(injected.trim()), false);
  } finally {
    finish([box.root, box.stub, evolve]);
  }
});

void test('skip-worktree hides an edited vendored SKILL.md from status but not from handoff', () => {
  const box = fixture();
  const evolve = acceptWorkspace();
  const injected = 'skip-worktree-injected\n';
  const relative = `skills/${SKILL}/SKILL.md`;
  try {
    const report = flow(box, evolve);
    assert.equal(report.decision, 'accept');
    git(box.vendor, ['update-index', '--skip-worktree', '--', relative]);
    writeFileSync(join(box.vendor, relative), injected);
    const hidden = git(box.vendor, ['status', '--porcelain', '--untracked-files=all']);
    assert.equal(hidden.includes(relative), false);
    const codexSkill = join(box.payload, 'codex-plugin', 'skills', SKILL, 'SKILL.md');
    assert.equal(readFileSync(codexSkill, 'utf8'), OVERLAY);
    writeFileSync(join(box.payload, 'MARKER'), 'before\n');
    assert.throws(() => verifyHandoff(box.lockFile, box.vendor), /handoff_sha_mismatch/);
    assert.throws(() => rebuildPayloads({
      lockFile: box.lockFile,
      payloadRoot: box.payload,
      repoRoot: REPO,
      vendorDir: box.vendor,
    }), /handoff_sha_mismatch/);
    assert.equal(readFileSync(join(box.payload, 'MARKER'), 'utf8'), 'before\n');
    assert.equal(readFileSync(codexSkill, 'utf8'), OVERLAY);
    assert.equal(readFileSync(codexSkill, 'utf8').includes(injected.trim()), false);
  } finally {
    finish([box.root, box.stub, evolve]);
  }
});

void test('vendored bytes that differ from the locked commit are refused before payload rewrite', () => {
  const box = fixture();
  const evolve = acceptWorkspace();
  try {
    const report = flow(box, evolve);
    assert.equal(report.decision, 'accept');
    writeFileSync(join(box.vendor, 'skills', SKILL, 'SKILL.md'), 'mutated-in-place\n');
    writeFileSync(join(box.payload, 'MARKER'), 'before\n');
    assert.throws(() => verifyHandoff(box.lockFile, box.vendor), /handoff_sha_mismatch/);
    assert.throws(() => rebuildPayloads({
      lockFile: box.lockFile,
      payloadRoot: box.payload,
      repoRoot: REPO,
      vendorDir: box.vendor,
    }), /handoff_sha_mismatch/);
    assert.equal(readFileSync(join(box.payload, 'MARKER'), 'utf8'), 'before\n');
  } finally {
    finish([box.root, box.stub, evolve]);
  }
});

void test('a failing pre-commit hook restores the stub branch and unstages the overlay', () => {
  const box = fixture();
  const evolve = acceptWorkspace();
  const head = git(box.stub, ['rev-parse', 'HEAD']);
  const skillFile = join(box.stub, 'skills', SKILL, 'SKILL.md');
  const baseline = readFileSync(skillFile, 'utf8');
  const hooks = join(box.stub, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  const hook = join(hooks, 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  chmodSync(hook, 0o755);
  git(box.stub, ['config', 'core.hooksPath', hooks]);
  let report: UpstreamFlowReport | null;
  try {
    try {
      report = flow(box, evolve);
    } catch {
      report = null;
    }
    assert.equal(git(box.stub, ['branch', '--show-current']), 'main');
    assert.equal(git(box.stub, ['status', '--porcelain']), '');
    assert.equal(git(box.stub, ['diff', '--cached', '--name-only']), '');
    assert.equal(git(box.stub, ['rev-parse', 'HEAD']), head);
    assert.equal(readFileSync(skillFile, 'utf8'), baseline);
    assert.equal(git(box.stub, ['branch', '--list', 'evolve/*']), '');
    assert.equal(report?.decision, 'refused');
    assert.equal(report?.code, 'upstream_refused');
    assert.equal(report?.upstreamWrites, 0);
    rmSync(hook);
    const again = flow(box, evolve);
    assert.equal(again.decision, 'accept');
    assert.equal(git(box.stub, ['branch', '--show-current']), 'main');
    assert.equal(git(box.stub, ['status', '--porcelain']), '');
  } finally {
    finish([box.root, box.stub, evolve]);
  }
});

void test('a symlinked SKILL.md is refused before any write through the link', () => {
  const box = fixture();
  const evolve = acceptWorkspace();
  const external = realpathSync(mkdtempSync(join(tmpdir(), 'b4-external-')));
  const externalFile = join(external, 'SKILL.md');
  const original = 'external-baseline\n';
  writeFileSync(externalFile, original);
  const skillFile = join(box.stub, 'skills', SKILL, 'SKILL.md');
  rmSync(skillFile);
  symlinkSync(externalFile, skillFile);
  git(box.stub, ['add', '--', `skills/${SKILL}/SKILL.md`]);
  git(box.stub, ['commit', '-q', '-m', 'symlink skill']);
  const head = git(box.stub, ['rev-parse', 'HEAD']);
  writeLock(box.lockFile, box.stub, head);
  try {
    const report = flow(box, evolve);
    assert.equal(report.decision, 'refused');
    assert.equal(report.upstreamWrites, 0);
    assert.equal(readFileSync(externalFile, 'utf8'), original);
    assert.equal(readFileSync(externalFile, 'utf8').includes('evolved rollout'), false);
    assert.equal(git(box.stub, ['rev-parse', 'HEAD']), head);
    assert.equal(git(box.stub, ['status', '--porcelain']), '');
    assert.equal(git(box.stub, ['branch', '--show-current']), 'main');
    assert.equal(git(box.stub, ['diff', '--cached', '--name-only']), '');
  } finally {
    finish([box.root, box.stub, evolve, external]);
  }
});

void test('a hardlinked SKILL.md is refused before any write through the link', () => {
  const box = fixture();
  const evolve = acceptWorkspace();
  const external = realpathSync(mkdtempSync(join(tmpdir(), 'b4-hardlink-')));
  const skillFile = join(box.stub, 'skills', SKILL, 'SKILL.md');
  const baseline = readFileSync(skillFile, 'utf8');
  const externalFile = join(external, 'SKILL.md');
  writeFileSync(externalFile, baseline);
  rmSync(skillFile);
  linkSync(externalFile, skillFile);
  const head = git(box.stub, ['rev-parse', 'HEAD']);
  try {
    const report = flow(box, evolve);
    assert.equal(report.decision, 'refused');
    assert.equal(report.upstreamWrites, 0);
    assert.equal(readFileSync(externalFile, 'utf8'), baseline);
    assert.equal(readFileSync(externalFile, 'utf8').includes('evolved rollout'), false);
    assert.equal(git(box.stub, ['rev-parse', 'HEAD']), head);
    assert.equal(git(box.stub, ['status', '--porcelain']), '');
    assert.equal(git(box.stub, ['branch', '--show-current']), 'main');
  } finally {
    finish([box.root, box.stub, evolve, external]);
  }
});

void test('a symlinked skill directory is refused before any write through the link', () => {
  const box = fixture();
  const evolve = acceptWorkspace();
  const external = realpathSync(mkdtempSync(join(tmpdir(), 'b4-external-dir-')));
  const original = 'external-dir-baseline\n';
  writeFileSync(join(external, 'SKILL.md'), original);
  const skillDir = join(box.stub, 'skills', SKILL);
  rmSync(skillDir, { recursive: true, force: true });
  symlinkSync(external, skillDir);
  git(box.stub, ['add', '--', `skills/${SKILL}`]);
  git(box.stub, ['commit', '-q', '-m', 'symlink skill dir']);
  const head = git(box.stub, ['rev-parse', 'HEAD']);
  writeLock(box.lockFile, box.stub, head);
  try {
    const report = flow(box, evolve);
    assert.equal(report.decision, 'refused');
    assert.equal(report.upstreamWrites, 0);
    assert.equal(readFileSync(join(external, 'SKILL.md'), 'utf8'), original);
    assert.equal(git(box.stub, ['rev-parse', 'HEAD']), head);
    assert.equal(git(box.stub, ['status', '--porcelain']), '');
    assert.equal(git(box.stub, ['branch', '--show-current']), 'main');
  } finally {
    finish([box.root, box.stub, evolve, external]);
  }
});

void test('a failed payload rebuild restores the vendor tree and does not keep the stub commit', () => {
  const box = fixture();
  const evolve = acceptWorkspace();
  const empty = realpathSync(mkdtempSync(join(tmpdir(), 'b4-empty-repo-')));
  const head = git(box.stub, ['rev-parse', 'HEAD']);
  const lock = readFileSync(box.lockFile, 'utf8');
  try {
    const report = flow(box, evolve, empty);
    assert.equal(report.decision, 'refused');
    assert.equal(git(box.stub, ['rev-parse', 'HEAD']), head);
    assert.equal(readFileSync(join(box.vendor, 'IN_PLACE_SENTINEL'), 'utf8'), 'do-not-keep\n');
    assert.equal(readFileSync(box.lockFile, 'utf8'), lock);
    assert.equal(exists(join(box.payload, 'claude-plugin')), false);
  } finally {
    finish([box.root, box.stub, evolve, empty]);
  }
});

function exists(path: string): boolean {
  return existsSync(path);
}
