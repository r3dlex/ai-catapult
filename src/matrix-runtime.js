import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function resolveMatrixRuntime() {
  const candidates = [
    process.env.AI_CATAPULT_MATRIX_RUNTIME,
    join(process.env.AI_CATAPULT_VENDOR_SKILLS || join(root, 'vendor/skills'), 'scripts/matrix-contract.py'),
    join(root, 'dist/matrix-runtime.py'),
  ].filter(Boolean);
  const runtime = candidates.find((candidate) => existsSync(candidate));
  if (!runtime) throw new Error('matrix runtime not found; run bash setup.sh and scripts/stage-matrix-runtime.sh');
  return runtime;
}

export function runMatrixRuntime(args) {
  const runtimeArgs = [resolveMatrixRuntime(), ...args];
  let result = spawnSync(process.env.AI_CATAPULT_PYTHON || 'python', runtimeArgs, { stdio: 'inherit' });
  if (result.error?.code === 'ENOENT' && !process.env.AI_CATAPULT_PYTHON) result = spawnSync('python3', runtimeArgs, { stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
