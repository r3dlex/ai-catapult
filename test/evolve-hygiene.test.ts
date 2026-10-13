/**
 * TDD tests for tswc-ac-b5 — structural pre-reject before any judge call.
 *
 * A gnarly proposal is refused by the consumed A-gates and the stub judge is
 * not invoked. OKF frontmatter findings never block and never carry
 * okf_version. Thresholds are read from the delivered configs, not restated.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  reviewProposal,
  type HygieneReport,
  type JudgeHarness,
  type SkillProposal,
} from '../src/evolve/hygiene.ts';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const BIN = join(REPO, 'bin/ai-catapult.ts');
const RUFF_SHA = 'a8f67d5d2539791a4a464fcbeff2c23a8b3489f3bc9b3a2774d1f220c36c8b84';
const SHELLCHECK_SHA = '6a180a9f928086db7754f5212950524e492ba5ab75236357f8b4c2c1a317ac35';

function toolPresent(name: string): boolean {
  const found = spawnSync('bash', ['-lc', `command -v ${name}`], { encoding: 'utf8' });
  return found.status === 0 && (found.stdout ?? '').trim() !== '';
}

function countingJudge(): { harness: JudgeHarness; calls: number } {
  const state = { calls: 0 };
  const harness: JudgeHarness = {
    invoke() {
      state.calls += 1;
      return { costUsd: 25 };
    },
  };
  return { harness, get calls() { return state.calls; } };
}

function proposal(scripts: SkillProposal['scripts'], skillMd = '---\nname: rollout\ndescription: a skill\n---\n# body\n'): SkillProposal {
  return { skill: 'rollout', skillMd, scripts };
}

function ifs(count: number): string {
  const lines = ['export function gnarly(n: number): number {'];
  for (let index = 1; index <= count; index += 1) {
    lines.push(`  if (n === ${String(index)}) return ${String(index)};`);
  }
  lines.push('  return 0;', '}');
  return lines.join('\n');
}

function nested(): string {
  const lines = ['export function nest(n: number): number {'];
  for (let index = 0; index < 9; index += 1) {
    lines.push(`${'  '.repeat(index + 1)}if (n > ${String(index)}) {`);
  }
  lines.push(`${'  '.repeat(10)}return n;`);
  for (let index = 9; index >= 1; index -= 1) {
    lines.push(`${'  '.repeat(index)}}`);
  }
  lines.push('  return 0;', '}');
  return lines.join('\n');
}

function configNumber(pattern: RegExp): number {
  const text = readFileSync(join(REPO, 'eslint.config.js'), 'utf8');
  const match = pattern.exec(text);
  assert.ok(match?.[1], 'delivered eslint rule missing');
  return Number(match[1]);
}

function assertNoVersion(report: HygieneReport): void {
  assert.equal(JSON.stringify(report).includes('okf_version'), false);
}

function assertZeroDollars(report: HygieneReport, calls: number): void {
  assert.equal(report.decision, 'pre-reject');
  assert.equal(report.judgeInvocations, 0);
  assert.equal(report.costUsd, 0);
  assert.equal(calls, 0);
  assertNoVersion(report);
}

void test('consumed A4 config bytes are the delivered ruff and shellcheck pins', () => {
  const ruff = readFileSync(join(REPO, 'src/evolve/consumed/ruff.toml'));
  const rc = readFileSync(join(REPO, 'src/evolve/consumed/shellcheckrc'));
  assert.equal(createHash('sha256').update(ruff).digest('hex'), RUFF_SHA);
  assert.equal(createHash('sha256').update(rc).digest('hex'), SHELLCHECK_SHA);
});

void test('a gnarly TypeScript proposal costs zero judge dollars', () => {
  const max = configNumber(/complexity:\s*\['error',\s*(\d+)\]/);
  const judge = countingJudge();
  const report = reviewProposal(proposal([{ name: 'gnarly.ts', bytes: ifs(max + 2) }]), judge.harness);
  assertZeroDollars(report, judge.calls);
  const gate = report.gates.find((item) => item.gate === 'eslint');
  assert.ok(gate);
  assert.equal(gate.status, 'fail');
  assert.equal(gate.detail.includes(`Maximum allowed is ${String(max)}`), true);
});

void test('sonarjs cognitive-complexity is the delivered eslint threshold', () => {
  const max = configNumber(/'sonarjs\/cognitive-complexity':\s*\['error',\s*(\d+)\]/);
  const judge = countingJudge();
  const report = reviewProposal(proposal([{ name: 'nest.ts', bytes: nested() }]), judge.harness);
  assertZeroDollars(report, judge.calls);
  const gate = report.gates.find((item) => item.gate === 'eslint');
  assert.ok(gate);
  assert.equal(gate.detail.includes(`the ${String(max)} allowed`), true);
});

void test('a type error is pre-rejected by the consumed tsc project before the judge', () => {
  const judge = countingJudge();
  const report = reviewProposal(
    proposal([{ name: 'bad.ts', bytes: 'export const n: number = "no";\n' }]),
    judge.harness,
  );
  assertZeroDollars(report, judge.calls);
  assert.equal(report.gates.some((item) => item.gate === 'tsc' && item.status === 'fail'), true);
});

void test('a clean proposal reaches the judge seam once', () => {
  const judge = countingJudge();
  const report = reviewProposal(
    proposal([{ name: 'clean.ts', bytes: 'export function clean(n: number): number {\n  return n + 1;\n}\n' }]),
    judge.harness,
  );
  assert.equal(report.decision, 'proceed');
  assert.equal(report.judgeInvocations, 1);
  assert.equal(judge.calls, 1);
  assert.equal(report.gates.length, 0);
  assertNoVersion(report);
});

void test('OKF frontmatter findings never block and never emit okf_version', () => {
  const judge = countingJudge();
  const skillMd = '---\nokf_version: "0.3"\nname: rollout\n---\n# body\n';
  const report = reviewProposal(
    proposal([{ name: 'clean.ts', bytes: 'export function clean(n: number): number {\n  return n + 1;\n}\n' }], skillMd),
    judge.harness,
  );
  assert.equal(report.decision, 'proceed');
  assert.equal(judge.calls, 1);
  assert.equal(report.findings.some((item) => item.code === 'okf_frontmatter' && item.detail.includes('description')), true);
  assert.equal(report.findings.some((item) => item.detail.includes('okf_version')), false);
  assertNoVersion(report);
});

void test('a gnarly proposal still reports advisory frontmatter findings', () => {
  const max = configNumber(/complexity:\s*\['error',\s*(\d+)\]/);
  const judge = countingJudge();
  const report = reviewProposal(proposal([{ name: 'gnarly.ts', bytes: ifs(max + 2) }], '# no frontmatter\n'), judge.harness);
  assertZeroDollars(report, judge.calls);
  assert.equal(report.findings.length > 0, true);
});

void test('shellcheck -S error pre-rejects a gnarly shell script', () => {
  const judge = countingJudge();
  const report = reviewProposal(
    proposal([{ name: 'bad.sh', bytes: '#!/bin/sh\necho ${unclosed\n' }]),
    judge.harness,
  );
  assertZeroDollars(report, judge.calls);
  const gate = report.gates.find((item) => item.gate === 'shellcheck');
  assert.ok(gate);
  assert.equal(gate.status, 'fail');
  assert.deepEqual(gate.command.slice(0, 3), ['shellcheck', '-S', 'error']);
});

void test('ruff and xenon are consumed, and a missing tool is not a pass', () => {
  const judge = countingJudge();
  const bytes = 'def gnarly(n):\n' + Array.from({ length: 12 }, (_, index) => `    if n == ${String(index + 1)}:\n        return ${String(index + 1)}\n`).join('') + '    return 0\n';
  const report = reviewProposal(proposal([{ name: 'gnarly.py', bytes }]), judge.harness);
  assertZeroDollars(report, judge.calls);
  const ruff = report.gates.find((item) => item.gate === 'ruff');
  const xenon = report.gates.find((item) => item.gate === 'xenon');
  assert.ok(ruff);
  assert.ok(xenon);
  assert.deepEqual(ruff.command.slice(0, 5), ['ruff', 'check', '--no-cache', '--config', 'ruff.toml']);
  assert.deepEqual(xenon.command.slice(0, 5), ['xenon', '--max-absolute', 'B', '--max-average', 'A']);
  assert.equal(ruff.status, toolPresent('ruff') ? 'fail' : 'tool-missing');
  assert.equal(xenon.status, toolPresent('xenon') ? 'fail' : 'tool-missing');
});

void test('shfmt -d is consumed and a missing shfmt is not a pass', () => {
  const judge = countingJudge();
  const report = reviewProposal(proposal([{ name: 'messy.sh', bytes: 'foo(){\necho hi\n}\n' }]), judge.harness);
  assertZeroDollars(report, judge.calls);
  const gate = report.gates.find((item) => item.gate === 'shfmt');
  assert.ok(gate);
  assert.deepEqual(gate.command.slice(0, 2), ['shfmt', '-d']);
  assert.equal(gate.status, toolPresent('shfmt') ? 'fail' : 'tool-missing');
});

void test('an unrecognized script is pre-rejected before the judge', () => {
  const judge = countingJudge();
  const report = reviewProposal(proposal([{ name: 'notes.md', bytes: '# notes\n' }]), judge.harness);
  assertZeroDollars(report, judge.calls);
  assert.equal(report.gates.some((item) => item.gate === 'unrecognized-script'), true);
});

void test('a path escape is refused before the judge and before any write', () => {
  const judge = countingJudge();
  const report = reviewProposal(proposal([{ name: '../outside.ts', bytes: 'export const n = 1;\n' }]), judge.harness);
  assertZeroDollars(report, judge.calls);
  assert.equal(report.gates.some((item) => item.gate === 'unsafe-path'), true);
});

void test('a script name containing dotdot is refused before the judge', () => {
  for (const name of ['foo..ts', 'a..b.ts']) {
    const judge = countingJudge();
    const report = reviewProposal(proposal([{ name, bytes: 'export const n = 1;\n' }]), judge.harness);
    assertZeroDollars(report, judge.calls);
    assert.equal(report.gates.some((item) => item.gate === 'unsafe-path'), true);
  }
});

void test('a report does not emit okf_version even when the script name contains it', () => {
  const judge = countingJudge();
  const report = reviewProposal(
    proposal([{ name: 'okf_version.ts', bytes: 'export const n: number = "no";\n' }]),
    judge.harness,
  );
  assertZeroDollars(report, judge.calls);
  assert.equal(JSON.stringify(report).includes('okf_version'), false);
});

void test('CLI pre-reject prints zero invocations and no okf_version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'b5-proposal-'));
  try {
    const max = configNumber(/complexity:\s*\['error',\s*(\d+)\]/);
    writeFileSync(join(dir, 'SKILL.md'), '---\nokf_version: "0.3"\n---\n');
    writeFileSync(join(dir, 'gnarly.ts'), ifs(max + 2));
    const result = spawnSync(process.execPath, [BIN, 'evolve', '--pre-reject', '--skill', 'rollout', '--proposal', dir], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.equal((result.stdout ?? '').includes('okf_version'), false);
    const report = JSON.parse(result.stdout ?? '') as HygieneReport;
    assert.equal(report.judgeInvocations, 0);
    assert.equal(report.costUsd, 0);
    assert.equal(report.decision, 'pre-reject');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test('a hard-linked proposal script is refused before the judge reads it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'b5-hard-'));
  const outside = mkdtempSync(join(tmpdir(), 'b5-hard-out-'));
  try {
    const external = join(outside, 'secret.ts');
    writeFileSync(external, 'export const secret = 1;\n');
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: rollout\ndescription: a skill\n---\n');
    linkSync(external, join(dir, 'secret.ts'));
    const result = spawnSync(process.execPath, [BIN, 'evolve', '--pre-reject', '--skill', 'rollout', '--proposal', dir], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout ?? '') as HygieneReport;
    assert.equal(report.judgeInvocations, 0);
    assert.equal(report.decision, 'pre-reject');
    assert.equal(readFileSync(external, 'utf8'), 'export const secret = 1;\n');
    assert.equal((result.stdout ?? '').includes('okf_version'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

void test('an ignore-path name does not skip the complexity pre-reject', () => {
  const max = configNumber(/complexity:\s*\['error',\s*(\d+)\]/);
  for (const name of ['node_modules/evil.ts', '.git/evil.ts', 'pkg/node_modules/evil.ts']) {
    const judge = countingJudge();
    const report = reviewProposal(proposal([{ name, bytes: ifs(max + 4) }]), judge.harness);
    assertZeroDollars(report, judge.calls);
    const gate = report.gates.find((item) => item.gate === 'eslint' && item.script === name);
    assert.ok(gate, name);
    assert.equal(gate.status, 'fail');
    assert.equal(gate.detail.includes(`Maximum allowed is ${String(max)}`), true);
  }
});

void test('an ignore-path name does not skip the cognitive-complexity pre-reject', () => {
  const max = configNumber(/'sonarjs\/cognitive-complexity':\s*\['error',\s*(\d+)\]/);
  const judge = countingJudge();
  const report = reviewProposal(proposal([{ name: 'node_modules/nest.ts', bytes: nested() }]), judge.harness);
  assertZeroDollars(report, judge.calls);
  const gate = report.gates.find((item) => item.gate === 'eslint');
  assert.ok(gate);
  assert.equal(gate.detail.includes(`the ${String(max)} allowed`), true);
});

function withDisable(body: string, directive: string): string {
  return `${directive}\n${body}`;
}

void test('an eslint-disable comment does not skip the complexity pre-reject', () => {
  const max = configNumber(/complexity:\s*\['error',\s*(\d+)\]/);
  const body = ifs(max + 4);
  const directives = [
    '/* eslint-disable complexity, sonarjs/cognitive-complexity */',
    '/* eslint-disable */',
    '// eslint-disable-next-line complexity, sonarjs/cognitive-complexity',
    '/* eslint complexity: "off", sonarjs/cognitive-complexity: "off" */',
  ];
  for (const directive of directives) {
    const judge = countingJudge();
    const report = reviewProposal(proposal([{ name: 'disabled.ts', bytes: withDisable(body, directive) }]), judge.harness);
    assertZeroDollars(report, judge.calls);
    const gate = report.gates.find((item) => item.gate === 'eslint' && item.script === 'disabled.ts');
    assert.ok(gate, directive);
    assert.equal(gate.status, 'fail');
    assert.equal(gate.detail.includes(`Maximum allowed is ${String(max)}`), true, directive);
  }
});

