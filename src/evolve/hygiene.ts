/**
 * Proposal hygiene (tswc-ac-b5). Structural pre-reject runs before the judge
 * seam. A failing gate, a missing gate tool, an unrecognized script, or an
 * unsafe path returns without invoking the harness, so a gnarly proposal costs
 * zero judge dollars. OKF frontmatter findings are advisory: they never block
 * and the report never carries okf_version.
 *
 * A2 thresholds are loaded from eslint.config.js and strict tsc is the repo
 * tsconfig via extends. A4 commands are the delivered ruff/xenon/shellcheck/shfmt
 * argv from skills freeze-measure.mts at 6255da27. ruff.toml
 * (a8f67d5d2539791a4a464fcbeff2c23a8b3489f3bc9b3a2774d1f220c36c8b84) and the
 * shellcheck rc (6a180a9f928086db7754f5212950524e492ba5ab75236357f8b4c2c1a317ac35)
 * are those delivered bytes. This module does not choose a new threshold.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moduleDir, packageRoot } from '../paths.ts';
import { SKILL_NAME_PATTERN } from './proposals.ts';

const require = createRequire(import.meta.url);

export interface JudgeRequest {
  readonly skill: string;
}

export interface JudgeResult {
  readonly costUsd: number;
}

export interface JudgeHarness {
  invoke(request: JudgeRequest): JudgeResult;
}

export interface ProposedScript {
  readonly name: string;
  readonly bytes: string;
}

export interface SkillProposal {
  readonly skill: string;
  readonly skillMd: string;
  readonly scripts: readonly ProposedScript[];
}

export interface AdvisoryFinding {
  readonly code: 'okf_frontmatter';
  readonly detail: string;
  readonly path: 'SKILL.md';
}

export type GateName = 'eslint' | 'ruff' | 'shellcheck' | 'shfmt' | 'tsc' | 'unrecognized-script' | 'unsafe-path' | 'xenon';

export interface GateResult {
  readonly command: readonly string[];
  readonly detail: string;
  readonly gate: GateName;
  readonly script: string;
  readonly status: 'fail' | 'tool-missing';
}

export interface HygieneReport {
  readonly costUsd: number;
  readonly decision: 'pre-reject' | 'proceed';
  readonly findings: readonly AdvisoryFinding[];
  readonly gates: readonly GateResult[];
  readonly judgeInvocations: number;
}

export interface ReviewOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly repoRoot?: string;
}

interface RulePair {
  readonly cognitive: unknown;
  readonly complexity: unknown;
}

interface ToolRun {
  readonly missing: boolean;
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

interface ScriptGroups {
  readonly js: readonly ProposedScript[];
  readonly py: readonly ProposedScript[];
  readonly sh: readonly ProposedScript[];
  readonly ts: readonly ProposedScript[];
  readonly unknown: readonly ProposedScript[];
}

type LoadedRules = RulePair | 'unreadable';

let cachedRules: { readonly root: string; readonly rules: LoadedRules } | null = null;

export function reviewProposal(proposal: SkillProposal, judge: JudgeHarness, options?: ReviewOptions): HygieneReport {
  const findings = okfFindings(proposal.skillMd);
  const blocked = blockBeforeGates(proposal);
  if (blocked.length > 0) return reject(findings, blocked);
  const gates = runGates(proposal, options);
  if (gates.length > 0) return reject(findings, gates);
  const judged = judge.invoke({ skill: proposal.skill });
  return { costUsd: judged.costUsd, decision: 'proceed', findings, gates: [], judgeInvocations: 1 };
}

export function runPreRejectCli(argv: readonly string[]): number {
  const flags = takeFlags(argv);
  if (flags === null) return 1;
  const skill = flags.get('skill');
  const proposalDir = flags.get('proposal');
  if (skill === undefined || proposalDir === undefined) {
    process.stderr.write('missing --skill or --proposal\n');
    return 1;
  }
  const loaded = loadProposal(proposalDir, skill);
  const report = loaded.kind === 'proposal' ? reviewProposal(loaded.proposal, cliJudge) : loaded.report;
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report.decision === 'pre-reject' ? 1 : 0;
}

const cliJudge: JudgeHarness = {
  invoke() {
    return { costUsd: 0 };
  },
};

function reject(findings: readonly AdvisoryFinding[], gates: readonly GateResult[]): HygieneReport {
  return { costUsd: 0, decision: 'pre-reject', findings, gates, judgeInvocations: 0 };
}

function okfFindings(skillMd: string): AdvisoryFinding[] {
  const front = frontmatter(skillMd);
  const findings: AdvisoryFinding[] = [];
  if (front === null || !present(front, 'name')) findings.push(finding('name missing'));
  if (front === null || !present(front, 'description')) findings.push(finding('description missing'));
  return findings;
}

function finding(detail: string): AdvisoryFinding {
  return { code: 'okf_frontmatter', detail, path: 'SKILL.md' };
}

function frontmatter(text: string): Map<string, string> | null {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---', 4);
  if (end === -1) return null;
  return parseFront(text.slice(4, end));
}

function parseFront(body: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of body.split('\n')) {
    const split = line.indexOf(':');
    if (split === -1) continue;
    const key = line.slice(0, split).trim();
    if (key === '' || key === 'okf_version') continue;
    map.set(key, stripQuotes(line.slice(split + 1).trim()));
  }
  return map;
}

function present(front: Map<string, string>, key: string): boolean {
  const value = front.get(key);
  return value !== undefined && value !== '';
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value;
}

function blockBeforeGates(proposal: SkillProposal): GateResult[] {
  const gates: GateResult[] = [];
  if (!SKILL_NAME_PATTERN.test(proposal.skill)) {
    gates.push(gate('unsafe-path', proposal.skill, 'fail', 'skill name refused', []));
  }
  for (const script of proposal.scripts) {
    if (!safeName(script.name)) gates.push(gate('unsafe-path', script.name, 'fail', 'script path refused', []));
  }
  return gates;
}

function safeName(name: string): boolean {
  if (name === '' || name.startsWith('/') || name.includes('\\') || name.includes('\0')) return false;
  return name.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function runGates(proposal: SkillProposal, options: ReviewOptions | undefined): GateResult[] {
  const root = options?.repoRoot ?? packageRoot(moduleDir(import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'evolve-pre-reject-'));
  try {
    return gatesIn(dir, proposal, root, { ...(options?.env ?? process.env), PYTHONDONTWRITEBYTECODE: '1' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function gatesIn(dir: string, proposal: SkillProposal, root: string, env: NodeJS.ProcessEnv): GateResult[] {
  const groups = groupScripts(proposal.scripts);
  writeScripts(dir, [...groups.ts, ...groups.js, ...groups.py, ...groups.sh]);
  writeConsumed(dir);
  return [
    ...unknownGates(groups.unknown),
    ...typecheck(dir, groups.ts, root, env),
    ...eslintGates([...groups.ts, ...groups.js], root),
    ...pythonGates(dir, groups.py, env),
    ...shellGates(dir, groups.sh, env),
  ];
}

function groupScripts(scripts: readonly ProposedScript[]): ScriptGroups {
  const groups: { js: ProposedScript[]; py: ProposedScript[]; sh: ProposedScript[]; ts: ProposedScript[]; unknown: ProposedScript[] } = {
    js: [], py: [], sh: [], ts: [], unknown: [],
  };
  for (const script of scripts) groups[scriptKind(script.name)].push(script);
  return groups;
}

const SCRIPT_KIND: ReadonlyArray<readonly [string, keyof ScriptGroups]> = [
  ['.tsx', 'ts'],
  ['.mts', 'ts'],
  ['.cts', 'ts'],
  ['.ts', 'ts'],
  ['.mjs', 'js'],
  ['.cjs', 'js'],
  ['.js', 'js'],
  ['.py', 'py'],
  ['.bash', 'sh'],
  ['.sh', 'sh'],
];

function scriptKind(name: string): keyof ScriptGroups {
  const found = SCRIPT_KIND.find(([suffix]) => name.endsWith(suffix));
  return found?.[1] ?? 'unknown';
}

function writeScripts(dir: string, scripts: readonly ProposedScript[]): void {
  for (const script of scripts) {
    const target = join(dir, script.name);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, script.bytes);
  }
}

function writeConsumed(dir: string): void {
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(dir, 'ruff.toml'), readFileSync(consumedFile('ruff.toml')));
  writeFileSync(join(dir, '.shellcheckrc'), readFileSync(consumedFile('shellcheckrc')));
}

function consumedFile(name: string): string {
  const beside = join(moduleDir(import.meta.url), 'consumed', name);
  if (existsSync(beside)) return beside;
  return join(packageRoot(moduleDir(import.meta.url)), 'src/evolve/consumed', name);
}

function unknownGates(scripts: readonly ProposedScript[]): GateResult[] {
  return scripts.map((script) => gate('unrecognized-script', script.name, 'fail', 'script language is not a consumed gate', []));
}

function typecheck(dir: string, scripts: readonly ProposedScript[], root: string, env: NodeJS.ProcessEnv): GateResult[] {
  if (scripts.length === 0) return [];
  const names = scripts.map((script) => script.name);
  const config = join(dir, 'tsconfig.json');
  writeFileSync(config, JSON.stringify({
    extends: join(root, 'tsconfig.json'),
    include: names,
    compilerOptions: { noEmit: true, typeRoots: [join(root, 'node_modules/@types')], types: ['node'] },
  }));
  const tsc = join(root, 'node_modules/typescript/lib/tsc.js');
  const command = [process.execPath, tsc, '-p', config, '--pretty', 'false', '--incremental', 'false'];
  const ran = runTool(command, dir, env);
  if (ran.missing || ran.status === 0) return ran.missing ? names.map((name) => gate('tsc', name, 'tool-missing', 'tsc missing', command)) : [];
  const output = `${ran.stdout}\n${ran.stderr}`;
  const hit = names.filter((name) => output.includes(name));
  const targets = hit.length > 0 ? hit : names;
  return targets.map((name) => gate('tsc', name, 'fail', firstLine(output), command));
}

interface TextLinter {
  verify(code: string, config: unknown, options: { filename: string }): Array<{ message: string; severity: number }>;
}

function eslintGates(scripts: readonly ProposedScript[], root: string): GateResult[] {
  if (scripts.length === 0) return [];
  const rules = loadA2Rules(root);
  if (rules === 'unreadable') {
    return scripts.map((script) => gate('eslint', script.name, 'fail', 'delivered eslint config unreadable', ['eslint', '--config', 'eslint.config.js']));
  }
  const { Linter } = require('eslint') as { Linter: new (options: { configType: 'flat' }) => TextLinter };
  const linter = new Linter({ configType: 'flat' });
  const config: unknown = [{
    files: ['**/*.ts', '**/*.mts', '**/*.cts', '**/*.tsx', '**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      parser: require('@typescript-eslint/parser') as unknown,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    plugins: { sonarjs: require('eslint-plugin-sonarjs') as unknown },
    rules: { complexity: rules.complexity, 'sonarjs/cognitive-complexity': rules.cognitive },
  }];
  return scripts.flatMap((script) => eslintOne(linter, config, script));
}

function eslintOne(linter: TextLinter, config: unknown, script: ProposedScript): GateResult[] {
  const messages = linter.verify(script.bytes, config, { filename: script.name });
  const errors = messages.filter((message) => message.severity === 2);
  if (errors.length === 0) return [];
  const detail = errors.map((message) => message.message).join('; ');
  return [gate('eslint', script.name, 'fail', detail, ['eslint', '--config', 'eslint.config.js'])];
}

function loadA2Rules(root: string): LoadedRules {
  if (cachedRules?.root === root) return cachedRules.rules;
  const rules = readA2Rules(root);
  cachedRules = { root, rules };
  return rules;
}

function readA2Rules(root: string): LoadedRules {
  const script = [
    "import { pathToFileURL } from 'node:url';",
    'const loaded = await import(pathToFileURL(process.env.EVOLVE_ESLINT_CONFIG).href);',
    'let complexity, cognitive;',
    'for (const block of loaded.default) {',
    '  const rules = block.rules ?? {};',
    "  if (rules.complexity) complexity = rules.complexity;",
    "  if (rules['sonarjs/cognitive-complexity']) cognitive = rules['sonarjs/cognitive-complexity'];",
    '}',
    'if (!Array.isArray(complexity) || !Array.isArray(cognitive)) process.exit(2);',
    'process.stdout.write(JSON.stringify({ complexity, cognitive }));',
  ].join('\n');
  const ran = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, EVOLVE_ESLINT_CONFIG: join(root, 'eslint.config.js') },
  });
  if (ran.status !== 0) return 'unreadable';
  return JSON.parse(ran.stdout ?? '') as RulePair;
}

function pythonGates(dir: string, scripts: readonly ProposedScript[], env: NodeJS.ProcessEnv): GateResult[] {
  if (scripts.length === 0) return [];
  const names = scripts.map((script) => script.name);
  return [...ruffGate(dir, names, env), ...xenonGate(dir, names, env)];
}

function ruffGate(dir: string, names: readonly string[], env: NodeJS.ProcessEnv): GateResult[] {
  const command = ['ruff', 'check', '--no-cache', '--config', 'ruff.toml', '--output-format', 'json', ...names];
  return toolGates('ruff', dir, names, command, env);
}

function xenonGate(dir: string, names: readonly string[], env: NodeJS.ProcessEnv): GateResult[] {
  const command = ['xenon', '--max-absolute', 'B', '--max-average', 'A', ...names];
  return toolGates('xenon', dir, names, command, env);
}

function shellGates(dir: string, scripts: readonly ProposedScript[], env: NodeJS.ProcessEnv): GateResult[] {
  const gates: GateResult[] = [];
  for (const script of scripts) {
    gates.push(...toolGates('shellcheck', dir, [script.name], ['shellcheck', '-S', 'error', '-f', 'json', script.name], env));
    gates.push(...toolGates('shfmt', dir, [script.name], ['shfmt', '-d', script.name], env));
  }
  return gates;
}

function toolGates(name: GateName, dir: string, scripts: readonly string[], command: readonly string[], env: NodeJS.ProcessEnv): GateResult[] {
  const ran = runTool(command, dir, env);
  if (ran.missing) return scripts.map((script) => gate(name, script, 'tool-missing', `${name} missing`, command));
  if (ran.status === 0) return [];
  const output = `${ran.stdout}\n${ran.stderr}`;
  const hit = scripts.filter((script) => output.includes(script));
  const targets = hit.length > 0 ? hit : scripts;
  return targets.map((script) => gate(name, script, 'fail', firstLine(output), command));
}

function runTool(command: readonly string[], cwd: string, env: NodeJS.ProcessEnv): ToolRun {
  const [bin, ...args] = command;
  if (bin === undefined) return { missing: true, status: null, stderr: '', stdout: '' };
  const ran = spawnSync(bin, args, { cwd, encoding: 'utf8', env });
  const missing = ran.error !== undefined && 'code' in ran.error && ran.error.code === 'ENOENT';
  return { missing, status: ran.status, stderr: ran.stderr ?? '', stdout: ran.stdout ?? '' };
}

function gate(name: GateName, script: string, status: GateResult['status'], detail: string, command: readonly string[]): GateResult {
  return { command, detail: detail.slice(0, 500), gate: name, script, status };
}

function firstLine(text: string): string {
  const line = text.split('\n').find((item) => item.trim() !== '');
  return line?.trim() ?? 'gate failed';
}

function takeFlags(argv: readonly string[]): Map<string, string> | null {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith('--') || token === '--') {
      process.stderr.write(`Unknown argument: ${token ?? ''}\n`);
      return null;
    }
    const name = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      process.stderr.write(`missing --${name}\n`);
      return null;
    }
    flags.set(name, value);
    index += 1;
  }
  return flags;
}

function loadProposal(dir: string, skill: string): { kind: 'proposal'; proposal: SkillProposal } | { kind: 'report'; report: HygieneReport } {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'proposal missing';
    return { kind: 'report', report: reject([], [gate('unsafe-path', dir, 'fail', message, [])]) };
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return { kind: 'report', report: reject([], [gate('unsafe-path', dir, 'fail', 'proposal path refused', [])]) };
  }
  const walked = walkProposal(dir);
  if (typeof walked === 'string') {
    return { kind: 'report', report: reject(okfFindings(''), [gate('unsafe-path', walked, 'fail', 'symlink refused before read', [])]) };
  }
  return { kind: 'proposal', proposal: { skill, skillMd: walked.skillMd, scripts: walked.scripts } };
}

function walkProposal(dir: string): { skillMd: string; scripts: ProposedScript[] } | string {
  const skillMd = readRegular(dir, 'SKILL.md');
  if (!skillMd.ok) return skillMd.path;
  const scripts: ProposedScript[] = [];
  const nested = walkDir(dir, '', scripts);
  if (nested !== null) return nested;
  return { skillMd: skillMd.text, scripts };
}

function readRegular(dir: string, name: string): { ok: true; text: string } | { ok: false; path: string } {
  const target = join(dir, name);
  if (!existsSync(target)) return { ok: true, text: '' };
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) return { ok: false, path: name };
  return { ok: true, text: readFileSync(target, 'utf8') };
}

function walkDir(dir: string, prefix: string, scripts: ProposedScript[]): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const refused = walkEntry(dir, prefix, entry, scripts);
    if (refused !== null) return refused;
  }
  return null;
}

function walkEntry(dir: string, prefix: string, entry: Dirent, scripts: ProposedScript[]): string | null {
  const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
  if (entry.isSymbolicLink()) return rel;
  if (entry.isDirectory()) return walkDir(join(dir, entry.name), rel, scripts);
  if (!entry.isFile() || rel === 'SKILL.md') return rel === 'SKILL.md' ? null : rel;
  scripts.push({ name: rel, bytes: readFileSync(join(dir, entry.name), 'utf8') });
  return null;
}
