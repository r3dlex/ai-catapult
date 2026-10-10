/**
 * The evolve/ three-layer workspace (AC-1) — deterministic CLI machinery over
 * the WikiSkill master-intake §3a layout:
 *
 *   evolve/raw/<run-id>/   write-once immutable traces (turn traces, judgment records)
 *   evolve/wiki/           append-only logs.md + skill-impact.md — never rolled back
 *   evolve/proposals/      overlay staging (starts empty; entries are drift)
 *   evolve/PURPOSE.md      the PURPOSE.md convention, pinned byte-exactly
 *
 * initEvolveLayout() is idempotent and fail-closed: it creates exactly the
 * golden shape, refuses to bless a mutated PURPOSE.md, and never rewrites
 * existing bytes. verifyEvolveLayout() reports every deviation from the shape
 * as a {path, reason} violation, with paths relative to the evolve/ directory.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { EvolveError } from './errors.ts';

export const EVOLVE_DIR = 'evolve';

/** Run ids are filesystem segments: lowercase ascii letters, digits and hyphens. */
export const RUN_ID_PATTERN = /^[a-z0-9-]+$/;

const PURPOSE_FILE_NAME = 'PURPOSE.md';
const TOP_LEVEL_DIRS = ['raw', 'wiki', 'proposals'] as const;
const WIKI_FILE_NAMES = ['logs.md', 'skill-impact.md'] as const;

/** The pinned PURPOSE.md bytes; the layout verifier hashes against this text. */
export const PURPOSE_TEXT = [
  '# evolve workspace — purpose',
  '',
  'This directory is the WikiSkill three-layer evolution workspace (master',
  'intake §3a), implemented as deterministic CLI machinery:',
  '',
  '- raw/',
  '    Write-once immutable traces, one directory per run id, holding turn',
  '    traces and §5.4 judgment records. The first write to a path wins; any',
  '    second write is refused, even with identical bytes.',
  '- wiki/',
  '    Append-only learning state: logs.md (the run log) and skill-impact.md',
  '    (the skill audit trail). Entries may extend these files; truncating,',
  '    rewriting or prepending is refused. Nothing is ever rolled back.',
  '- proposals/',
  '    Staging for single-skill overlay proposals awaiting judgment. Starts',
  '    empty; layout verification treats every entry here as drift.',
  '',
  'PURPOSE.md is pinned byte-exactly: initEvolveLayout() refuses to bless a',
  'mutated copy and verifyEvolveLayout() reports any deviation from this',
  'three-layer shape as a {path, reason} violation, with paths relative to',
  'the evolve/ workspace directory.',
  '',
].join('\n');

export interface EvolvePaths {
  readonly root: string;
  readonly evolveDir: string;
  readonly rawDir: string;
  readonly wikiDir: string;
  readonly proposalsDir: string;
  readonly purposeFile: string;
  readonly wikiLogsFile: string;
  readonly wikiSkillImpactFile: string;
}

export function evolvePaths(root: string): EvolvePaths {
  const evolveDir = join(root, EVOLVE_DIR);
  return {
    root,
    evolveDir,
    rawDir: join(evolveDir, 'raw'),
    wikiDir: join(evolveDir, 'wiki'),
    proposalsDir: join(evolveDir, 'proposals'),
    purposeFile: join(evolveDir, PURPOSE_FILE_NAME),
    wikiLogsFile: join(evolveDir, 'wiki', 'logs.md'),
    wikiSkillImpactFile: join(evolveDir, 'wiki', 'skill-impact.md'),
  };
}

export interface EvolveInitResult {
  /** Workspace-relative paths this init created; empty on an idempotent re-run. */
  readonly created: readonly string[];
  readonly existed: boolean;
}

export function initEvolveLayout(root: string): EvolveInitResult {
  const paths = evolvePaths(root);
  const existed = existsSync(paths.evolveDir);
  const created: string[] = [];
  mkdirSync(paths.evolveDir, { recursive: true });
  ensurePurposeFile(paths, created);
  for (const dir of TOP_LEVEL_DIRS) {
    const target = join(paths.evolveDir, dir);
    if (!existsSync(target)) {
      mkdirSync(target);
      created.push(dir);
    }
  }
  for (const name of WIKI_FILE_NAMES) {
    const target = join(paths.wikiDir, name);
    if (!existsSync(target)) {
      writeFileSync(target, '', 'utf8');
      created.push(`wiki/${name}`);
    }
  }
  return { created: created.sort(), existed };
}

