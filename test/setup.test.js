import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return result.stdout.trim();
}

function fixture() {
  const temp = mkdtempSync(join(tmpdir(), 'ai-catapult-setup-'));
  const source = join(temp, 'source');
  const remote = join(temp, 'skills.git');
  const harness = join(temp, 'harness');

  git(['init', '-q', source]);
  git(['config', 'user.name', 'Setup Test'], source);
  git(['config', 'user.email', 'setup-test@example.invalid'], source);
  writeFileSync(join(source, 'contract.txt'), 'canonical contract\n');
  git(['add', 'contract.txt'], source);
  git(['commit', '-qm', 'canonical contract'], source);
  const sha = git(['rev-parse', 'HEAD'], source);
  git(['branch', '-M', 'main'], source);
  git(['branch', 'feature/readme-contract'], source);
  git(['init', '-q', '--bare', remote]);
  git(['remote', 'add', 'origin', remote], source);
  git(['push', '-q', 'origin', 'main', 'feature/readme-contract'], source);
  git(['push', '-q', 'origin', '--delete', 'feature/readme-contract'], source);

  mkdirSync(harness);
  copyFileSync(join(root, 'setup.sh'), join(harness, 'setup.sh'));

  return { temp, remote, harness, sha };
}

test('setup fetches the locked SHA after the informational feature ref is deleted', () => {
  const { temp, remote, harness, sha } = fixture();
  try {
    writeFileSync(join(harness, 'skills.lock.json'), `${JSON.stringify({
      repo: remote,
      ref: 'feature/readme-contract',
      sha,
    }, null, 2)}\n`);

    const result = spawnSync('bash', ['setup.sh'], { cwd: harness, encoding: 'utf8' });
    assert.equal(result.status, 0, `setup failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.equal(readFileSync(join(harness, 'vendor/skills/HEAD_SHA'), 'utf8').trim(), sha);
    assert.equal(git(['rev-parse', 'HEAD'], join(harness, 'vendor/skills')), sha);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('setup fails closed when the locked SHA cannot be fetched', () => {
  const { temp, remote, harness } = fixture();
  try {
    const missingSha = '0000000000000000000000000000000000000000';
    writeFileSync(join(harness, 'skills.lock.json'), `${JSON.stringify({
      repo: remote,
      ref: 'feature/readme-contract',
      sha: missingSha,
    }, null, 2)}\n`);

    const result = spawnSync('bash', ['setup.sh'], { cwd: harness, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout.includes('OK: vendor/skills vendored'), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
