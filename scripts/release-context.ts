#!/usr/bin/env node
// release-context.ts — fail closed before build/publication; never select a
// different checkout. (Replaces the former scripts/release-context.sh.)
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleDir, packageRoot } from '../src/paths.ts';

const ROOT = packageRoot(moduleDir(import.meta.url));

function gitStdout(args: string[]): string {
  const result = spawnSync('git', args, { encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
  if (result.error || result.status !== 0) return '';
  return result.stdout ?? '';
}

function readPackageVersion(): string {
  const parsed = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version?: unknown };
  const version = typeof parsed.version === 'string' ? parsed.version : '';
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) process.exit(1);
  return version;
}

/** Exit unless the run targets the exact v<version> tag and matches its commit. */
function assertReleaseTag(version: string): void {
  if (process.env.GITHUB_REF_TYPE !== 'tag' || process.env.GITHUB_REF !== `refs/tags/v${version}`) {
    process.stderr.write('release-context: run must target the exact v<package version> tag\n');
    process.exit(1);
  }

  const headSha = gitStdout(['rev-parse', 'HEAD']);
  const tagSha = gitStdout(['rev-parse', '--verify', `${process.env.GITHUB_REF}^{commit}`]);
  if (headSha === '' || tagSha === '' || headSha !== tagSha) {
    process.stderr.write('release-context: checkout does not match the exact release tag commit\n');
    process.exit(1);
  }
}

function resolveTargetPackage(): string {
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (eventName === 'push') return 'both';
  if (eventName === 'workflow_dispatch') {
    const choice = process.env.RELEASE_PACKAGE;
    if (choice === 'both' || choice === 'ai-catapult' || choice === '@r3dlex/ai-catapult') {
      return choice;
    }
    process.stderr.write('release-context: unsupported or missing package choice\n');
    process.exit(1);
  }
  process.stderr.write('release-context: unsupported event\n');
  process.exit(1);
}

function run(): void {
  if (process.argv.length > 2) {
    process.stderr.write('release-context: arguments unsupported\n');
    process.exit(1);
  }

  assertReleaseTag(readPackageVersion());
  const targetPackage = resolveTargetPackage();

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput === undefined) {
    process.stderr.write('release-context: GitHub output path required\n');
    process.exit(1);
  }
  appendFileSync(githubOutput, `package=${targetPackage}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run();