import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { moduleDir } from './paths.ts';

const root = join(moduleDir(import.meta.url), '..');

export function resolveCiAdaptersRuntime(): string {
  const candidates = [
    process.env.AI_CATAPULT_CI_ADAPTERS_RUNTIME,
    join(process.env.AI_CATAPULT_VENDOR_SKILLS || join(root, 'vendor/skills'), 'scripts/render-ci-adapters.py'),
    join(root, 'dist/scripts/render-ci-adapters.py'),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const runtime = candidates.find((candidate) => existsSync(candidate));
  if (!runtime) {
    throw new Error('CI adapter runtime not found; run node scripts/setup.ts and node scripts/stage-ci-adapters-runtime.ts');
  }
  return runtime;
}

export function runCiAdaptersRuntime(args: string[]): number {
  const runtimeArgs = [resolveCiAdaptersRuntime(), ...args];
  let result = spawnSync(process.env.AI_CATAPULT_PYTHON || 'python', runtimeArgs, { stdio: 'inherit' });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' && !process.env.AI_CATAPULT_PYTHON) {
    result = spawnSync('python3', runtimeArgs, { stdio: 'inherit' });
  }
  if (result.error) throw result.error;
  return result.status ?? 1;
}