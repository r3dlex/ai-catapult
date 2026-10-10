import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

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

function lockedBytes(pathInLock) {
  const r = spawnSync('git', ['-C', vendor, 'cat-file', 'blob', `${lock.sha}:${pathInLock}`], { maxBuffer: 10 * 1024 * 1024 });
  assert.equal(r.status, 0, `locked source ${pathInLock} unreadable: ${r.stderr}`);
  return r.stdout;
}

/**
 * ACH-C-02 packaged lane: after the v2 lock bump the vendored peer trees must
 * carry readiness-contract/2 machinery, and every file pinned by the vendored
 * readiness-dependency.json (v1) and readiness-dependency-v2.json (v2) — the
 * northstar/approve.sh producer/consumer pair among them — must ride the lock
 * bytes through vendor and the npm pack tarball byte-identically.
 *
 * The resolution rule mirrors the pinned contract-run-v2.sh verification loop:
 * path keys starting with "northstar/" resolve against the northstar peer dir
 * (prefix stripped); every other key resolves against the autobahn dir.
 */
test('readiness-contract/2 pinned bytes ride the lock, the vendored trees and the npm pack tarball byte-identically', () => {
  const ab = join(vendor, peers.autobahn);
  const ns = join(vendor, peers.northstar);
  const v2Bytes = readFileSync(join(ab, 'readiness-dependency-v2.json'));
  assert.ok(v2Bytes.length > 0, 'vendored readiness-dependency-v2.json must exist after the O8 lock bump (red at the pre-bump lock)');
  const v2 = JSON.parse(v2Bytes.toString('utf8'));
  assert.equal(v2.schema, 'readiness-contract/2', 'v2 manifest must declare readiness-contract/2');
  assert.deepEqual(readFileSync(join(ns, 'readiness-dependency-v2.json')), v2Bytes, 'northstar v2 manifest copy must be byte-identical to the autobahn copy');
  const v1Bytes = readFileSync(join(ab, 'readiness-dependency.json'));
  const v1 = JSON.parse(v1Bytes.toString('utf8'));
  assert.equal(v1.schema, 'readiness-contract/1');
  assert.deepEqual(readFileSync(join(ns, 'readiness-dependency.json')), v1Bytes, 'northstar v1 manifest copy must be byte-identical to the autobahn copy');
  assert.ok(v2.files['northstar/approve.sh'], 'the v2 manifest must pin northstar/approve.sh');
  assert.ok(v2.files['northstar/handoff-write.sh'], 'the v2 manifest must pin northstar/handoff-write.sh');

  // Pinned bytes equal the lock commit bytes (vendored tree lane).
  const resolvePinned = (key) => key.startsWith('northstar/')
    ? { lockPath: `${peers.northstar}/${key.slice('northstar/'.length)}`, vendorPath: join(ns, key.slice('northstar/'.length)) }
    : { lockPath: `${peers.autobahn}/${key}`, vendorPath: join(ab, key) };
  const pinnedEntries = [];
  for (const manifest of [v1, v2]) {
    for (const [key, digest] of Object.entries(manifest.files)) pinnedEntries.push({ key, digest });
  }
  for (const { key, digest } of pinnedEntries) {
    const { lockPath, vendorPath } = resolvePinned(key);
    const locked = lockedBytes(lockPath);
    assert.deepEqual(readFileSync(vendorPath), locked, `vendored pinned bytes differ from lock for ${key}`);
    assert.equal(createHash('sha256').update(locked).digest('hex'), digest, `pinned sha256 digest mismatch vs manifest for ${key}`);
  }
  assert.ok(pinnedEntries.length >= 22, `expected 22 pinned file entries across v1+v2 manifests, found ${pinnedEntries.length}`);

  // npm pack lane: the tarball ships package.json files only — the flat ready
  // payloads ride dist/<harness>-plugin/skills/{autobahn,northstar}/ — and every
  // pinned byte must arrive there from the staged dist identical to the lock.
  const temp = mkdtempSync(join(tmpdir(), 'readiness-v2-pack-'));
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
    for (const harness of ['claude-plugin', 'codex-plugin']) {
      assert.ok(existsSync(join(extracted, 'dist', harness, 'skills/autobahn/readiness-dependency-v2.json')), `packed tarball must carry the ${harness} autobahn v2 manifest`);
      assert.ok(existsSync(join(extracted, 'dist', harness, 'skills/northstar/readiness-dependency-v2.json')), `packed tarball must carry the ${harness} northstar v2 manifest`);
      assert.deepEqual(readFileSync(join(extracted, 'dist', harness, 'skills/autobahn/readiness-dependency-v2.json')), v2Bytes, `packed ${harness} autobahn v2 manifest must be byte-identical to vendored`);
      assert.deepEqual(readFileSync(join(extracted, 'dist', harness, 'skills/northstar/readiness-dependency-v2.json')), v2Bytes, `packed ${harness} northstar v2 manifest must be byte-identical to vendored`);
      for (const { key } of pinnedEntries) {
        const flat = key.startsWith('northstar/') ? join('skills', 'northstar', key.slice('northstar/'.length)) : join('skills', 'autobahn', key);
        assert.deepEqual(readFileSync(join(extracted, 'dist', harness, ...flat.split('/'))), lockedBytes(resolvePinned(key).lockPath), `packed ${harness} pinned bytes differ from lock for ${key}`);
      }
      assert.ok(existsSync(join(extracted, 'dist', harness, 'skills/northstar/approve.sh')), `packed tarball must ship the ${harness} northstar/approve.sh`);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

/**
 * ACH-C-02 F1, as amended (PARALLEL-LANES.md 2026-10-10T04:31Z, SOLE
 * COORDINATOR DECISION — ACH-C-02 fixture-scope amendment): bumping the lock
 * re-renders the init fixture mechanically and the amended delta is exactly
 *
 *   + test/fixtures/init-standalone/.ai/policies/readiness-policy.json
 *   + test/fixtures/init-standalone/.ai/knowledge/registry.json
 *   + test/fixtures/init-standalone/.ai/knowledge/entries/.gitkeep
 *   M test/fixtures/init-standalone/.ai/workflows/repo-workflow.json (local_ci)
 *
 * with the vendored boundary-manifest mechanical entries going 40 (lock
 * 26d25105) to 42 (this lock) — the originally registered "40 to 41" was
 * factually wrong at the goal's own anchor (the knowledge-registry template
 * #121 and the readiness-policy template #102 are both already ancestors).
 * Red before the regen output is bound: none of the four fixture paths render
 * and the vendored manifest does not yet match the bumped lock. Green once
 * `npm run regen:fixture` output is bound in this PR (determinism digests in
 * .ai/evidence/ACH-C-02.json).
 */
test('F1 amended fixture delta renders with the bump; boundary-manifest mechanical entries are 42 (amended, not the registered 41)', () => {
  const initTemplates = '03-configure-generate/ai-catapult-init/templates';
  const manifestPath = `${initTemplates}/boundary-manifest.json`;
  const locked = JSON.parse(lockedBytes(manifestPath).toString('utf8'));
  const vendored = JSON.parse(readFileSync(join(vendor, manifestPath), 'utf8'));
  assert.deepEqual(vendored, locked, 'vendored boundary-manifest must be the pinned template manifest');
  assert.equal(locked.mechanical_count, 42, 'pinned manifest mechanical_count must be the amended 42 (40 at pre-bump 26d25105)');
  assert.equal(vendored.mechanical_count, 42, 'vendored template must agree with the amended count');
  const mech = locked.paths.filter((p) => p.classification === 'mechanical');
  assert.equal(mech.length, 42, 'manifest must self-consistently list 42 mechanical paths');
  assert.ok(mech.some((p) => p.path === '.ai/knowledge/registry.json'), '42-count includes the knowledge registry template (#121)');
  assert.ok(mech.some((p) => p.path === '.ai/policies/readiness-policy.json'), '42-count includes the readiness policy template (#102)');
  assert.ok(existsSync(join(vendor, initTemplates, 'dot-ai/knowledge/registry.json')), 'vendored knowledge registry template present');
  assert.ok(existsSync(join(vendor, initTemplates, 'dot-ai/knowledge/entries/.gitkeep')), 'vendored knowledge entries .gitkeep present');
  assert.ok(existsSync(join(vendor, initTemplates, 'dot-ai/policies/readiness-policy.json')), 'vendored readiness policy template present');

  // Fixture lane — the amended mechanical delta is bound.
  const fix = join(root, 'test/fixtures/init-standalone');
  const policy = JSON.parse(readFileSync(join(fix, '.ai/policies/readiness-policy.json'), 'utf8'));
  assert.equal(policy.schema, 'readiness-policy/2', 'fixture policy must be the template render');
  assert.equal(policy.repository.id, 'example-repo', 'only {{REPO_ID}} is substituted (canonical regen input)');
  assert.equal(policy.identity_model, 'multi');
  assert.deepEqual(policy.approval.accept, ['agent-self', 'ssh-tag', 'in-session']);
  assert.equal(policy.approval.default_mode, 'agent');
  assert.equal(policy.approval.anchor_sha256, null, 'fail-closed anchor placeholder preserved');
  assert.deepEqual(policy.required_checks, [], 'fail-closed required_checks placeholder preserved');

  const registry = JSON.parse(readFileSync(join(fix, '.ai/knowledge/registry.json'), 'utf8'));
  assert.equal(registry.schema, 'knowledge-registry/1');
  assert.equal(registry.repo_id, 'example-repo');
  assert.deepEqual(registry.entries, []);
  assert.equal(registry.generated_from, '.ai/knowledge/entries');
  assert.ok(existsSync(join(fix, '.ai/knowledge/entries/.gitkeep')), 'entries/.gitkeep renders');

  const workflow = JSON.parse(readFileSync(join(fix, '.ai/workflows/repo-workflow.json'), 'utf8'));
  assert.deepEqual(workflow.local_ci, { surfaces: [], sole_source_of_truth: false }, '#105 local_ci block rides the bump render');
});
