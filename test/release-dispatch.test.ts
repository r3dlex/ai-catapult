import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const guard = join(root, 'scripts/release-context.ts');
type RunFn = {
  run: (extra?: Record<string, string>) => SpawnSyncReturns<string>;
  git: (...args: string[]) => string;
  output: string;
  dir: string;
};

function fixture(callback: (helpers: RunFn) => void) {
  assert.ok(existsSync(guard), 'release recovery needs executable exact-tag guard');
  // realpathSync: the sandboxed release-context.ts guards its entry with an
  // argv[1]/import.meta.url comparison; a symlinked tmpdir component breaks
  // that match and the script silently no-ops (publish-both.test.ts precedent).
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'release-dispatch-')));
  try {
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'scripts'));
    copyFileSync(guard, join(dir, 'scripts/release-context.ts'));
    copyFileSync(join(root, 'src/paths.ts'), join(dir, 'src/paths.ts'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.3.0' }));
    const git = (...args: string[]) => {
      const r = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    git('init', '-q'); git('add', '.'); git('commit', '-qm', 'release'); git('tag', 'v0.3.0');
    const output = join(dir, 'output');
    const run = (extra: Record<string, string> = {}) => {
      rmSync(output, { force: true });
      return spawnSync(process.execPath, [join(dir, 'scripts', 'release-context.ts')], { cwd: dir, encoding: 'utf8', env: {
        ...process.env, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/tags/v0.3.0', GITHUB_REF_TYPE: 'tag', RELEASE_PACKAGE: 'both', GITHUB_OUTPUT: output, ...extra,
      } });
    };
    callback({ run, git, output, dir });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

void test('manual release recovery admits only exact package choices on current version tag commit', () => fixture(({ run, output }) => {
  for (const name of ['both', 'ai-catapult', '@r3dlex/ai-catapult']) {
    const r = run({ RELEASE_PACKAGE: name });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(output, 'utf8'), `package=${name}\n`);
  }
  assert.equal(run({ GITHUB_EVENT_NAME: 'push', RELEASE_PACKAGE: '@r3dlex/ai-catapult' }).status, 0);
  assert.equal(readFileSync(output, 'utf8'), 'package=both\n');
}));

void test('branch, mismatched tag, missing choice, injection, unsupported event and wrong checkout reject before output', () => fixture(({ run, git, output }) => {
  for (const env of [
    { GITHUB_REF: 'refs/heads/main', GITHUB_REF_TYPE: 'branch' },
    { GITHUB_REF: 'refs/tags/v0.2.1' }, { GITHUB_REF_TYPE: 'branch' },
    { RELEASE_PACKAGE: '' }, { RELEASE_PACKAGE: 'foreign' }, { RELEASE_PACKAGE: 'both\nforged=true' },
    { GITHUB_EVENT_NAME: 'pull_request' },
  ]) {
    assert.notEqual(run(env).status, 0);
    assert.equal(existsSync(output), false);
  }
  git('commit', '--allow-empty', '-qm', 'different checkout');
  assert.notEqual(run().status, 0);
  assert.equal(existsSync(output), false);
}));

void test('release workflow shares ref concurrency and retains tests, OIDC and guarded publication for both triggers', () => {
  const text = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
  assert.match(text, /workflow_dispatch:/);
  assert.match(text, /type: choice/);
  assert.match(text, /options:\s*\n\s*- both\s*\n\s*- ai-catapult\s*\n\s*- '@r3dlex\/ai-catapult'/);
  assert.match(text, /group: release-\$\{\{ github.ref \}\}/);
  assert.match(text, /cancel-in-progress: false/);
  assert.match(text, /id-token: write/);
  assert.match(text, /node-version: '22'/);
  assert.match(text, /npm install -g npm@11\.5\.1/);
  assert.match(text, /run: node scripts\/release-context.ts/);
  assert.ok(text.indexOf('run: node scripts/release-context.ts') < text.indexOf('npm install -g'));
  for (const command of ['node scripts/setup.ts', 'node scripts/verify-vendor.ts', 'npm test', 'node bin/ai-catapult.ts install --harness all']) assert.ok(text.includes(command));
  assert.match(text, /RELEASE_PACKAGE: \$\{\{ inputs.package \}\}/);
  assert.match(text, /RELEASE_PACKAGE: \$\{\{ steps.release-context.outputs.package \}\}/);
  assert.match(text, /--yes --package "\$RELEASE_PACKAGE"/);
  assert.doesNotMatch(text, /continue-on-error: true|checkout@v4\s*\n\s*with:\s*\n\s*ref:/);
});
