/**
 * TDD tests for Slice 5 — `ai-catapult graph-hooks install` subcommand.
 *
 * All filesystem writes are isolated to mkdtempSync dirs (tmpdir git repos).
 * Real ~/.claude and ~/.codex are NEVER touched — HOME and CODEX_HOME are
 * overridden to non-existent paths throughout.
 *
 * Coverage:
 *   (a) basic install: .git/hooks/post-commit + post-checkout written, executable
 *   (b) wrapper copied to <target>/scripts/graph-refresh.sh with {{ENGINE}} substituted
 *   (c) graph-automation/config.json written with correct engine value
 *   (d) harness hooks NEXT-STEPS guidance printed to stdout (no files written)
 *   (e) --engine graphwiki substitutes graphwiki in wrapper and config
 *   (f) --dry-run writes nothing, prints what would happen
 *   (g) idempotent re-install: marker block replaced cleanly (single block)
 *   (h) refuses non-git target (exit 1)
 *   (i) core.hooksPath: installs to resolved hooksPath when set
 *   (j) packed-tarball path: pack → extract → run graph-hooks install → hooks + wrapper land
 *   (k) --help shows usage
 *   (l) engine-absent: exits 0, no crash (wrapper is written; no-op at runtime via wrapper logic)
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const bin = join(root, 'bin/ai-catapult.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Create a minimal git repo in a tmp directory. Returns the dir path.
 */
function makeGitRepo(prefix = 'ai-catapult-gh-') {
  const dir = makeTmpDir(prefix);
  spawnSync('git', ['init', dir], { encoding: 'utf8' });
  return dir;
}

/**
 * Run `ai-catapult graph-hooks install` with sandboxed HOME/CODEX_HOME.
 */
function runGraphHooksInstall(args, { home, codexHome } = {}) {
  return spawnSync(process.execPath, [bin, 'graph-hooks', 'install', ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home ?? '/nonexistent-no-home',
      CODEX_HOME: codexHome ?? '/nonexistent-no-codex',
    },
  });
}

/** Check that a file is executable (owner execute bit set). */
function isExecutable(filePath) {
  return (statSync(filePath).mode & 0o100) !== 0;
}

/** Read the hook file installed at .git/hooks/<name> in target. */
function readHook(target, name) {
  return readFileSync(join(target, '.git', 'hooks', name), 'utf8');
}

/** Marker used to identify hook blocks written by ai-catapult. */
const MARKER_START = '# BEGIN ai-catapult graph-hooks';
const MARKER_END = '# END ai-catapult graph-hooks';

// ---------------------------------------------------------------------------
// Packed-tarball setup (reuse the packed-init pattern)
// ---------------------------------------------------------------------------

let packTmpDir;
let extractDir;

