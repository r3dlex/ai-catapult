#!/usr/bin/env node
// publish-both.ts — publish ai-catapult to npm under both package names.
//
// Names:
//   ai-catapult          (unscoped, primary)
//   @r3dlex/ai-catapult  (scoped mirror)
//
// Default mode: dry-run (npm publish --dry-run) — safe to run any time.
// Real publish: requires BOTH --yes flag AND env AI_CATAPULT_PUBLISH=1.
//
// Usage:
//   node scripts/publish-both.ts                               # dry-run
//   AI_CATAPULT_PUBLISH=1 node scripts/publish-both.ts --yes   # real publish both
//   AI_CATAPULT_PUBLISH=1 node scripts/publish-both.ts --yes --package @r3dlex/ai-catapult  # scoped retry
//
// (Replaces the former scripts/publish-both.sh. Deliberately self-contained:
// only node builtins, so it also runs inside a staged package directory.)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleDir, packageRoot } from '../src/paths.ts';

const REPO_ROOT = packageRoot(moduleDir(import.meta.url));

type SpawnResult = { status: number | null; stdout: string; stderr: string; error?: Error };

type PublishOptions = { dryRun: string; provenance: string };

type PackedEntry = { name: string; version: string; filename: string; integrity: string };

function npmRun(args: string[], cwd: string): SpawnResult {
  const result = spawnSync('npm', args, { cwd, encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error ? { error: result.error } : {}),
  };
}

function requireSuccess(result: SpawnResult): string {
  process.stderr.write(result.stderr || '');
  if (result.status !== 0) {
    process.stderr.write(result.stdout || '');
    const error = new Error('npm command failed') as Error & { status: number };
    error.status = result.status !== null && result.status > 0 ? result.status : 1;
    throw error;
  }
  return result.stdout;
}

/** Pack-identity verification: exactly one entry, exact name/version, safe filename, integrity match. */
function verifyPackedIdentity(
  packed: PackedEntry[],
  packageName: string,
  version: string,
  temp: string,
): { tarball: string; integrity: string } {
  const entry = Array.isArray(packed) && packed.length === 1 ? packed[0] : undefined;
  if (
    !entry ||
    entry.name !== packageName ||
    entry.version !== version ||
    typeof entry.filename !== 'string' ||
    basename(entry.filename) !== entry.filename
  ) {
    throw new Error('unexpected local package identity');
  }
  const tarball = join(temp, entry.filename);
  const integrity = 'sha512-' + createHash('sha512').update(readFileSync(tarball)).digest('base64');
  if (entry.integrity !== integrity) throw new Error('local packed integrity mismatch');
  return { tarball, integrity };
}

function readArchiveManifest(tarball: string): { name: string; version: string } {
  const extracted = spawnSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' });
  return JSON.parse(
    requireSuccess({
      status: extracted.status,
      stdout: extracted.stdout ?? '',
      stderr: extracted.stderr ?? '',
    }),
  ) as { name: string; version: string };
}

/**
 * Dry-run registry check: existing immutable content must match the exact
 * packed bytes; E404 means genuinely unpublished.
 */
function verifyRegistryIdentity(packageDir: string, packageName: string, version: string, integrity: string): boolean {
  const remote = npmRun(
    [
      'view',
      `${packageName}@${version}`,
      'name',
      'version',
      'dist.integrity',
      '--json',
      '--registry=https://registry.npmjs.org',
      '--@r3dlex:registry=https://registry.npmjs.org',
    ],
    packageDir,
  );
  if (remote.status === 0) {
    process.stderr.write(remote.stderr || '');
    const published = JSON.parse(remote.stdout) as { name: string; version: string; 'dist.integrity': string };
    if (published.name !== packageName || published.version !== version || published['dist.integrity'] !== integrity) {
      throw new Error('registry identity or payload integrity mismatch');
    }
    return true;
  }
  let missing = false;
  try {
    missing = (JSON.parse(remote.stdout) as { error?: { code?: string } }).error?.code === 'E404';
  } catch {
    // Unparseable stdout is treated as "not a known E404": requireSuccess surfaces it.
  }
  if (!missing) requireSuccess(remote);
  process.stderr.write(remote.stderr || '');
  return false;
}

