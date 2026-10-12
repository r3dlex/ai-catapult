/**
 * Upstream overlay flow (tswc-ac-b4).
 *
 * Accept publishes one accepted overlay as a single-skill commit on a local
 * stub SSOT, then bumps the caller-supplied skills.lock.json SHA, revendors
 * that SHA, and rebuilds host payloads through resolveBundledSkills. The
 * package lock and vendor/ are not this module's files. Reject drops the
 * overlay, leaves the wiki untouched, and does not write upstream. A lock SHA
 * that does not match the vendored checkout is refused before any payload
 * rewrite. Consumed worktree bytes are compared to the locked Git object;
 * an index flag that hides an edit is not trusted. This module never pushes
 * and never calls gh.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { dropFileHere, enterDirectory, entryKind, readFileHere, withBoundRoot } from './containment.ts';
import { sha256Hex } from './digest.ts';
import { EvolveError } from './errors.ts';
import { EVOLVE_DIR } from './layout.ts';
import { SKILL_NAME_PATTERN } from './proposals.ts';
import { moduleDir, packageRoot } from '../paths.ts';
import { resolveBundledSkills } from '../skill-resolver.ts';

const HOSTS = ['claude-code', 'codex', 'opencode'] as const;
const BUILDERS = ['build-claude-plugin.ts', 'build-codex-plugin.ts', 'build-opencode-plugin.ts'] as const;
const REAL_SKILLS = ['github.com/r3dlex/skills', 'github.com:r3dlex/skills'];

export interface UpstreamFlowRequest {
  readonly decision: 'accept' | 'reject';
  readonly lockFile: string;
  readonly payloadRoot: string;
  readonly repoRoot: string;
  readonly root: string;
  readonly skill: string;
  readonly upstreamDir: string;
  readonly vendorDir: string;
}

export interface UpstreamPullRequest {
  readonly branch: string;
  readonly files: readonly string[];
  readonly number: number;
}

export interface UpstreamFlowReport {
  readonly code: string | null;
  readonly decision: 'accept' | 'reject' | 'refused';
  readonly overlayDropped: boolean;
  readonly pullRequest: UpstreamPullRequest | null;
  readonly skillFiles: readonly string[];
  readonly upstreamWrites: number;
}

export interface RebuildRequest {
  readonly lockFile: string;
  readonly payloadRoot: string;
  readonly repoRoot: string;
  readonly vendorDir: string;
}

interface AcceptedOverlay {
  readonly bytes: string;
  readonly sha: string;
}

interface CatalogSkill {
  readonly name?: unknown;
  readonly source_path?: unknown;
}

export function flowUpstream(request: UpstreamFlowRequest): UpstreamFlowReport {
  assertSkill(request.skill);
  if (request.decision === 'reject') return rejectOverlay(request.root, request.skill);
  return acceptOverlay(request);
}

export function verifyHandoff(lockFile: string, vendorDir: string): void {
  const locked = lockSha(lockFile);
  const sentinel = sentinelSha(vendorDir);
  const head = gitSha(vendorDir);
  if (locked !== sentinel || locked !== head || !vendorBytesMatch(vendorDir)) {
    throw new EvolveError('schema-violation', 'handoff_sha_mismatch');
  }
}

export function rebuildPayloads(request: RebuildRequest): void {
  verifyHandoff(request.lockFile, request.vendorDir);
  const vendorRoot = dirname(request.vendorDir);
  for (const script of BUILDERS) {
    runBuilder(request.repoRoot, script, vendorRoot, request.payloadRoot);
  }
  writeParity(request.payloadRoot);
}

export function runUpstreamCli(argv: readonly string[]): number {
  if (argv.includes('--verify-handoff')) return verifyCli(argv);
  const parsed = parseFlow(argv);
  if (parsed === null) return 1;
  try {
    const report = flowUpstream(parsed);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return report.decision === 'refused' ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'upstream failed'}\n`);
    return 1;
  }
}

function acceptOverlay(request: UpstreamFlowRequest): UpstreamFlowReport {
  const refused = refuseBeforeWrite(request);
  if (refused !== null) return refused;
  const accepted = requireAccepted(request.root, request.skill);
  if (accepted === null) return refusedReport('overlay_unaccepted');
  const source = singleSkillPath(request.upstreamDir, request.skill);
  if (typeof source !== 'string') return refusedReport(source.code);
  const preview = previewPayload(request.upstreamDir, source, accepted.bytes);
  if (preview !== null) return refusedReport(preview);
  return publishAccepted(request, source, accepted.bytes);
}

function refuseBeforeWrite(request: UpstreamFlowRequest): UpstreamFlowReport | null {
  if (realSkillsRemote(request.upstreamDir)) return refusedReport('upstream_refused');
  if (!cleanMain(request.upstreamDir)) return refusedReport('upstream_refused');
  if (isSymlink(request.lockFile) || isSymlink(request.vendorDir)) return refusedReport('upstream_refused');
  if (!lockPinsUpstream(request.lockFile, request.upstreamDir)) return refusedReport('handoff_sha_mismatch');
  return null;
}

function publishAccepted(request: UpstreamFlowRequest, source: string, bytes: string): UpstreamFlowReport {
  const beforeSha = gitSha(request.upstreamDir);
  const before = commitCount(request.upstreamDir);
  const previous = readFileSync(request.lockFile, 'utf8');
  const published = commitSkill(request.upstreamDir, request.skill, source, bytes);
  if (published.code !== null) return refusedReport(published.code);
  const vendorAside = takeAside(request.vendorDir);
  const payloadAside = takeAside(request.payloadRoot);
  try {
    const sha = mergeSkill(request.upstreamDir, published.branch);
    bumpLock(request.lockFile, sha);
    revendor(request.upstreamDir, request.vendorDir, sha);
    rebuildPayloads({
      lockFile: request.lockFile,
      payloadRoot: request.payloadRoot,
      repoRoot: request.repoRoot,
      vendorDir: request.vendorDir,
    });
    discard(vendorAside);
    discard(payloadAside);
  } catch (error) {
    restore(request.lockFile, previous);
    resetUpstream(request.upstreamDir, beforeSha, published.branch);
    putBack(request.vendorDir, vendorAside);
    putBack(request.payloadRoot, payloadAside);
    return refusedReport(codeOf(error));
  }
  return {
    code: null,
    decision: 'accept',
    overlayDropped: false,
    pullRequest: { branch: published.branch, files: published.files, number: 1 },
    skillFiles: published.files,
    upstreamWrites: commitCount(request.upstreamDir) - before,
  };
}

function rejectOverlay(root: string, skill: string): UpstreamFlowReport {
  return {
    code: null,
    decision: 'reject',
    overlayDropped: dropOverlay(root, skill),
    pullRequest: null,
    skillFiles: [],
    upstreamWrites: 0,
  };
}

function refusedReport(code: string): UpstreamFlowReport {
  return { code, decision: 'refused', overlayDropped: false, pullRequest: null, skillFiles: [], upstreamWrites: 0 };
}

function requireAccepted(root: string, skill: string): AcceptedOverlay | null {
  const accepted = latestAccepted(root, skill);
  if (accepted === null) return null;
  const staged = proposalBytes(root, skill);
  if (staged !== null && staged !== accepted.bytes) return null;
  return accepted;
}

function latestAccepted(root: string, skill: string): AcceptedOverlay | null {
  const dir = join(root, EVOLVE_DIR, 'raw', 'state');
  if (!existsSync(dir)) return null;
  let best: { bytes: string; k: number } | null = null;
  for (const name of readdirSync(dir)) {
    const parsed = acceptedSlot(dir, name, skill);
    if (parsed !== null && (best === null || parsed.k > best.k)) best = parsed;
  }
  if (best === null) return null;
  return { bytes: best.bytes, sha: sha256Hex(Buffer.from(best.bytes, 'utf8')) };
}

function acceptedSlot(dir: string, name: string, skill: string): { bytes: string; k: number } | null {
  const k = kFrom(skill, name);
  if (k === null) return null;
  const text = readRegular(join(dir, name));
  const bytes = readRegular(join(dir, `accepted-${skill}-${String(k)}.overlay`));
  if (text === null || bytes === null) return null;
  const fields = parseObject(text);
  if (fields === null || fields['overlay_sha256'] !== sha256Hex(Buffer.from(bytes, 'utf8'))) return null;
  return { bytes, k };
}

function kFrom(skill: string, name: string): number | null {
  const prefix = `accepted-${skill}-`;
  if (!name.startsWith(prefix) || !name.endsWith('.json')) return null;
  const digits = name.slice(prefix.length, -'.json'.length);
  if (!/^[1-9][0-9]*$/.test(digits)) return null;
  return Number(digits);
}

function proposalBytes(root: string, skill: string): string | null {
  return withBoundRoot(root, (anchor) => {
    enterDirectory('proposals', enterDirectory(EVOLVE_DIR, anchor));
    const name = `${skill}.overlay`;
    if (entryKind(name) !== 'file') return null;
    return readFileHere(name).toString('utf8');
  });
}

function dropOverlay(root: string, skill: string): boolean {
  return withBoundRoot(root, (anchor) => {
    enterDirectory('proposals', enterDirectory(EVOLVE_DIR, anchor));
    const name = `${skill}.overlay`;
    if (entryKind(name) !== 'file') return false;
    dropFileHere(name);
    return true;
  });
}

function singleSkillPath(upstreamDir: string, skill: string): string | { code: string } {
  const catalog = readCatalog(upstreamDir);
  if (catalog === null) return { code: 'overlay_unaccepted' };
  const matches = catalog.filter((entry) => entry.name === skill);
  if (matches.length !== 1) return { code: 'not_single_skill' };
  const source = safeSource(matches[0]?.source_path);
  if (source === null) return { code: 'not_single_skill' };
  if (sourceCount(catalog, source) !== 1) return { code: 'not_single_skill' };
  const others = catalog
    .map((entry) => safeSource(entry.source_path))
    .filter((path): path is string => path !== null && path !== source);
  if (overlaps(source, others)) return { code: 'not_single_skill' };
  return source;
}

function previewPayload(upstreamDir: string, source: string, bytes: string): string | null {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'b4-preview-')));
  try {
    cpSync(upstreamDir, temp, { recursive: true, filter: (path) => !path.split(sep).includes('.git') });
    mkdirSync(join(temp, source), { recursive: true });
    writeFileSync(join(temp, source, 'SKILL.md'), bytes);
    for (const host of HOSTS) resolveBundledSkills(temp, { host });
    return null;
  } catch {
    return 'payload_unresolved';
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function commitSkill(
  upstreamDir: string,
  skill: string,
  source: string,
  bytes: string,
): { branch: string; code: string | null; files: readonly string[] } {
  const relative = `${source}/SKILL.md`;
  const branch = `evolve/${skill}/${sha256Hex(Buffer.from(bytes, 'utf8')).slice(0, 12)}`;
  gitOrThrow(upstreamDir, ['checkout', '-q', '-b', branch]);
  mkdirSync(dirname(join(upstreamDir, relative)), { recursive: true });
  writeFileSync(join(upstreamDir, relative), bytes);
  gitOrThrow(upstreamDir, ['add', '--', relative]);
  const staged = gitText(upstreamDir, ['diff', '--cached', '--name-only']);
  if (staged !== relative) {
    abortBranch(upstreamDir, branch);
    return { branch, code: 'not_single_skill', files: [] };
  }
  gitOrThrow(upstreamDir, ['commit', '-q', '-m', `evolve: ${skill}`]);
  const files = gitText(upstreamDir, ['diff', '--name-only', `main...${branch}`]).split('\n').filter(Boolean);
  if (files.length !== 1 || files[0] !== relative) {
    abortBranch(upstreamDir, branch);
    return { branch, code: 'not_single_skill', files: [] };
  }
  return { branch, code: null, files };
}

function mergeSkill(upstreamDir: string, branch: string): string {
  gitOrThrow(upstreamDir, ['checkout', '-q', 'main']);
  gitOrThrow(upstreamDir, ['merge', '--ff-only', branch]);
  return gitSha(upstreamDir);
}

function abortBranch(upstreamDir: string, branch: string): void {
  gitOrThrow(upstreamDir, ['checkout', '-q', 'main']);
  gitOrThrow(upstreamDir, ['branch', '-D', branch]);
}

function resetUpstream(upstreamDir: string, sha: string, branch: string): void {
  gitOrThrow(upstreamDir, ['checkout', '-q', 'main']);
  gitOrThrow(upstreamDir, ['reset', '--hard', sha]);
  gitOrThrow(upstreamDir, ['branch', '-D', branch]);
}

function bumpLock(file: string, sha: string): void {
  const previous = readFileSync(file, 'utf8');
  const next = replaceSha(previous, sha);
  const temp = `${file}.tmp`;
  writeFileSync(temp, next);
  renameSync(temp, file);
}

function replaceSha(text: string, sha: string): string {
  const current = lockShaText(text);
  const needle = `"sha": "${current}"`;
  if (!text.includes(needle)) throw new EvolveError('schema-violation', 'lock sha missing');
  const next = text.replace(needle, `"sha": "${sha}"`);
  if (lockShaText(next) !== sha) throw new EvolveError('schema-violation', 'lock bump failed');
  return next;
}

function revendor(upstreamDir: string, vendorDir: string, sha: string): void {
  rmSync(vendorDir, { recursive: true, force: true });
  mkdirSync(vendorDir, { recursive: true });
  gitOrThrow(vendorDir, ['init', '-q']);
  gitOrThrow(vendorDir, ['remote', 'add', 'origin', upstreamDir]);
  gitOrThrow(vendorDir, ['-c', 'protocol.file.allow=always', 'fetch', 'origin', 'main']);
  gitOrThrow(vendorDir, ['checkout', '-q', '--detach', sha]);
  if (gitSha(vendorDir) !== sha) throw new EvolveError('schema-violation', 'handoff_sha_mismatch');
  writeFileSync(join(vendorDir, 'HEAD_SHA'), `${sha}\n`);
}

function runBuilder(repoRoot: string, script: string, vendorRoot: string, payloadRoot: string): void {
  const result = spawnSync(process.execPath, [join(repoRoot, 'scripts', script)], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: builderEnv(vendorRoot, payloadRoot),
    timeout: 60000,
  });
  if (result.status !== 0) {
    throw new EvolveError('schema-violation', `payload rebuild failed: ${script}: ${result.stderr}`);
  }
}

function writeParity(payloadRoot: string): void {
  const body = {
    'omo-ai': 'standalone',
    omc: 'claude-plugin',
    omx: 'codex-plugin',
    opencode: 'commands+skills',
    pluginArray: false,
  };
  mkdirSync(payloadRoot, { recursive: true });
  writeFileSync(join(payloadRoot, 'harness-parity.json'), `${JSON.stringify(body, null, 2)}\n`);
}

function verifyCli(argv: readonly string[]): number {
  const lock = flagValue(argv, '--lock');
  const vendor = flagValue(argv, '--vendor');
  if (lock === null || vendor === null) {
    process.stderr.write('missing --lock or --vendor\n');
    return 1;
  }
  try {
    verifyHandoff(lock, vendor);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'handoff_sha_mismatch'}\n`);
    return 1;
  }
}

function cleanMain(dir: string): boolean {
  return gitText(dir, ['branch', '--show-current']) === 'main' && gitText(dir, ['status', '--porcelain']) === '';
}

function parseFlow(argv: readonly string[]): UpstreamFlowRequest | null {
  const decision = flagValue(argv, '--decision');
  const root = flagValue(argv, '--root');
  const skill = flagValue(argv, '--skill');
  const upstreamDir = flagValue(argv, '--upstream');
  const lockFile = flagValue(argv, '--lock');
  const vendorDir = flagValue(argv, '--vendor');
  const payloadRoot = flagValue(argv, '--payload');
  if (decision !== 'accept' && decision !== 'reject') return missing('decision');
  if (root === null || skill === null || upstreamDir === null) return missing('root, skill, or upstream');
  if (lockFile === null || vendorDir === null || payloadRoot === null) return missing('lock, vendor, or payload');
  const repo = flagValue(argv, '--repo');
  return {
    decision,
    lockFile,
    payloadRoot,
    repoRoot: repo ?? packageRoot(moduleDir(import.meta.url)),
    root,
    skill,
    upstreamDir,
    vendorDir,
  };
}

function missing(name: string): null {
  process.stderr.write(`missing --${name}\n`);
  return null;
}

function realSkillsRemote(dir: string): boolean {
  const listed = gitText(dir, ['remote', '-v']).toLowerCase();
  return REAL_SKILLS.some((needle) => listed.includes(needle));
}

function lockPinsUpstream(lockFile: string, upstreamDir: string): boolean {
  try {
    return lockSha(lockFile) === gitSha(upstreamDir);
  } catch {
    return false;
  }
}

function sourceCount(catalog: readonly CatalogSkill[], source: string): number {
  return catalog.filter((entry) => safeSource(entry.source_path) === source).length;
}

function vendorBytesMatch(vendorDir: string): boolean {
  const status = gitText(vendorDir, ['status', '--porcelain', '--untracked-files=all']);
  if (status === '') return false;
  if (!status.split('\n').every((line) => line === '?? HEAD_SHA')) return false;
  // status hides assume-unchanged and skip-worktree edits. Consumed bytes must
  // still equal the locked Git object, and a hiding index flag is itself a refusal.
  return trackedBytesMatchHead(vendorDir) && !indexHidesWorktree(vendorDir);
}

function trackedBytesMatchHead(vendorDir: string): boolean {
  const format = gitResult(vendorDir, ['rev-parse', '--show-object-format']);
  const algorithm = format.status === 0 ? format.stdout.trim() : '';
  if (algorithm !== 'sha1' && algorithm !== 'sha256') return false;
  const tree = gitResult(vendorDir, ['ls-tree', '-r', '-z', 'HEAD']);
  if (tree.status !== 0) return false;
  const entries = tree.stdout.split('\0').filter((entry) => entry.length > 0);
  if (entries.length === 0) return false;
  for (const entry of entries) {
    const parsed = treeEntry(entry);
    if (parsed === null) return false;
    if (worktreeBlobSha(vendorDir, parsed.path, algorithm) !== parsed.sha) return false;
  }
  return true;
}

function treeEntry(entry: string): { path: string; sha: string } | null {
  const tab = entry.indexOf('\t');
  if (tab < 0) return null;
  const meta = entry.slice(0, tab).split(' ');
  const path = entry.slice(tab + 1);
  const sha = meta[2];
  if (meta[1] !== 'blob' || sha === undefined || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha) || path.length === 0) return null;
  return { path, sha };
}

function worktreeBlobSha(vendorDir: string, relative: string, algorithm: 'sha1' | 'sha256'): string | null {
  const file = join(vendorDir, relative);
  try {
    if (!lstatSync(file).isFile()) return null;
    const bytes = readFileSync(file);
    return createHash(algorithm).update(`blob ${String(bytes.length)}\0`).update(bytes).digest('hex');
  } catch {
    return null;
  }
}

function indexHidesWorktree(vendorDir: string): boolean {
  const listed = gitResult(vendorDir, ['ls-files', '-v', '-z']);
  if (listed.status !== 0) return true;
  const entries = listed.stdout.split('\0').filter((entry) => entry.length > 0);
  if (entries.length === 0) return true;
  return entries.some((entry) => !entry.startsWith('H '));
}

function takeAside(path: string): string | null {
  if (!existsSync(path)) return null;
  const dest = mkdtempSync(join(tmpdir(), 'b4-aside-'));
  rmSync(dest, { recursive: true, force: true });
  renameSync(path, dest);
  return dest;
}

function putBack(path: string, aside: string | null): void {
  rmSync(path, { recursive: true, force: true });
  if (aside !== null) renameSync(aside, path);
}

function discard(aside: string | null): void {
  if (aside !== null) rmSync(aside, { recursive: true, force: true });
}

function readCatalog(dir: string): CatalogSkill[] | null {
  const text = readRegular(join(dir, 'catalog.json'));
  if (text === null) return null;
  const parsed = parseObject(text);
  const skills = parsed?.['skills'];
  if (!Array.isArray(skills)) return null;
  return skills.filter((entry): entry is CatalogSkill => typeof entry === 'object' && entry !== null);
}

function safeSource(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.startsWith('/') || value.includes('\\') || value.includes('..')) return null;
  if (value.split('/').some((part) => part === '' || part === '.')) return null;
  return value;
}

function overlaps(source: string, others: readonly string[]): boolean {
  return others.some((other) => other.startsWith(`${source}/`) || source.startsWith(`${other}/`));
}

function lockSha(file: string): string {
  return lockShaText(readFileSync(file, 'utf8'));
}

function lockShaText(text: string): string {
  const parsed = parseObject(text);
  const sha = parsed?.['sha'];
  if (typeof sha !== 'string' || !/^[0-9a-f]{40,64}$/.test(sha)) {
    throw new EvolveError('schema-violation', 'handoff_sha_mismatch');
  }
  return sha;
}

function sentinelSha(vendorDir: string): string {
  const file = join(vendorDir, 'HEAD_SHA');
  if (!existsSync(file)) throw new EvolveError('schema-violation', 'handoff_sha_mismatch');
  return readFileSync(file, 'utf8').replace(/\s+/g, '');
}

function gitSha(dir: string): string {
  return gitText(dir, ['rev-parse', 'HEAD']);
}

function commitCount(dir: string): number {
  return Number(gitText(dir, ['rev-list', '--count', 'HEAD']));
}

function gitText(cwd: string, args: readonly string[]): string {
  const result = gitResult(cwd, args);
  if (result.status !== 0) {
    throw new EvolveError('schema-violation', `git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return (result.stdout ?? '').trim();
}

function gitOrThrow(cwd: string, args: readonly string[]): void {
  gitText(cwd, args);
}

function gitResult(cwd: string, args: readonly string[]): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8', env: gitEnv() });
  return { status: result.status, stderr: result.stderr ?? '', stdout: result.stdout ?? '' };
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GH_CONFIG_DIR;
  env.GIT_AUTHOR_NAME = 'ai-catapult-evolve';
  env.GIT_AUTHOR_EMAIL = 'evolve@ai-catapult.invalid';
  env.GIT_COMMITTER_NAME = 'ai-catapult-evolve';
  env.GIT_COMMITTER_EMAIL = 'evolve@ai-catapult.invalid';
  return env;
}

function builderEnv(vendorRoot: string, payloadRoot: string): NodeJS.ProcessEnv {
  const env = gitEnv();
  env.VENDOR_ROOT = vendorRoot;
  env.DIST_ROOT = payloadRoot;
  return env;
}

function flagValue(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  const value = index < 0 ? undefined : argv[index + 1];
  if (value === undefined || value.startsWith('--')) return null;
  return value;
}

function restore(file: string, previous: string): void {
  writeFileSync(file, previous);
}

function codeOf(error: unknown): string {
  if (error instanceof EvolveError && error.message.includes('handoff_sha_mismatch')) return 'handoff_sha_mismatch';
  return 'payload_unresolved';
}

function assertSkill(skill: string): void {
  if (!SKILL_NAME_PATTERN.test(skill)) {
    throw new EvolveError('unsafe-path', `skill name "${skill}" must match ${SKILL_NAME_PATTERN.toString()}`);
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function readRegular(path: string): string | null {
  try {
    if (!lstatSync(path).isFile()) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
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