void test('an eslint-disable comment does not skip the cognitive-complexity pre-reject', () => {
  const max = configNumber(/'sonarjs\/cognitive-complexity':\s*\['error',\s*(\d+)\]/);
  const judge = countingJudge();
  const bytes = withDisable(nested(), '/* eslint-disable complexity, sonarjs/cognitive-complexity */');
  const report = reviewProposal(proposal([{ name: 'disabled-nest.ts', bytes }]), judge.harness);
  assertZeroDollars(report, judge.calls);
  const gate = report.gates.find((item) => item.gate === 'eslint' && item.script === 'disabled-nest.ts');
  assert.ok(gate);
  assert.equal(gate.status, 'fail');
  assert.equal(gate.detail.includes(`the ${String(max)} allowed`), true);
});

void test('an eslint-disable comment on an ignore-path name does not skip the complexity pre-reject', () => {
  const max = configNumber(/complexity:\s*\['error',\s*(\d+)\]/);
  const bytes = withDisable(ifs(max + 4), '/* eslint-disable complexity, sonarjs/cognitive-complexity */');
  const judge = countingJudge();
  const report = reviewProposal(proposal([{ name: 'node_modules/evil.ts', bytes }]), judge.harness);
  assertZeroDollars(report, judge.calls);
  const gate = report.gates.find((item) => item.gate === 'eslint' && item.script === 'node_modules/evil.ts');
  assert.ok(gate);
  assert.equal(gate.status, 'fail');
  assert.equal(gate.detail.includes(`Maximum allowed is ${String(max)}`), true);
});