/** Publish the exact verified bytes, or log the verified-existing completion. */
function publishExact(
  packageDir: string,
  tarball: string,
  packageName: string,
  version: string,
  options: PublishOptions,
  existing: boolean,
): void {
  if (existing) {
    console.log(`${packageName}@${version} already published — VERIFIED existing registry artifact (exact payload).`);
    return;
  }
  const extra = [options.dryRun, options.provenance].filter((flag) => flag.length > 0);
  process.stdout.write(
    requireSuccess(
      npmRun(
        [
          'publish',
          tarball,
          '--json',
          ...extra,
          '--access',
          'public',
          '--registry=https://registry.npmjs.org',
          '--@r3dlex:registry=https://registry.npmjs.org',
        ],
        packageDir,
      ),
    ),
  );
}

/** Pack, verify integrity + archive identity, then publish those exact bytes. */
function publishPackage(packageDir: string, packageName: string, version: string, options: PublishOptions): void {
  const temp = mkdtempSync(join(tmpdir(), 'ai-catapult-publish-'));
  try {
    const packed = JSON.parse(
      requireSuccess(npmRun(['pack', '--json', '--foreground-scripts=false', '--pack-destination', temp], packageDir)),
    ) as PackedEntry[];
    const { tarball, integrity } = verifyPackedIdentity(packed, packageName, version, temp);
    const archiveManifest = readArchiveManifest(tarball);
    if (archiveManifest.name !== packageName || archiveManifest.version !== version) {
      throw new Error('packed archive identity mismatch');
    }
    const existing = options.dryRun === '' && verifyRegistryIdentity(packageDir, packageName, version, integrity);
    publishExact(packageDir, tarball, packageName, version, options, existing);
  } catch (error) {
    console.error(`publish-both: ${(error as Error).message}`);
    process.exitCode = ((error as Error & { status?: number }).status ?? 1) || 1;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function publishPackageOrExit(packageDir: string, packageName: string, version: string, options: PublishOptions): void {
  publishPackage(packageDir, packageName, version, options);
  // process.exitCode stays `undefined` on success (publishPackage only sets it
  // on failure) — a `!== 0` check would treat undefined as failure and abort
  // after the unscoped leg before the scoped mirror publishes.
  if (process.exitCode) process.exit(process.exitCode);
}

/** Stage the scoped package: copy published files + write patched package.json. */
export function stageScopedPackage(
  repoRoot: string,
  dest: string,
  options: { distSource?: string } = {},
): void {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    files?: string[];
  } & Record<string, unknown>;
  const files = pkg.files ?? [];

  for (const rel of files) {
    // The `dist/` entry can be supplied from a substitute source tree: a publish
    // packs the freshly built live dist/, while tests copy the stable
    // dist-snapshot/ instead — the suite's plugin tests wipe and rebuild the
    // live dist/ concurrently, and a test staging directly from it races a
    // half-wiped tree (the same reason packed-init.test.ts stages npm pack
    // from dist-snapshot/). Only the source path swaps; the staged layout
    // keeps the published `dist/...` shape.
    const sourceRel = rel === 'dist/' ? (options.distSource ?? 'dist') : rel;
    const src = join(repoRoot, sourceRel);
    const dst = join(dest, rel);
    mkdirSync(dirname(dst), { recursive: true });
    try {
      cpSync(src, dst, { recursive: true });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      // Missing entries are skipped so an optional build artifact does not abort
      // a release — but report them. A bare `catch {}` here hid a `files[]` gap
      // for a month: the README contract was never staged, so the scoped
      // mirror's prepack exited 127 on the first release that reached this
      // path, with no earlier warning anywhere.
      process.stderr.write(`publish-both: WARNING not staged: ${rel} (${err.code ?? err.message})\n`);
    }
  }

  const scoped: Record<string, unknown> = {
    ...pkg,
    name: '@r3dlex/ai-catapult',
    publishConfig: { access: 'public' },
  };
  // Artifact-only scoped lifecycle: the staged tree is already a complete
  // built artifact (dist/ was built before staging), so packaging must never
  // rebuild it. The v0.2.0 incident (missing stage-readme-contract.sh → the
  // mirror's prepack exited 127) closed the missing-script hole; the TS wave
  // reopened a sibling through `npm run build` inside prepack (tsc and
  // prepare-dist.ts are never staged, review round 1 F3 — the static
  // prepack-vs-files checks only see literal scripts/* invocations). Removing
  // prepack/pretest/test/prepare closes the whole class: pack here runs zero
  // scripts (prepare would vendor from the network into the staging tree when
  // it packs).
  const scripts = { ...(scoped.scripts as Record<string, string>) };
  delete scripts.prepack;
  delete scripts.pretest;
  delete scripts.test;
  delete scripts.prepare;
  scoped.scripts = scripts;

  writeFileSync(join(dest, 'package.json'), JSON.stringify(scoped, null, 2) + '\n', 'utf8');
  process.stdout.write('Scoped package staged at: ' + dest + '\n');
}

type ParsedArgs = { realPublish: boolean; selectedPackage: string; packageSet: boolean };

function parseYesArg(args: ParsedArgs): void {
  if (args.realPublish) {
    process.stderr.write('ERROR: duplicate --yes\n');
    process.exit(1);
  }
  args.realPublish = true;
}

function parsePackageArg(argv: string[], index: number, args: ParsedArgs): number {
  const value = argv[index + 1];
  if (args.packageSet || value === undefined || argv.length < 2) {
    process.stderr.write('ERROR: --package requires one exact package name and may appear only once\n');
    process.exit(1);
  }
  if (value !== 'ai-catapult' && value !== '@r3dlex/ai-catapult') {
    process.stderr.write(`ERROR: unsupported package: ${value}\n`);
    process.exit(1);
  }
  args.selectedPackage = value;
  args.packageSet = true;
  return index + 2;
}

function parseArgs(): { realPublish: boolean; selectedPackage: string } {
  const args: ParsedArgs = { realPublish: false, selectedPackage: 'both', packageSet: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; ) {
    const arg = argv[i];
    if (arg === '--yes') {
      parseYesArg(args);
      i += 1;
    } else if (arg === '--package') {
      i = parsePackageArg(argv, i, args);
    } else {
      process.stderr.write(`Unknown argument: ${arg ?? ''}\n`);
      process.exit(1);
    }
  }
  return { realPublish: args.realPublish, selectedPackage: args.selectedPackage };
}

function ensureBuilt(pluginJsonPath: string, label: string, scriptName: string): void {
  if (existsSync(pluginJsonPath)) return;
  console.log(`Building ${label}...`);
  const built = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', scriptName)], { stdio: 'inherit' });
  if (built.error || built.status !== 0) process.exit(built.status ?? 1);
}

/**
 * Fresh root runtime build before scoped staging (review round 2). The
 * scoped-only retry dispatches no root pack, so nothing ran the root
 * prepack's `npm run build`: a clean checkout (no tsc, no dist/) staged an
 * empty mirror and npm packed a package with "No bin file found". The
 * unscoped leg never had this hole — its pack runs from the repo root, where
 * prepack builds the runtime or fails closed (the v0.2.0 clean-checkout 127
 * class). Called on both scoped lanes (runScopedPublish) so every staged
 * mirror comes from a build that just succeeded; exiting with npm's own
 * status keeps both lanes fail-closed the same way.
 */
function buildRootRuntime(repoRoot: string): void {
  console.log('Building root runtime (npm run build)...');
  const built = npmRun(['run', 'build'], repoRoot);
  process.stderr.write(built.stderr || '');
  if (built.error || built.status !== 0) {
    process.stdout.write(built.stdout || '');
    process.stderr.write('publish-both: root runtime build failed — refusing to stage or publish the scoped mirror\n');
    process.exit(built.status ?? 1);
  }
}

/**
 * Compiled-runtime completeness of the staged scoped mirror (review round 2).
 * The staged tree packs with zero lifecycle scripts, so a missing build
 * artifact can never be caught downstream — it would publish as-is. These two
 * paths mirror the tarball assertions in test/scoped-mirror-staging.test.ts.
 */
function missingScopedRuntime(stagedDir: string): string[] {
  const missing: string[] = [];
  const bin = join(stagedDir, 'dist', 'bin', 'ai-catapult.js');
  // npm's POSIX bin shim resolves execution permission on its target, so the
  // compiled bin must exist AND carry its mode fidelity (prepare-dist.ts
  // chmods the live dist/bin/ai-catapult.js to 0755).
  if (!existsSync(bin) || (statSync(bin).mode & 0o111) === 0) missing.push('dist/bin/ai-catapult.js (executable)');
  if (!existsSync(join(stagedDir, 'skills.lock.json'))) missing.push('skills.lock.json');
  return missing;
}

function runScopedPublish(repoRoot: string, version: string, options: PublishOptions): void {
  // The staged mirror packs with zero lifecycle scripts (round-1 fix), so the
  // runtime it stages must already be complete. Fresh-build the root runtime
  // right here: the scoped-only retry dispatches no root pack at all (nothing
  // ran the root prepack's build — the review-round-2 clean-checkout hole),
  // and `both` mode rebuilds what the unscoped prepack just produced so every
  // scoped lane stages from a build that just succeeded under one uniform
  // fail-closed contract.
  buildRootRuntime(repoRoot);
  const scopedDir = mkdtempSync(join(tmpdir(), 'tmp-'));
  let failed = true;
  try {
    stageScopedPackage(repoRoot, scopedDir);
    const missing = missingScopedRuntime(scopedDir);
    if (missing.length === 0) {
      console.log('');
      publishPackageOrExit(scopedDir, '@r3dlex/ai-catapult', version, options);
      console.log('');
      failed = false;
    } else {
      process.stderr.write(`publish-both: staged scoped runtime incomplete — missing: ${missing.join(', ')}\n`);
      process.stderr.write('publish-both: the staged mirror packs with zero lifecycle scripts, so nothing downstream can rebuild it — refusing to publish\n');
    }
  } finally {
    rmSync(scopedDir, { recursive: true, force: true });
  }
  if (failed) process.exit(1);
}

function printSummary(realPublish: boolean, selectedPackage: string, version: string): void {
  if (realPublish) {
    if (selectedPackage === 'both') {
      console.log(`Publication complete: ai-catapult@${version} and @r3dlex/ai-catapult@${version} published or verified existing.`);
    } else {
      console.log(`Publication complete: ${selectedPackage}@${version} published or verified existing.`);
    }
  } else {
    console.log('Dry-run complete — selected packages validated successfully.');
    console.log('Publishing requires AI_CATAPULT_PUBLISH=1 and --yes; preserve any --package selection.');
  }
}

function assertPublishGate(realPublish: boolean): void {
  // Double gate: --yes alone is not enough; env var must also be set
  if (realPublish && process.env.AI_CATAPULT_PUBLISH !== '1') {
    process.stderr.write('ERROR: --yes requires AI_CATAPULT_PUBLISH=1 to be set (double gate).\n');
    process.stderr.write('       Run: AI_CATAPULT_PUBLISH=1 node scripts/publish-both.ts --yes\n');
    process.exit(1);
  }
}

function run(): void {
  // ---------------------------------------------------------------------------
  // Parse args
  // ---------------------------------------------------------------------------
  const args = parseArgs();
  assertPublishGate(args.realPublish);

  const dryRunFlag = args.realPublish ? '' : '--dry-run';
  if (args.realPublish) {
    console.log('=== REAL PUBLISH MODE ===');
  } else {
    console.log('=== DRY-RUN MODE (no packages will be published) ===');
  }

  // --provenance requires OIDC (only available in CI environments like GitHub Actions).
  // Guard it so local runs don't fail with "provenance not supported".
  const provenanceFlag = process.env.CI === 'true' || process.env.NPM_PROVENANCE === '1' ? '--provenance' : '';

  // ---------------------------------------------------------------------------
  // Verify builds exist (build if absent)
  // ---------------------------------------------------------------------------
  ensureBuilt(join(REPO_ROOT, 'dist/claude-plugin/.claude-plugin/plugin.json'), 'Claude Code plugin', 'build-claude-plugin.ts');
  ensureBuilt(join(REPO_ROOT, 'dist/codex-plugin/.codex-plugin/plugin.json'), 'Codex plugin', 'build-codex-plugin.ts');

  // Read version from package.json
  const version = (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version;
  console.log(`Version: ${version}`);
  console.log('');

  const publishOptions: PublishOptions = { dryRun: dryRunFlag, provenance: provenanceFlag };

  // ---------------------------------------------------------------------------
  // 1. Publish unscoped: ai-catapult (from repo root)
  // ---------------------------------------------------------------------------
  // Pack once, then compare/publish those exact bytes. Existing immutable registry
  // content is an idempotent completion, never an excuse to swallow publish errors.
  if (args.selectedPackage === 'both' || args.selectedPackage === 'ai-catapult') {
    console.log('--- [1/2] Publishing ai-catapult (unscoped) ---');
    publishPackageOrExit(REPO_ROOT, 'ai-catapult', version, publishOptions);
    console.log('');
  }

  // ---------------------------------------------------------------------------
  // 2. Publish scoped: @r3dlex/ai-catapult (stage in tmp dir with patched name)
  // ---------------------------------------------------------------------------
  if (args.selectedPackage === 'both' || args.selectedPackage === '@r3dlex/ai-catapult') {
    console.log('--- [2/2] Publishing @r3dlex/ai-catapult (scoped mirror) ---');
    runScopedPublish(REPO_ROOT, version, publishOptions);
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  printSummary(args.realPublish, args.selectedPackage, version);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run();