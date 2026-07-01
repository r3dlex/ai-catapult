/**
 * TDD test for vendor integrity verify gate (Slice 1).
 *
 * Tests that scripts/verify-vendor.sh (or node equivalent) exits non-zero
 * when vendor/skills is absent or SHA-mismatched, and exits zero when
 * present and matched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const verifyScript = join(root, 'scripts/verify-vendor.sh');
const lockFile = join(root, 'skills.lock.json');
const vendorDir = join(root, 'vendor/skills');

/**
 * Run the verify gate script with a custom VENDOR_ROOT env override so tests
 * don't touch the real vendor/ directory.
 */
function runVerify(fakeVendorRoot, extraEnv = {}) {
  return spawnSync('bash', [verifyScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      VENDOR_ROOT: fakeVendorRoot,
      ...extraEnv,
    },
  });
}

test('verify gate exits non-zero when vendor/skills directory is absent', () => {
  const tmp = join(root, '.tmp-vendor-test-absent');
  // Ensure the fake vendor root has NO skills subdir
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });

  const result = runVerify(tmp);
  assert.notEqual(result.status, 0, `expected non-zero exit when vendor/skills absent; got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);

  rmSync(tmp, { recursive: true, force: true });
});

test('verify gate exits non-zero when vendor/skills HEAD SHA mismatches lockfile', () => {
  const tmp = join(root, '.tmp-vendor-test-mismatch');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(tmp, 'skills'), { recursive: true });

  // Create a fake HEAD file with a wrong SHA
  const fakeHead = join(tmp, 'skills', 'HEAD_SHA');
  writeFileSync(fakeHead, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n');

  const result = runVerify(tmp);
  assert.notEqual(result.status, 0, `expected non-zero exit on SHA mismatch; got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);

  rmSync(tmp, { recursive: true, force: true });
});

test('verify gate exits zero when vendor/skills exists and HEAD SHA matches lockfile', () => {
  const tmp = join(root, '.tmp-vendor-test-match');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(tmp, 'skills'), { recursive: true });

  // Read the real locked SHA from skills.lock.json
  const lock = JSON.parse(execFileSync('cat', [lockFile], { encoding: 'utf8' }));
  const lockedSha = lock.sha;

  // Create a HEAD_SHA file with the correct SHA (simulates what setup.sh writes)
  const headFile = join(tmp, 'skills', 'HEAD_SHA');
  writeFileSync(headFile, lockedSha + '\n');

  const result = runVerify(tmp);
  assert.equal(result.status, 0, `expected zero exit when SHA matches; got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);

  rmSync(tmp, { recursive: true, force: true });
});