void test('a missing proposal path containing okf_version is a clean refusal', () => {
  const parent = mkdtempSync(join(tmpdir(), 'b5-missing-'));
  const missing = join(parent, 'okf_version-nonexistent');
  try {
    const result = spawnSync(process.execPath, [BIN, 'evolve', '--pre-reject', '--skill', 'rollout', '--proposal', missing], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.equal(`${result.stdout ?? ''}${result.stderr ?? ''}`.includes('okf_version'), false);
    const report = JSON.parse(result.stdout ?? '') as HygieneReport;
    assert.equal(report.decision, 'pre-reject');
    assert.equal(report.judgeInvocations, 0);
    assert.equal(report.costUsd, 0);
    assert.equal(report.gates.some((item) => item.gate === 'unsafe-path' && item.detail === 'proposal path refused'), true);
    assert.equal(JSON.stringify(report).includes(missing), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

void test('a non-directory proposal path containing okf_version is a clean refusal', () => {
  const parent = mkdtempSync(join(tmpdir(), 'b5-notdir-'));
  const file = join(parent, 'okf_version-not-a-directory');
  writeFileSync(file, 'not a proposal directory\n');
  try {
    const result = spawnSync(process.execPath, [BIN, 'evolve', '--pre-reject', '--skill', 'rollout', '--proposal', file], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.equal(`${result.stdout ?? ''}${result.stderr ?? ''}`.includes('okf_version'), false);
    const report = JSON.parse(result.stdout ?? '') as HygieneReport;
    assert.equal(report.decision, 'pre-reject');
    assert.equal(report.judgeInvocations, 0);
    assert.equal(report.gates.some((item) => item.gate === 'unsafe-path' && item.detail === 'proposal path refused'), true);
    assert.equal(JSON.stringify(report).includes(file), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

void test('a symlinked proposal path containing okf_version is a clean refusal', () => {
  const parent = mkdtempSync(join(tmpdir(), 'b5-dirlink-'));
  const target = join(parent, 'real');
  const link = join(parent, 'okf_version-link');
  mkdirSync(target);
  writeFileSync(join(target, 'SKILL.md'), '---\nokf_version: "0.3"\nname: rollout\ndescription: a skill\n---\n');
  writeFileSync(join(target, 'clean.ts'), 'export function clean(n: number): number {\n  return n + 1;\n}\n');
  symlinkSync(target, link);
  try {
    const result = spawnSync(process.execPath, [BIN, 'evolve', '--pre-reject', '--skill', 'rollout', '--proposal', link], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.equal(`${result.stdout ?? ''}${result.stderr ?? ''}`.includes('okf_version'), false);
    const report = JSON.parse(result.stdout ?? '') as HygieneReport;
    assert.equal(report.decision, 'pre-reject');
    assert.equal(report.judgeInvocations, 0);
    assert.equal(report.gates.some((item) => item.gate === 'unsafe-path' && item.detail === 'proposal path refused'), true);
    assert.equal(JSON.stringify(report).includes(link), false);
    assert.equal(readFileSync(join(target, 'clean.ts'), 'utf8'), 'export function clean(n: number): number {\n  return n + 1;\n}\n');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

void test('advisory frontmatter does not leak okf_version from a proposal path and does not block', () => {
  const parent = mkdtempSync(join(tmpdir(), 'b5-front-'));
  const dir = join(parent, 'okf_version');
  mkdirSync(dir);
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: rollout\nokf_version: "0.3"\n---\n# body\n');
  writeFileSync(join(dir, 'clean.ts'), 'export function clean(n: number): number {\n  return n + 1;\n}\n');
  try {
    const result = spawnSync(process.execPath, [BIN, 'evolve', '--pre-reject', '--skill', 'rollout', '--proposal', dir], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.equal(`${result.stdout ?? ''}${result.stderr ?? ''}`.includes('okf_version'), false);
    const report = JSON.parse(result.stdout ?? '') as HygieneReport;
    assert.equal(report.decision, 'proceed');
    assert.equal(report.judgeInvocations, 1);
    assert.equal(report.findings.some((item) => item.code === 'okf_frontmatter' && item.detail.includes('description')), true);
    assert.equal(report.findings.every((item) => item.path === 'SKILL.md'), true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

void test('a symlinked proposal script is refused before the judge reads it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'b5-link-'));
  const outside = mkdtempSync(join(tmpdir(), 'b5-outside-'));
  try {
    writeFileSync(join(outside, 'secret.ts'), 'export const secret = 1;\n');
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: rollout\ndescription: a skill\n---\n');
    symlinkSync(join(outside, 'secret.ts'), join(dir, 'secret.ts'));
    const result = spawnSync(process.execPath, [BIN, 'evolve', '--pre-reject', '--skill', 'rollout', '--proposal', dir], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.equal((result.stdout ?? '').includes('okf_version'), false);
    const report = JSON.parse(result.stdout ?? '') as HygieneReport;
    assert.equal(report.judgeInvocations, 0);
    assert.equal(report.costUsd, 0);
    assert.equal(readFileSync(join(outside, 'secret.ts'), 'utf8'), 'export const secret = 1;\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