before(async () => {
  packTmpDir = makeTmpDir('ai-catapult-gh-pack-');
  extractDir = makeTmpDir('ai-catapult-gh-extract-');

  const DIST_SNAPSHOT = process.env.AI_CATAPULT_DIST_ROOT ?? join(root, 'dist-snapshot');
  const stageDir = makeTmpDir('ai-catapult-gh-stage-');

  try {
    const cp = spawnSync('rsync', [
      '-a', '--delete',
      '--exclude=node_modules',
      '--exclude=.git',
      '--exclude=dist/',
      '--exclude=dist-snapshot/',
      root + '/',
      stageDir + '/',
    ], { encoding: 'utf8', timeout: 30_000 });

    assert.equal(cp.status, 0, `rsync to stage failed\n${cp.stderr}`);

    const stageDist = join(stageDir, 'dist');
    const cpDist = spawnSync('cp', ['-R', DIST_SNAPSHOT, stageDist], { encoding: 'utf8' });
    assert.equal(cpDist.status, 0, `cp dist-snapshot failed: ${cpDist.stderr}`);

    const pack = spawnSync('npm', ['pack', '--pack-destination', packTmpDir, '--ignore-scripts'], {
      encoding: 'utf8',
      cwd: stageDir,
      timeout: 60_000,
    });
    assert.equal(pack.status, 0, `npm pack failed\n${pack.stdout}\n${pack.stderr}`);

    const tgzName = pack.stdout.trim().split('\n').at(-1).trim();
    const tgzPath = join(packTmpDir, tgzName);
    assert.ok(existsSync(tgzPath), `Expected tarball at ${tgzPath}`);

    const tar = spawnSync('tar', ['xzf', tgzPath, '-C', extractDir], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(tar.status, 0, `tar failed: ${tar.stderr}`);
  } finally {
    spawnSync('rm', ['-rf', stageDir], { encoding: 'utf8' });
  }
});

after(() => {
  if (packTmpDir) rmSync(packTmpDir, { recursive: true, force: true });
  if (extractDir) rmSync(extractDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (k) --help
// ---------------------------------------------------------------------------

test('graph-hooks install --help: exits 0 and shows usage', () => {
  const r = spawnSync(process.execPath, [bin, 'graph-hooks', 'install', '--help'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: '/nonexistent', CODEX_HOME: '/nonexistent' },
  });
  assert.equal(r.status, 0, `expected exit 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /graph-hooks install/i, 'help should mention graph-hooks install');
  assert.match(r.stdout, /--engine/i, 'help should mention --engine');
  assert.match(r.stdout, /--dry-run/i, 'help should mention --dry-run');
});

test('graph-hooks --help: shows graph-hooks subcommand usage', () => {
  const r = spawnSync(process.execPath, [bin, 'graph-hooks', '--help'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: '/nonexistent', CODEX_HOME: '/nonexistent' },
  });
  assert.equal(r.status, 0, `expected exit 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout + r.stderr, /graph-hooks/i);
});

// ---------------------------------------------------------------------------
// (h) refuses non-git target
// ---------------------------------------------------------------------------

test('graph-hooks install: refuses non-git target (exit 1)', () => {
  const nonGit = makeTmpDir('ai-catapult-gh-nongit-');
  try {
    const r = runGraphHooksInstall([nonGit]);
    assert.equal(r.status, 1, `expected exit 1 for non-git target\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(
      r.stdout + r.stderr,
      /not a git repo|no \.git|not a git/i,
      `expected error mentioning non-git target\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
  } finally {
    rmSync(nonGit, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (a) basic install: git hooks written + executable
// ---------------------------------------------------------------------------

test('graph-hooks install: writes .git/hooks/post-commit', () => {
  const target = makeGitRepo();
  try {
    const r = runGraphHooksInstall([target]);
    assert.equal(r.status, 0, `expected exit 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const hookPath = join(target, '.git', 'hooks', 'post-commit');
    assert.ok(existsSync(hookPath), 'post-commit hook must exist');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('graph-hooks install: writes .git/hooks/post-checkout', () => {
  const target = makeGitRepo();
  try {
    const r = runGraphHooksInstall([target]);
    assert.equal(r.status, 0, `expected exit 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(existsSync(join(target, '.git', 'hooks', 'post-checkout')), 'post-checkout hook must exist');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('graph-hooks install: post-commit hook is executable', () => {
  const target = makeGitRepo();
  try {
    runGraphHooksInstall([target]);
    assert.ok(isExecutable(join(target, '.git', 'hooks', 'post-commit')), 'post-commit must be executable');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('graph-hooks install: post-checkout hook is executable', () => {
  const target = makeGitRepo();
  try {
    runGraphHooksInstall([target]);
    assert.ok(isExecutable(join(target, '.git', 'hooks', 'post-checkout')), 'post-checkout must be executable');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('graph-hooks install: hook bodies contain marker block', () => {
  const target = makeGitRepo();
  try {
    runGraphHooksInstall([target]);
    const body = readHook(target, 'post-commit');
    assert.ok(body.includes(MARKER_START), 'hook must contain marker start');
    assert.ok(body.includes(MARKER_END), 'hook must contain marker end');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('graph-hooks install: hook bodies contain hook-body.sh delegate logic', () => {
  const target = makeGitRepo();
  try {
    runGraphHooksInstall([target]);
    const body = readHook(target, 'post-commit');
    // The hook body from the template delegates to the wrapper via the sentinel walk
    assert.match(body, /graph-refresh\.sh|GRAPH_HOOKS_WRAPPER/i, 'hook must delegate to wrapper');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (b) wrapper written with {{ENGINE}} substituted
// ---------------------------------------------------------------------------

test('graph-hooks install: copies scripts/graph-refresh.sh to target', () => {
  const target = makeGitRepo();
  try {
    const r = runGraphHooksInstall([target]);
    assert.equal(r.status, 0, `exit 0 expected\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(existsSync(join(target, 'scripts', 'graph-refresh.sh')), 'scripts/graph-refresh.sh must exist');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('graph-hooks install: wrapper has {{ENGINE}} substituted to graphify (default)', () => {
  const target = makeGitRepo();
  try {
    runGraphHooksInstall([target]);
    const wrapper = readFileSync(join(target, 'scripts', 'graph-refresh.sh'), 'utf8');
    assert.ok(!wrapper.includes('{{ENGINE}}'), 'wrapper must not contain unsubstituted {{ENGINE}} token');
    assert.ok(wrapper.includes('graphify'), 'wrapper must reference graphify (default engine)');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('graph-hooks install: wrapper is executable', () => {
  const target = makeGitRepo();
  try {
    runGraphHooksInstall([target]);
    assert.ok(isExecutable(join(target, 'scripts', 'graph-refresh.sh')), 'wrapper must be executable');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (c) graph-automation/config.json written
// ---------------------------------------------------------------------------

test('graph-hooks install: writes graph-automation/config.json', () => {
  const target = makeGitRepo();
  try {
    const r = runGraphHooksInstall([target]);
    assert.equal(r.status, 0, `exit 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(existsSync(join(target, 'graph-automation', 'config.json')), 'graph-automation/config.json must exist');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('graph-hooks install: config.json has engine=graphify (default)', () => {
  const target = makeGitRepo();
  try {
    runGraphHooksInstall([target]);
    const cfg = JSON.parse(readFileSync(join(target, 'graph-automation', 'config.json'), 'utf8'));
    assert.equal(cfg.engine, 'graphify', 'config.json engine must be graphify by default');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (d) harness NEXT-STEPS printed to stdout, NOT written to files
// ---------------------------------------------------------------------------

test('graph-hooks install: prints harness hook NEXT-STEPS to stdout', () => {
  const target = makeGitRepo();
  try {
    const r = runGraphHooksInstall([target]);
    assert.equal(r.status, 0, `exit 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    // Should print guidance about harness hooks
    assert.match(
      r.stdout,
      /next.step|harness|Stop|SessionStart|settings\.json|hooks\.json/i,
      `stdout must contain harness hook guidance\nstdout: ${r.stdout}`,
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('graph-hooks install: does NOT write .claude/settings.json (print only)', () => {
  const target = makeGitRepo();
  const fakeHome = makeTmpDir('ai-catapult-gh-home-');
  mkdirSync(join(fakeHome, '.claude'), { recursive: true });
  try {
    const r = runGraphHooksInstall([target], { home: fakeHome });
    assert.equal(r.status, 0, `expected exit 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /graph-hooks install|wired|engine/i, `stdout must show install completed\nstdout: ${r.stdout}`);
    // settings.json inside the target dir should not be created
    assert.ok(
      !existsSync(join(target, '.claude', 'settings.json')),
      '.claude/settings.json must NOT be written into target (print-only)',
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('graph-hooks install: does NOT write .codex/hooks.json (print only)', () => {
  const target = makeGitRepo();
  try {
    const r = runGraphHooksInstall([target]);
    assert.equal(r.status, 0, `expected exit 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /graph-hooks install|wired|engine/i, `stdout must show install completed\nstdout: ${r.stdout}`);
    assert.ok(
      !existsSync(join(target, '.codex', 'hooks.json')),
      '.codex/hooks.json must NOT be written into target (print-only)',
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (e) --engine graphwiki substitutes correctly
// ---------------------------------------------------------------------------

test('graph-hooks install --engine graphwiki: wrapper contains graphwiki', () => {
  const target = makeGitRepo();
  try {
    const r = runGraphHooksInstall([target, '--engine', 'graphwiki']);
    assert.equal(r.status, 0, `exit 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const wrapper = readFileSync(join(target, 'scripts', 'graph-refresh.sh'), 'utf8');
    assert.ok(!wrapper.includes('{{ENGINE}}'), 'no unsubstituted tokens');
    assert.ok(wrapper.includes('graphwiki'), 'wrapper must reference graphwiki');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('graph-hooks install --engine graphwiki: config.json engine=graphwiki', () => {
  const target = makeGitRepo();
  try {
    runGraphHooksInstall([target, '--engine', 'graphwiki']);
    const cfg = JSON.parse(readFileSync(join(target, 'graph-automation', 'config.json'), 'utf8'));
    assert.equal(cfg.engine, 'graphwiki');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (f) --dry-run: no writes
// ---------------------------------------------------------------------------

test('graph-hooks install --dry-run: exits 0', () => {
  const target = makeGitRepo();
  try {
    const r = runGraphHooksInstall([target, '--dry-run']);
    assert.equal(r.status, 0, `exit 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('graph-hooks install --dry-run: does not write hooks', () => {
  const target = makeGitRepo();
  try {
    const r = runGraphHooksInstall([target, '--dry-run']);
    assert.equal(r.status, 0, `expected exit 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /dry.run/i, `stdout must mention dry-run\nstdout: ${r.stdout}`);
    assert.ok(!existsSync(join(target, '.git', 'hooks', 'post-commit')), 'post-commit must not exist in dry-run');
    assert.ok(!existsSync(join(target, '.git', 'hooks', 'post-checkout')), 'post-checkout must not exist in dry-run');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('graph-hooks install --dry-run: does not write wrapper', () => {
  const target = makeGitRepo();
  try {
    const r = runGraphHooksInstall([target, '--dry-run']);
    assert.equal(r.status, 0, `expected exit 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /dry.run/i, `stdout must mention dry-run\nstdout: ${r.stdout}`);
    assert.ok(!existsSync(join(target, 'scripts', 'graph-refresh.sh')), 'wrapper must not exist in dry-run');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('graph-hooks install --dry-run: does not write config.json', () => {
  const target = makeGitRepo();
  try {
    const r = runGraphHooksInstall([target, '--dry-run']);
    assert.equal(r.status, 0, `expected exit 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /dry.run/i, `stdout must mention dry-run\nstdout: ${r.stdout}`);
    assert.ok(!existsSync(join(target, 'graph-automation', 'config.json')), 'config.json must not exist in dry-run');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('graph-hooks install --dry-run: prints what would happen', () => {
  const target = makeGitRepo();
  try {
    const r = runGraphHooksInstall([target, '--dry-run']);
    assert.match(r.stdout, /dry.run/i, `stdout must mention dry-run\nstdout: ${r.stdout}`);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (g) idempotent re-install: single marker block (no duplication)
// ---------------------------------------------------------------------------

test('graph-hooks install: idempotent — two installs produce single marker block in hooks', () => {
  const target = makeGitRepo();
  try {
    runGraphHooksInstall([target]);
    runGraphHooksInstall([target]);
    const body = readHook(target, 'post-commit');
    const startCount = (body.match(new RegExp(MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;
    assert.equal(startCount, 1, `expected exactly one marker block, got ${startCount}\n${body}`);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('graph-hooks install: idempotent — preserves pre-existing hook content outside markers', () => {
  const target = makeGitRepo();
  const hooksDir = join(target, '.git', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const preExisting = '#!/usr/bin/env bash\necho "pre-existing hook"\n';
  writeFileSync(join(hooksDir, 'post-commit'), preExisting, { mode: 0o755 });

  try {
    runGraphHooksInstall([target]);
    runGraphHooksInstall([target]);
    const body = readHook(target, 'post-commit');
    assert.ok(body.includes('pre-existing hook'), 'pre-existing hook content must be preserved');
    const startCount = (body.match(new RegExp(MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;
    assert.equal(startCount, 1, `expected exactly one marker block after two installs\n${body}`);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (i) core.hooksPath: installs to resolved hooksPath when set
// ---------------------------------------------------------------------------

test('graph-hooks install: respects core.hooksPath when set', () => {
  const target = makeGitRepo();
  const customHooksDir = join(target, '.githooks');
  mkdirSync(customHooksDir, { recursive: true });

  spawnSync('git', ['-C', target, 'config', 'core.hooksPath', '.githooks'], { encoding: 'utf8' });

  try {
    const r = runGraphHooksInstall([target]);
    assert.equal(r.status, 0, `exit 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(existsSync(join(customHooksDir, 'post-commit')), 'post-commit must land in core.hooksPath dir');
    assert.ok(existsSync(join(customHooksDir, 'post-checkout')), 'post-checkout must land in core.hooksPath dir');
    // The standard .git/hooks must NOT have the files when hooksPath overrides
    assert.ok(!existsSync(join(target, '.git', 'hooks', 'post-commit')), 'post-commit must not be in .git/hooks when hooksPath is set');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (j) packed-tarball path
// ---------------------------------------------------------------------------

test('packed graph-hooks install: hooks + wrapper land from extracted tarball', () => {
  const extractedBin = join(extractDir, 'package', 'bin', 'ai-catapult.js');
  const target = makeGitRepo('ai-catapult-gh-packed-target-');
  const fakeHome = makeTmpDir('ai-catapult-gh-packed-home-');

  try {
    const r = spawnSync(process.execPath, [extractedBin, 'graph-hooks', 'install', target], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: fakeHome,
        CODEX_HOME: join(fakeHome, '.codex'),
      },
    });

    assert.equal(r.status, 0, `packed install exit 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(existsSync(join(target, '.git', 'hooks', 'post-commit')), 'post-commit must exist after packed install');
    assert.ok(existsSync(join(target, '.git', 'hooks', 'post-checkout')), 'post-checkout must exist after packed install');
    assert.ok(existsSync(join(target, 'scripts', 'graph-refresh.sh')), 'wrapper must exist after packed install');
    assert.ok(existsSync(join(target, 'graph-automation', 'config.json')), 'config.json must exist after packed install');

    // Engine token must be substituted
    const wrapper = readFileSync(join(target, 'scripts', 'graph-refresh.sh'), 'utf8');
    assert.ok(!wrapper.includes('{{ENGINE}}'), 'wrapper must not contain unsubstituted {{ENGINE}} token');
  } finally {
    rmSync(target, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (l) engine-absent: exits 0 (wrapper is written; runtime no-op is wrapper's concern)
// ---------------------------------------------------------------------------

test('graph-hooks install: exits 0 even when engine binary is not on PATH', () => {
  const target = makeGitRepo();
  try {
    // Provide a PATH with no graphify/graphwiki
    const r = spawnSync(process.execPath, [bin, 'graph-hooks', 'install', target], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: '/usr/bin:/bin',
        HOME: '/nonexistent-no-home',
        CODEX_HOME: '/nonexistent-no-codex',
      },
    });
    assert.equal(r.status, 0, `expected exit 0 when engine absent\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    // Wrapper is still written — the no-op is handled at runtime by the wrapper itself
    assert.ok(existsSync(join(target, 'scripts', 'graph-refresh.sh')), 'wrapper must still be written');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (m) ancestor-wrapper guard
// ---------------------------------------------------------------------------

test('graph-hooks install: refuses install when ancestor repo has a wrapper (exit 1, names ancestor)', () => {
  // Create umbrella (ancestor) with wrapper + .git
  const umbrella = makeGitRepo('ai-catapult-gh-umbrella-');
  // Create a child repo nested inside the umbrella
  const childDir = join(umbrella, 'packages', 'child');
  mkdirSync(childDir, { recursive: true });
  spawnSync('git', ['init', childDir], { encoding: 'utf8' });
  // Plant a wrapper in the umbrella
  mkdirSync(join(umbrella, 'scripts'), { recursive: true });
  writeFileSync(join(umbrella, 'scripts', 'graph-refresh.sh'), '#!/usr/bin/env bash\necho wrapper\n');

  try {
    const r = runGraphHooksInstall([childDir], { home: '/nonexistent-no-home' });
    assert.equal(r.status, 1, `expected exit 1 when ancestor has wrapper\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(
      r.stderr,
      new RegExp(umbrella.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `stderr must name the ancestor path\nstderr: ${r.stderr}`,
    );
    assert.match(
      r.stderr,
      /ancestor|wrapper|graph/i,
      `stderr must mention ancestor wrapper\nstderr: ${r.stderr}`,
    );
  } finally {
    rmSync(umbrella, { recursive: true, force: true });
  }
});

test('graph-hooks install --force: proceeds despite ancestor wrapper', () => {
  const umbrella = makeGitRepo('ai-catapult-gh-umbrella-force-');
  const childDir = join(umbrella, 'packages', 'child');
  mkdirSync(childDir, { recursive: true });
  spawnSync('git', ['init', childDir], { encoding: 'utf8' });
  mkdirSync(join(umbrella, 'scripts'), { recursive: true });
  writeFileSync(join(umbrella, 'scripts', 'graph-refresh.sh'), '#!/usr/bin/env bash\necho wrapper\n');

  try {
    const r = runGraphHooksInstall([childDir, '--force'], { home: '/nonexistent-no-home' });
    assert.equal(r.status, 0, `expected exit 0 with --force\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(existsSync(join(childDir, '.git', 'hooks', 'post-commit')), 'post-commit must be written with --force');
    assert.ok(existsSync(join(childDir, 'scripts', 'graph-refresh.sh')), 'wrapper must be written with --force');
  } finally {
    rmSync(umbrella, { recursive: true, force: true });
  }
});

test('graph-hooks install: unaffected when no ancestor has a wrapper', () => {
  // Repo with no ancestors containing a wrapper — plain standalone repo
  const target = makeGitRepo('ai-catapult-gh-standalone-');
  try {
    const r = runGraphHooksInstall([target], { home: '/nonexistent-no-home' });
    assert.equal(r.status, 0, `expected exit 0 with no ancestor wrapper\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(existsSync(join(target, '.git', 'hooks', 'post-commit')), 'post-commit must be written');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (n) --engine allow-list validation
// ---------------------------------------------------------------------------

test('graph-hooks install --engine invalid: exits 1 with clean error', () => {
  const target = makeGitRepo('ai-catapult-gh-engine-invalid-');
  try {
    const r = runGraphHooksInstall([target, '--engine', 'badengine']);
    assert.equal(r.status, 1, `expected exit 1 for invalid engine\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(
      r.stderr,
      /invalid.*engine|engine.*invalid|must be one of/i,
      `stderr must mention invalid engine\nstderr: ${r.stderr}`,
    );
    assert.match(r.stderr, /graphify/, `stderr must list valid engines\nstderr: ${r.stderr}`);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('graph-hooks install --engine (bare flag): exits 1 with clean error', () => {
  // Bare --engine without a value causes the parser to set engine=true (boolean),
  // which must be caught as invalid rather than crashing with a JSON.parse stack trace.
  const target = makeGitRepo('ai-catapult-gh-engine-bare-');
  try {
    const r = runGraphHooksInstall([target, '--engine']);
    assert.equal(r.status, 1, `expected exit 1 for bare --engine\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(
      r.stderr,
      /invalid.*engine|engine.*invalid|must be one of/i,
      `stderr must mention invalid engine\nstderr: ${r.stderr}`,
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});
