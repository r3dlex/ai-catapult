import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function resolveCiAdaptersRuntime() {
  const candidates = [
    process.env.AI_CATAPULT_CI_ADAPTERS_RUNTIME,
    join(process.env.AI_CATAPULT_VENDOR_SKILLS || join(root, 'vendor/skills'), 'scripts/render-ci-adapters.py'),
    join(root, 'dist/scripts/render-ci-adapters.py'),
  ].filter(Boolean);
  const runtime = candidates.find((candidate) => existsSync(candidate));
  if (!runtime) throw new Error('CI adapter runtime not found; run bash setup.sh and scripts/stage-ci-adapters-runtime.sh');
  return runtime;
}

export function runCiAdaptersRuntime(args) {
  const runtimeArgs = [resolveCiAdaptersRuntime(), ...args];
  let result = spawnSync(process.env.AI_CATAPULT_PYTHON || 'python', runtimeArgs, { stdio: 'inherit' });
  if (result.error?.code === 'ENOENT' && !process.env.AI_CATAPULT_PYTHON) result = spawnSync('python3', runtimeArgs, { stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
