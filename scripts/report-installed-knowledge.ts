#!/usr/bin/env node
// report-installed-knowledge.ts — XSKP-P4-05 installed lane (report-only).
//
// Resolves the global install at run time from `npm prefix -g` (observed
// /opt/homebrew at planning; never hardcoded): its lib/node_modules/ai-catapult
// package directory and its bin/ai-catapult CLI entry. It runs
//
//   <cli> knowledge --root <temp repo> verify
//
// against a temp repo seeded with the empty knowledge-registry/1 aggregate
// (the bytes the reader's own rebuild emits), and hashes the global install
// directory before and after. It also reports the Claude plugin cache
// (~/.claude/plugins/cache/ai-catapult/) — versions present plus a directory
// hash before and after — without executing it, because the plugin cache
// cannot run the CLI.
//
// Both hashes print MATCH or MISMATCH, neither location is mutated, and the
// whole lane is report-only: nothing gates on it. Exit 0 when both locations
// are unchanged (or absent), 1 when a hash moved, 2 on usage errors.
//
// Usage: node scripts/report-installed-knowledge.ts [--json]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const JSON_MODE = process.argv.includes('--json');

function sha256Bytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Sorted path+sha256 digest of a whole tree; symlinks record their target. */
function digestTree(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const lines: string[] = [];
  const visit = (rel: string): void => {
    const abs = rel === '' ? dir : join(dir, rel);
    const info = lstatSync(abs);
    if (info.isSymbolicLink()) {
      lines.push(`${rel} -> ${readlinkSync(abs)}`);
      return;
    }
    if (info.isDirectory()) {
      for (const name of readdirSync(abs).sort()) visit(rel === '' ? name : `${rel}/${name}`);
      return;
    }
    lines.push(`${rel} ${sha256Bytes(readFileSync(abs))}`);
  };
  visit('');
  return sha256Bytes(Buffer.from(lines.join('\n'), 'utf8'));
}

function prefixOf(): string {
  const result = spawnSync('npm', ['prefix', '-g'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

/** The temp repo the installed CLI verifies: the empty registry its own rebuild emits. */
function seedTempRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'ai-catapult-installed-'));
  mkdirSync(join(repo, '.ai/knowledge/entries'), { recursive: true });
  writeFileSync(join(repo, '.ai/knowledge/registry.json'), `{\n  "entries": [],\n  "generated_from": ".ai/knowledge/entries",\n  "repo_id": "",\n  "schema": "knowledge-registry/1"\n}\n`, 'utf8');
  writeFileSync(join(repo, '.ai/knowledge/entries/.gitkeep'), '', 'utf8');
  return repo;
}

type VerifyRun = { command: string; exit: number; stdout: string; stderr: string; skipped: string | null };

/** Run `knowledge verify` with the installed CLI; never fall back to the repo copy. */
function runInstalledVerify(packageDir: string, cli: string): VerifyRun {
  if (!existsSync(cli)) {
    return { command: cli, exit: -1, stdout: '', stderr: '', skipped: `no CLI entry at ${cli}` };
  }
  const repo = seedTempRepo();
  try {
    const result = spawnSync(cli, ['knowledge', '--root', repo, 'verify'], {
      encoding: 'utf8',
      timeout: 60_000,
      cwd: packageDir,
    });
    return {
      command: `${cli} knowledge --root <temp> verify`,
      exit: result.status ?? -1,
      stdout: result.stdout,
      stderr: result.stderr ?? '',
      skipped: null,
    };
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function versionDirs(cache: string): string[] {
  if (!existsSync(cache)) return [];
  return readdirSync(cache, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

type InstalledReport = {
  schema: string;
  prefix: string;
  package_dir: string;
  cli: string;
  install_hash: { before: string | null; after: string | null; state: string };
  plugin_cache: {
    path: string;
    present: boolean;
    versions: string[];
    hash_before: string | null;
    hash_after: string | null;
    state: string;
  };
  verify: VerifyRun;
};

function collectReport(prefix: string): InstalledReport {
  const packageDir = join(prefix, 'lib/node_modules/ai-catapult');
  const cli = join(prefix, 'bin/ai-catapult');
  const cache = join(homedir(), '.claude/plugins/cache/ai-catapult');
  const installBefore = digestTree(packageDir);
  const cacheBefore = digestTree(cache);
  const verify = runInstalledVerify(packageDir, cli);
  const installAfter = digestTree(packageDir);
  const cacheAfter = digestTree(cache);
  const installState = installBefore !== null && installBefore === installAfter ? 'MATCH' : 'MISMATCH';
  const cacheState = cacheBefore === cacheAfter ? 'MATCH' : 'MISMATCH';
  return {
    schema: 'installed-knowledge-report/1',
    prefix,
    package_dir: packageDir,
    cli,
    install_hash: { before: installBefore, after: installAfter, state: installState },
    plugin_cache: {
      path: cache,
      present: cacheBefore !== null,
      versions: versionDirs(cache),
      hash_before: cacheBefore,
      hash_after: cacheAfter,
      state: cacheState,
    },
    verify,
  };
}

function renderReport(value: InstalledReport): void {
  const versions = value.plugin_cache.versions;
  process.stdout.write(`installed lane: ${value.package_dir}\n`);
  process.stdout.write(`  cli:        ${value.cli}${value.verify.skipped === null ? '' : ' (absent)'}\n`);
  process.stdout.write(`  install:    ${value.install_hash.state}\n`);
  process.stdout.write(`  cache:      ${value.plugin_cache.path} (${versions.length ? versions.join(', ') : 'no versions'})\n`);
  process.stdout.write(`  cache hash: ${value.plugin_cache.state}\n`);
  process.stdout.write(`  verify:     ${value.verify.skipped ?? `exit ${value.verify.exit}`}\n`);
  if (value.verify.stdout.trim() !== '') process.stdout.write(`${value.verify.stdout.replace(/^/gm, '    ')}`);
  if (value.verify.stderr.trim() !== '') process.stderr.write(value.verify.stderr);
}

function report(): number {
  const prefix = prefixOf();
  if (prefix === '') {
    process.stderr.write('report-installed-knowledge: npm prefix -g did not resolve\n');
    return 2;
  }
  const value = collectReport(prefix);
  if (JSON_MODE) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  } else {
    renderReport(value);
  }
  return value.install_hash.state === 'MISMATCH' || value.plugin_cache.state === 'MISMATCH' ? 1 : 0;
}

process.exit(report());
