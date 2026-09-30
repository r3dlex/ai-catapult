import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, process.env.AI_CATAPULT_DIST_ROOT || 'dist-snapshot');
const vendor = join(root, 'vendor/skills');
const lock = JSON.parse(readFileSync(join(root, 'skills.lock.json')));
const peers = { northstar: '02-govern-plan/northstar', autobahn: '04-validate-handoff/autobahn' };
function run(command, args, options = {}) {
  const r = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 120000, ...options });
  assert.equal(r.status, 0, `${command} ${args.join(' ')}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}
function verifyLockedSource(path) {
  assert.equal(run('git', ['-C', path, 'rev-parse', 'HEAD']).trim(), lock.sha, 'actual vendor HEAD must match lock');
  const files = run('git', ['-C', path, 'ls-tree', '-r', '--name-only', lock.sha, '--', ...Object.values(peers)]).trim().split('\n');
  assert.ok(files.includes(`${peers.autobahn}/lib/readiness_contract.py`), 'locked source must contain shared readiness contract');
  for (const file of [...files, 'tests/readiness_fixture.py']) {
    const committed = spawnSync('git', ['-C', path, 'show', `${lock.sha}:${file}`], { maxBuffer: 10 * 1024 * 1024 });
    assert.equal(committed.status, 0);
    assert.deepEqual(readFileSync(join(path, file)), committed.stdout, `vendor bytes differ from immutable lock: ${file}`);
  }
  return files;
}
function comparePeers(plugin, files) {
  for (const [name, prefix] of Object.entries(peers)) {
    for (const file of files.filter((p) => p.startsWith(`${prefix}/`))) {
      // Builders copy recursively; only .git and HEAD_SHA are removed (neither is tracked here).
      assert.deepEqual(readFileSync(join(plugin, 'skills', name, file.slice(prefix.length + 1))), readFileSync(join(vendor, file)), `${plugin}: ${file}`);
    }
  }
}
function tree(path, prefix = '') {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? tree(join(path, entry.name), `${prefix}${entry.name}/`)
    : [[`${prefix}${entry.name}`, readFileSync(join(path, entry.name)).toString('base64')]]).sort(([a], [b]) => a.localeCompare(b));
}

test('readiness delivery binds actual locked Git bytes, not a forgeable sentinel', () => {
  verifyLockedSource(vendor);
  const temp = mkdtempSync(join(tmpdir(), 'readiness-vendor-'));
  try {
    writeFileSync(join(temp, 'HEAD_SHA'), `${lock.sha}\n`);
    assert.throws(() => verifyLockedSource(temp), /actual vendor HEAD|git/);
    run('git', ['clone', '--quiet', '--no-hardlinks', vendor, temp + '-clone']);
    const clone = temp + '-clone';
    try {
      writeFileSync(join(clone, 'HEAD_SHA'), `${lock.sha}\n`);
      const helper = join(clone, peers.autobahn, 'lib/readiness_contract.py');
      writeFileSync(helper, readFileSync(helper, 'utf8') + '\n# drift\n');
      assert.throws(() => verifyLockedSource(clone), /vendor bytes differ/);
      run('git', ['-C', clone, 'checkout', '--', peers.autobahn]);
      run('git', ['-C', clone, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'wrong actual HEAD']);
      assert.throws(() => verifyLockedSource(clone), /actual vendor HEAD/);
    } finally { rmSync(clone, { recursive: true, force: true }); }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('readiness resources and public behavior survive both builds, packing and temporary installation', () => {
  const files = verifyLockedSource(vendor);
  const temp = mkdtempSync(join(tmpdir(), 'readiness-delivery-'));
  try {
    const stage = join(temp, 'stage');
    mkdirSync(stage);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json')));
    for (const path of ['package.json', ...pkg.files]) {
      const source = path === 'dist/' ? dist : join(root, path);
      if (existsSync(source)) cpSync(source, join(stage, path), { recursive: true });
    }
    const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], { cwd: stage }));
    run('tar', ['-xzf', join(temp, packed[0].filename), '-C', temp]);
    const extracted = join(temp, 'package');
    assert.equal(existsSync(join(extracted, 'vendor')), false, 'package must work without vendor checkout');
    const home = join(temp, 'home');
    const codex = join(home, '.codex');
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(codex, { recursive: true });
    run(process.execPath, [join(extracted, 'bin/ai-catapult.js'), 'install', '--harness', 'all'], {
      cwd: temp, env: { ...process.env, HOME: home, CODEX_HOME: codex, XDG_CONFIG_HOME: join(home, '.config'), AI_CATAPULT_DIST_ROOT: join(extracted, 'dist') },
    });
    const plugins = [
      ...['claude-plugin', 'codex-plugin'].map((name) => join(dist, name)),
      ...['claude-plugin', 'codex-plugin'].map((name) => join(extracted, 'dist', name)),
      join(home, '.claude/plugins/ai-catapult'),
      join(codex, 'plugins/cache/ai-catapult-local/ai-catapult/local'),
    ];
    for (const plugin of plugins) comparePeers(plugin, files);
    const matrix = join(root, 'test/fixtures/readiness-delivery.py');
    assert.ok(existsSync(matrix), 'public behavior fixture must be present');
    const fixtureRepo = join(temp, 'public-repo');
    const results = [vendor, ...plugins].map((path) => {
      rmSync(fixtureRepo, { recursive: true, force: true });
      mkdirSync(fixtureRepo);
      return JSON.parse(run('python3', ['-B', matrix, '--skills-root', path, '--fixture-source', vendor, '--repo-root', fixtureRepo]));
    });
    for (const result of results.slice(1)) assert.deepEqual(result, results[0], 'canonical/flat/packed/installed verdict and identity parity');
    for (const harness of ['claude', 'codex']) {
      const output = join(temp, `repeat-${harness}`);
      const env = { ...process.env, DIST_ROOT: output };
      run('bash', [`scripts/build-${harness}-plugin.sh`], { env });
      const first = tree(join(output, `${harness}-plugin`));
      run('bash', [`scripts/build-${harness}-plugin.sh`], { env });
      assert.deepEqual(tree(join(output, `${harness}-plugin`)), first, `${harness} repeated build must be deterministic`);
      assert.deepEqual(first, tree(join(dist, `${harness}-plugin`)), `${harness} build must match stable snapshot`);
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