function ensurePurposeFile(paths: EvolvePaths, created: string[]): void {
  if (existsSync(paths.purposeFile)) {
    if (!readFileSync(paths.purposeFile).equals(Buffer.from(PURPOSE_TEXT, 'utf8'))) {
      throw new EvolveError(
        'layout-violation',
        'PURPOSE.md exists but its bytes differ from the pinned purpose text; init never blesses a mutated workspace',
      );
    }
    return;
  }
  writeFileSync(paths.purposeFile, PURPOSE_TEXT, 'utf8');
  created.push(PURPOSE_FILE_NAME);
}

export interface EvolveLayoutViolation {
  /** Path of the drifted entry, relative to the evolve/ workspace directory. */
  readonly path: string;
  readonly reason: string;
}

export interface EvolveVerification {
  readonly ok: boolean;
  readonly violations: readonly EvolveLayoutViolation[];
}

export function verifyEvolveLayout(root: string): EvolveVerification {
  const violations = evolveDrift(evolvePaths(root));
  return { ok: violations.length === 0, violations };
}

function evolveDrift(paths: EvolvePaths): EvolveLayoutViolation[] {
  if (!isDirectory(paths.evolveDir)) {
    return [{ path: '', reason: 'the evolve/ workspace directory is missing' }];
  }
  const violations: EvolveLayoutViolation[] = [];
  checkPurposeBytes(paths, violations);
  checkTopLevelEntries(paths, violations);
  checkWikiEntries(paths, violations);
  checkRawEntries(paths, violations);
  checkProposalsEmpty(paths, violations);
  return violations;
}

function checkPurposeBytes(paths: EvolvePaths, violations: EvolveLayoutViolation[]): void {
  if (!existsSync(paths.purposeFile)) {
    violations.push({ path: PURPOSE_FILE_NAME, reason: 'declared file missing' });
    return;
  }
  if (!readFileSync(paths.purposeFile).equals(Buffer.from(PURPOSE_TEXT, 'utf8'))) {
    violations.push({ path: PURPOSE_FILE_NAME, reason: 'bytes differ from the pinned purpose text' });
  }
}

function checkTopLevelEntries(paths: EvolvePaths, violations: EvolveLayoutViolation[]): void {
  for (const entry of sortedEntries(paths.evolveDir)) {
    if (entry.name === PURPOSE_FILE_NAME) {
      if (!entry.isFile()) {
        violations.push({ path: entry.name, reason: 'PURPOSE.md must be a regular file' });
      }
      continue;
    }
    if ((TOP_LEVEL_DIRS as readonly string[]).includes(entry.name)) {
      if (!entry.isDirectory()) {
        violations.push({ path: entry.name, reason: `expected directory: ${entry.name}` });
      }
      continue;
    }
    violations.push({ path: entry.name, reason: 'stray entry at the evolve/ workspace root' });
  }
}

function checkWikiEntries(paths: EvolvePaths, violations: EvolveLayoutViolation[]): void {
  if (!isDirectory(paths.wikiDir)) {
    violations.push({ path: 'wiki', reason: 'expected directory missing' });
    return;
  }
  const expected = new Set<string>(WIKI_FILE_NAMES);
  for (const entry of sortedEntries(paths.wikiDir)) {
    if (!expected.has(entry.name) || !entry.isFile()) {
      violations.push({
        path: `wiki/${entry.name}`,
        reason: 'wiki/ holds exactly logs.md and skill-impact.md; anything else is not expected layout',
      });
    }
    expected.delete(entry.name);
  }
  for (const name of expected) {
    violations.push({ path: `wiki/${name}`, reason: 'expected wiki file missing' });
  }
}

function checkRawEntries(paths: EvolvePaths, violations: EvolveLayoutViolation[]): void {
  if (!isDirectory(paths.rawDir)) {
    violations.push({ path: 'raw', reason: 'expected directory missing' });
    return;
  }
  for (const entry of sortedEntries(paths.rawDir)) {
    if (!entry.isDirectory() || !RUN_ID_PATTERN.test(entry.name)) {
      violations.push({
        path: `raw/${entry.name}`,
        reason: `raw/ holds only run-id directories matching ${RUN_ID_PATTERN.toString()}`,
      });
    }
  }
}

function checkProposalsEmpty(paths: EvolvePaths, violations: EvolveLayoutViolation[]): void {
  if (!isDirectory(paths.proposalsDir)) {
    violations.push({ path: 'proposals', reason: 'expected directory missing' });
    return;
  }
  for (const entry of sortedEntries(paths.proposalsDir)) {
    violations.push({
      path: `proposals/${entry.name}`,
      reason: 'proposals/ must stay empty until staging takes it over',
    });
  }
}

function sortedEntries(dir: string): Dirent[] {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}
