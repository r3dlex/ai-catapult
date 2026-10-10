/**
 * TDD tests for Goal tswc-ac-b1 AC-1/AC-3 — evolve/ workspace layout machinery.
 *
 * The evolve/ workspace is the WikiSkill three-layer workspace (master intake
 * §3a) implemented as deterministic CLI machinery:
 *
 *   evolve/raw/<run-id>/   write-once immutable traces (incl. judgment records)
 *   evolve/wiki/           append-only logs.md + skill-impact.md — never rolled back
 *   evolve/proposals/      overlay staging (single-skill proposals until accepted)
 *   evolve/PURPOSE.md      the PURPOSE.md convention — declares the three-layer
 *                          workspace, its role split and its invariants
 *
 * Red-leg mutation proof per §4.7 lives inside these tests: every invariant is
 * paired with a negative fixture that plants a violation and asserts the
 * deterministic machinery refuses or detects it (a mutated PURPOSE.md byte, a
 * foreign file, a write-once overwrite, a truncating transition).
 *
 * All filesystem work happens in mkdtemp() dirs under os.tmpdir(); nothing in
 * the checkout is ever written.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  EVOLVE_DIR,
  evolvePaths,
  initEvolveLayout,
  verifyEvolveLayout,
} from '../src/evolve/layout.ts';
import { recordTrace } from '../src/evolve/write-once.ts';
import { appendWikiFile, assertAppendOnly } from '../src/evolve/append-only.ts';
import { stageOverlay } from '../src/evolve/proposals.ts';
import { EvolveError } from '../src/evolve/errors.ts';
import type { EvolvePaths } from '../src/evolve/layout.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureLayout = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/evolve/layout.expected.json'), 'utf8'),
) as {
  schema: string;
  root_dir: string;
  files: string[];
  dirs: string[];
  files_must_not_exist: string[];
  purpose_sha256: string;
};

/** Create a temp root directory for test isolation. Returns absolute path. */
function makeTmpRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return root;
}

/** Recursively collect all files under a directory as sorted relative paths. */
function collectFiles(dir: string, base: string = dir, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(fullPath, base, acc);
    } else {
      acc.push(relative(base, fullPath));
    }
  }
  return acc;
}

/** Recursively collect all directories under a directory as sorted relative paths. */
function collectDirs(dir: string, base: string = dir, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      acc.push(relative(base, fullPath));
      collectDirs(fullPath, base, acc);
    }
  }
  return acc;
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Hash an entire tree byte-exactly, walking files in sorted order. */
function treeDigest(root: string): string {
  const parts: string[] = [];
  for (const rel of collectFiles(root)) {
    parts.push(`${rel}:${sha256(readFileSync(join(root, rel)))}`);
  }
  return sha256(Buffer.from(parts.join('\n'), 'utf8'));
}

/** Init a fresh evolve/ workspace in a temp root and return its paths. */
function initTmpLayout(prefix: string): { paths: EvolvePaths; root: string } {
  const root = makeTmpRoot(prefix);
  const paths = evolvePaths(root);
  initEvolveLayout(root);
  return { paths, root };
}

type PatchedFsFunction = (...args: unknown[]) => unknown;

/**
 * Patch functions on the node:fs builtin for the duration of `run` and
 * re-sync the builtin's ESM exports, so already-loaded modules that imported
 * these functions by name observe the patch (the same mechanism the round-2
 * review used to reproduce the check-to-open swap). Test-only helper.
 */
function withPatchedFs<T>(
  patches: Partial<Record<'lstatSync' | 'realpathSync' | 'openSync' | 'writeSync' | 'writeFileSync', PatchedFsFunction>>,
  run: () => T,
): T {
  const originals: Array<[string, unknown]> = [];
  try {
    for (const [name, replacement] of Object.entries(patches)) {
      if (replacement === undefined) continue;
      originals.push([name, Reflect.get(fs, name) as unknown]);
      Reflect.set(fs, name, replacement);
    }
    syncBuiltinESMExports();
    return run();
  } finally {
    for (const [name, original] of originals) Reflect.set(fs, name, original);
    if (originals.length > 0) syncBuiltinESMExports();
  }
}

void test('evolve layout golden: init produces exactly the fixture-conforming three-layer tree', () => {
  const { paths, root } = initTmpLayout('evolve-layout-golden-');
  const evolveDir = paths.evolveDir;

  try {
    assert.equal(evolveDir.startsWith(root), true);
    assert.equal(evolveDir.endsWith(EVOLVE_DIR), true);

    // Exact file set (no .keep placeholders — dirs are structurally implied).
    assert.deepEqual(collectFiles(evolveDir).sort(), fixtureLayout.files.slice().sort());
    assert.deepEqual(collectDirs(evolveDir).sort(), fixtureLayout.dirs.slice().sort());

    for (const rel of fixtureLayout.files) {
      assert.equal(existsSync(join(evolveDir, rel)), true, `expected file: ${rel}`);
    }
    for (const rel of fixtureLayout.dirs) {
      assert.equal(statSync(join(evolveDir, rel)).isDirectory(), true, `expected dir: ${rel}`);
    }
    for (const rel of fixtureLayout.files_must_not_exist) {
      assert.equal(existsSync(join(evolveDir, rel)), false, `must not exist: ${rel}`);
    }

    // PURPOSE.md convention is pinned byte-level by the fixture digest.
    assert.equal(sha256(readFileSync(paths.purposeFile)), fixtureLayout.purpose_sha256);

    // The three wiki/layer files start deterministically.
    assert.equal(readFileSync(paths.wikiLogsFile, 'utf8'), '');
    assert.equal(readFileSync(paths.wikiSkillImpactFile, 'utf8'), '');

    // Structural verification is green on a fresh workspace.
    const verified = verifyEvolveLayout(root);
    assert.deepEqual(verified, { ok: true, violations: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('evolve layout idempotency: re-init on a conforming workspace creates nothing and changes no bytes', () => {
  const { root } = initTmpLayout('evolve-layout-idem-');
  try {
    const before = treeDigest(root);
    const second = initEvolveLayout(root);
    assert.deepEqual(second, { created: [], existed: true });
    assert.equal(treeDigest(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('evolve layout init fails closed on a mutated PURPOSE.md instead of silently keeping it', () => {
  const root = makeTmpRoot('evolve-layout-mutated-');
  try {
    const paths = evolvePaths(root);
    mkdirSync(join(root, EVOLVE_DIR), { recursive: true });
    writeFileSync(paths.purposeFile, '# evolve workspace — purpose\n\nTAMPERED\n', 'utf8');
    // Red-leg mutation fixture: init must refuse to bless a tampered PURPOSE.md.
    assert.throws(() => initEvolveLayout(root), (err: unknown) =>
      err instanceof EvolveError && err.kind === 'layout-violation',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('evolve verify: mutated PURPOSE.md and foreign files are detected; restored tree verifies clean again', () => {
  const { root } = initTmpLayout('evolve-layout-verify-');
  try {
    assert.deepEqual(verifyEvolveLayout(root), { ok: true, violations: [] });

    // Mutation 1: one flipped byte in PURPOSE.md must be caught.
    const paths = evolvePaths(root);
    writeFileSync(paths.purposeFile, readFileSync(paths.purposeFile).toString('utf8') + 'X', 'utf8');
    const mutated = verifyEvolveLayout(root);
    assert.equal(mutated.ok, false);
    assert.equal(mutated.violations.some((v) => v.path === 'PURPOSE.md'), true);

    // Mutation 2: a foreign file at the workspace root must be caught.
    writeFileSync(paths.purposeFile, 'x', 'utf8');
    writeFileSync(join(paths.evolveDir, 'stray.txt'), 'foreign', 'utf8');
    const foreign = verifyEvolveLayout(root);
    assert.equal(foreign.ok, false);
    // One violation names the mutated purpose bytes, one the stray file.
    assert.equal(foreign.violations.some((v) => v.path === 'PURPOSE.md'), true);
    assert.equal(foreign.violations.some((v) => v.path === 'stray.txt'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('evolve verify: unexpected entries under wiki/ and non-run dirs under raw/ are detected', () => {
  const { root } = initTmpLayout('evolve-layout-scan-');
  const paths = evolvePaths(root);
  try {
    writeFileSync(join(paths.wikiDir, 'draft-notes.md'), 'not expected', 'utf8');
    const wikiDrift = verifyEvolveLayout(root);
    assert.equal(wikiDrift.ok, false);
    assert.equal(wikiDrift.violations.some((v) => v.path === 'wiki/draft-notes.md'), true);

    mkdirSync(join(paths.rawDir, 'Invalid_RunID!'), { recursive: true });
    const rawDrift = verifyEvolveLayout(root);
    assert.equal(rawDrift.ok, false);
    assert.equal(
      rawDrift.violations.some((v) => v.path === 'raw/Invalid_RunID!'),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('evolve verify: valid run-id directories under raw/ are accepted', () => {
  const { paths, root } = initTmpLayout('evolve-layout-runs-');
  try {
    mkdirSync(join(paths.rawDir, 'run-2026-10-10-alpha'), { recursive: true });
    assert.deepEqual(verifyEvolveLayout(root), { ok: true, violations: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('write-once: first trace write succeeds with correct content and digest; any second write is refused', () => {
  const { paths, root } = initTmpLayout('evolve-write-once-');
  try {
    const written = recordTrace(paths, 'run-2026-10-10-alpha', 'trace-turn-1.json', '{"turn":1}\n');
    assert.equal(written.bytes, Buffer.byteLength('{"turn":1}\n'));
    assert.equal(written.sha256, sha256(readFileSync(written.path)));
    assert.ok(written.path.endsWith('evolve/raw/run-2026-10-10-alpha/trace-turn-1.json'));

    // Red-leg mutation fixture: an overwrite with IDENTICAL bytes is still refused —
    // write-once means first write wins, unconditionally.
    assert.throws(() => recordTrace(paths, 'run-2026-10-10-alpha', 'trace-turn-1.json', '{"turn":1}\n'), (err: unknown) =>
      err instanceof EvolveError && err.kind === 'write-once-violation',
    );
    // Overwrite with different bytes is refused as well.
    assert.throws(() => recordTrace(paths, 'run-2026-10-10-alpha', 'trace-turn-1.json', '{"turn":2}\n'));

    // The file on disk is untouched by the refused writes.
    assert.equal(readFileSync(written.path, 'utf8'), '{"turn":1}\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('write-once: unsafe run ids and trace names are refused before any file lands', () => {
  const { paths, root } = initTmpLayout('evolve-unsafe-');
  const unsafeRunIds: string[] = ['Run-2026', 'run/2026', 'run..2026/../x', '', 'run with spaces', 'run\u0000id'];
  const unsafeNames: string[] = ['../escape.json', 'sub/turn.json', '', '.hidden', '\u0000x'];
  try {
    for (const runId of unsafeRunIds) {
      assert.throws(
        () => recordTrace(paths, runId, 'trace.json', '{}'),
        (err: unknown) => err instanceof EvolveError && err.kind === 'unsafe-path',
        `run id "${runId}" must be refused`,
      );
    }
    for (const name of unsafeNames) {
      assert.throws(
        () => recordTrace(paths, 'run-2026-10-10-alpha', name, '{}'),
        (err: unknown) => err instanceof EvolveError && err.kind === 'unsafe-path',
        `trace name "${name}" must be refused`,
      );
    }
    // Nothing was written anywhere.
    assert.deepEqual(collectFiles(paths.rawDir), []);
    assert.deepEqual(collectDirs(paths.rawDir), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('append-only: prefix-extension transitions pass; truncation, rewrite and non-extension are refused', () => {
  const before = 'line-1\nline-2\n';

  assertAppendOnly(before, before); // no-op append (empty entry) is allowed
  assertAppendOnly(before, before + 'line-3\n'); // pure extension is allowed
  assertAppendOnly('', 'anything\n'); // extension from an empty wiki file is allowed
  // Byte-level semantics: any tail — including multi-byte UTF-8 characters —
  // is a pure extension and must be accepted.
  assertAppendOnly(before, before + '✅ appended learning\n');

  assert.throws(() => assertAppendOnly(before, 'line-1\n'), (err: unknown) =>
    err instanceof EvolveError && err.kind === 'append-only-violation',
  );
  assert.throws(() => assertAppendOnly(before, 'line-1 edited\nline-2\n'), (err: unknown) =>
    err instanceof EvolveError && err.kind === 'append-only-violation',
  );
  assert.throws(() => assertAppendOnly(before, 'line-2\n'), (err: unknown) =>
    err instanceof EvolveError && err.kind === 'append-only-violation',
  );
  // Prepending rewrites bytes too.
  assert.throws(() => assertAppendOnly(before, 'line-0\n' + before), (err: unknown) =>
    err instanceof EvolveError && err.kind === 'append-only-violation',
  );
});

void test('append-only machinery: wiki entries append byte-exactly and the workspace stays verifiable', () => {
  const { paths, root } = initTmpLayout('evolve-append-');
  try {
    appendWikiFile(paths, 'logs.md', 'entry-one\n');
    appendWikiFile(paths, 'skill-impact.md', 'impact: +2 skills touched\n');

    assert.equal(readFileSync(paths.wikiLogsFile, 'utf8'), 'entry-one\n');
    assert.equal(readFileSync(paths.wikiSkillImpactFile, 'utf8'), 'impact: +2 skills touched\n');

    appendWikiFile(paths, 'logs.md', 'entry-two\n');
    // log history is preserved in order (append, never rewrite)
    assert.equal(readFileSync(paths.wikiLogsFile, 'utf8'), 'entry-one\nentry-two\n');
    assert.deepEqual(verifyEvolveLayout(root), { ok: true, violations: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('append-only machinery refuses to append to a missing wiki file instead of creating it', () => {
  const root = makeTmpRoot('evolve-append-missing-');
  const paths = evolvePaths(root);
  try {
    mkdirSync(join(root, EVOLVE_DIR), { recursive: true });
    assert.throws(() => appendWikiFile(paths, 'logs.md', 'x\n'), (err: unknown) =>
      err instanceof EvolveError && err.kind === 'layout-violation',
    );
    assert.equal(existsSync(paths.wikiLogsFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('write-once and append-only refuse symlinks that would escape the workspace', () => {
  const { paths, root } = initTmpLayout('evolve-symlink-');
  const outside = join(root, 'outside');
  try {
    mkdirSync(outside);
    writeFileSync(join(outside, 'kept.txt'), 'keep', 'utf8');
    symlinkSync(outside, join(paths.rawDir, 'run-2026-10-10-alpha'));
    assert.throws(
      () => recordTrace(paths, 'run-2026-10-10-alpha', 'trace.json', '{}\n'),
      (err: unknown) => err instanceof EvolveError && err.kind === 'unsafe-path',
    );
    assert.equal(existsSync(join(outside, 'trace.json')), false);

    const outsideLog = join(outside, 'log.md');
    writeFileSync(outsideLog, 'keep', 'utf8');
    rmSync(paths.wikiLogsFile);
    symlinkSync(outsideLog, paths.wikiLogsFile);
    assert.throws(
      () => appendWikiFile(paths, 'logs.md', 'escaped\n'),
      (err: unknown) => err instanceof EvolveError && err.kind === 'unsafe-path',
    );
    assert.equal(readFileSync(outsideLog, 'utf8'), 'keep');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('ancestor symlinks are refused: trace, wiki and overlay writes cannot escape through a symlinked evolve/', () => {
  const root = makeTmpRoot('evolve-ancestor-');
  const outside = join(root, 'outside');
  try {
    mkdirSync(outside);
    initEvolveLayout(outside);
    symlinkSync(join(outside, EVOLVE_DIR), join(root, EVOLVE_DIR));
    const paths = evolvePaths(root);
    const attempts: Array<[string, () => unknown]> = [
      ['trace', () => recordTrace(paths, 'run-2026-10-10-alpha', 'trace.json', 'escaped trace\n')],
      ['wiki', () => appendWikiFile(paths, 'logs.md', 'escaped wiki\n')],
      ['overlay', () => stageOverlay(paths, 'test-skill', 'escaped overlay\n')],
    ];
    for (const [label, attempt] of attempts) {
      assert.throws(
        attempt,
        (err: unknown) => err instanceof EvolveError && err.kind === 'unsafe-path',
        `${label} write must refuse the symlinked ancestor instead of following it`,
      );
    }
    // The external workspace never received a byte.
    assert.equal(readFileSync(join(outside, EVOLVE_DIR, 'wiki', 'logs.md'), 'utf8'), '');
    assert.deepEqual(collectFiles(join(outside, EVOLVE_DIR, 'raw')), []);
    assert.deepEqual(collectFiles(join(outside, EVOLVE_DIR, 'proposals')), []);

    // And verification reports the symlinked workspace instead of blessing it.
    const verified = verifyEvolveLayout(root);
    assert.equal(verified.ok, false);
    assert.equal(verified.violations.some((v) => v.reason.includes('real directory')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('init refuses a symlinked wiki/ directory instead of creating wiki files through it', () => {
  const root = makeTmpRoot('evolve-init-wiki-symlink-');
  const outWiki = join(root, 'out-wiki');
  try {
    mkdirSync(join(root, EVOLVE_DIR));
    mkdirSync(outWiki);
    symlinkSync(outWiki, join(root, EVOLVE_DIR, 'wiki'));
    assert.throws(
      () => initEvolveLayout(root),
      (err: unknown) => err instanceof EvolveError && err.kind === 'unsafe-path',
    );
    // Nothing was written into the symlink target.
    assert.deepEqual(collectFiles(outWiki), []);
    assert.equal(existsSync(join(outWiki, 'logs.md')), false);
    assert.equal(existsSync(join(outWiki, 'skill-impact.md')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const SWAP_RUN_ID = 'run-2026-10-10-alpha';

void test('a run directory swapped for a symlink between the check and the write is refused (check-to-open race)', () => {
  const { paths, root } = initTmpLayout('evolve-swap-check-');
  const outside = join(root, 'outside');
  const runDir = join(paths.rawDir, SWAP_RUN_ID);
  const savedDir = `${runDir}-saved`;
  const originalLstat = fs.lstatSync;
  const originalRealpath = fs.realpathSync;
  try {
    mkdirSync(outside);
    mkdirSync(runDir);
    let swapped = false;
    const swap = (): void => {
      if (swapped) return;
      swapped = true;
      renameSync(runDir, savedDir);
      symlinkSync(outside, runDir);
    };
    withPatchedFs(
      {
        // The cure resolves each component by name relative to the verified
        // parent directory, so the swap lands between its lstat and the write.
        lstatSync: (...args: unknown[]) => {
          const answer = (originalLstat as unknown as PatchedFsFunction)(...args);
          if (String(args[0]) === SWAP_RUN_ID) swap();
          return answer;
        },
        // The pre-cure code validated with realpathSync; inject the swap right
        // after that validation returned, exactly as the round-2 review did.
        realpathSync: (...args: unknown[]) => {
          const answer = (originalRealpath as unknown as PatchedFsFunction)(...args);
          if (String(args[0]) === runDir) swap();
          return answer;
        },
      },
      () => {
        assert.throws(
          () => recordTrace(paths, SWAP_RUN_ID, 'trace.json', 'must not escape\n'),
          (err: unknown) => err instanceof EvolveError && err.kind === 'unsafe-path',
        );
      },
    );
    assert.equal(existsSync(join(outside, 'trace.json')), false);
    assert.deepEqual(collectFiles(savedDir), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('a run directory swapped for a symlink immediately before the open cannot receive the write', () => {
  const { paths, root } = initTmpLayout('evolve-swap-open-');
  const outside = join(root, 'outside');
  const runDir = join(paths.rawDir, SWAP_RUN_ID);
  const savedDir = `${runDir}-saved`;
  const targetAbs = join(runDir, 'trace.json');
  const originalOpen = fs.openSync;
  const contents = 'bound to the verified inode\n';
  try {
    mkdirSync(outside);
    mkdirSync(runDir);
    let swapped = false;
    const swap = (): void => {
      if (swapped) return;
      swapped = true;
      renameSync(runDir, savedDir);
      symlinkSync(outside, runDir);
    };
    withPatchedFs(
      {
        openSync: (...args: unknown[]) => {
          // Swap before the open: path-based writes follow the planted symlink
          // out of the workspace, while an inode-bound write cannot.
          if (String(args[0]) === 'trace.json' || String(args[0]) === targetAbs) swap();
          return (originalOpen as unknown as PatchedFsFunction)(...args);
        },
      },
      () => {
        const written = recordTrace(paths, SWAP_RUN_ID, 'trace.json', contents);
        assert.equal(written.bytes, Buffer.byteLength(contents, 'utf8'));
      },
    );
    // The symlink target never received the write…
    assert.equal(existsSync(join(outside, 'trace.json')), false);
    // …the write stayed bound to the verified directory inode.
    assert.equal(readFileSync(join(savedDir, 'trace.json'), 'utf8'), contents);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('append-only concurrent writers do not drop entries', async () => {
  const { root } = initTmpLayout('evolve-concurrent-');
  const layoutUrl = new URL('../src/evolve/layout.ts', import.meta.url).href;
  const appendUrl = new URL('../src/evolve/append-only.ts', import.meta.url).href;
  const script = `
    import { evolvePaths } from ${JSON.stringify(layoutUrl)};
    import { appendWikiFile } from ${JSON.stringify(appendUrl)};
    const paths = evolvePaths(process.env.EVOLVE_ROOT);
    const tag = process.env.EVOLVE_TAG;
    for (let i = 0; i < 40; i += 1) appendWikiFile(paths, 'logs.md', tag + String(i) + '\\n');
  `;
  try {
    await Promise.all(['A', 'B'].map((tag) => spawnAppend(script, root, tag)));
    const lines = readFileSync(join(root, EVOLVE_DIR, 'wiki', 'logs.md'), 'utf8').split('\n').filter((line) => line !== '');
    assert.equal(lines.length, 80);
    assert.equal(lines.filter((line) => line.startsWith('A')).length, 40);
    assert.equal(lines.filter((line) => line.startsWith('B')).length, 40);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('append-only: a concurrent append inside the write window survives (deterministic interleaving)', () => {
  const { paths, root } = initTmpLayout('evolve-interleave-');
  const logsAbs = join(root, EVOLVE_DIR, 'wiki', 'logs.md');
  const originalWriteSync = fs.writeSync;
  const originalWriteFileSync = fs.writeFileSync;
  const ownEntry = 'ours-entry\n';
  let racerLanded = false;
  const race = (): void => {
    if (racerLanded) return;
    racerLanded = true;
    appendFileSync(logsAbs, 'racer-entry\n');
  };
  try {
    withPatchedFs(
      {
        // The cure appends through an O_APPEND file descriptor; inject the
        // competing append immediately before that write.
        writeSync: (...args: unknown[]) => {
          const data = args[1];
          if (Buffer.isBuffer(data) && data.toString('utf8') === ownEntry) race();
          return (originalWriteSync as unknown as PatchedFsFunction)(...args);
        },
        // The pre-cure read-modify-write path truncated through writeFileSync;
        // inject the competing append at that same instant.
        writeFileSync: (...args: unknown[]) => {
          if (String(args[0]) === logsAbs) race();
          return (originalWriteFileSync as unknown as PatchedFsFunction)(...args);
        },
      },
      () => {
        appendWikiFile(paths, 'logs.md', ownEntry);
      },
    );
    assert.equal(racerLanded, true, 'the interleaving must have actually fired');
    const content = readFileSync(logsAbs, 'utf8');
    assert.equal(content.includes(ownEntry), true, 'the writer’s own entry must survive');
    assert.equal(
      content.includes('racer-entry'),
      true,
      'the concurrent append must survive — the old read-modify-write path truncated it away',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function spawnAppend(script: string, root: string, tag: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, EVOLVE_ROOT: root, EVOLVE_TAG: tag },
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`append child ${tag} exited ${code}: ${stderr}`));
    });
  });
}

void test('proposals overlays stage as replaceable single-skill files and stay verifiable', () => {
  const { paths, root } = initTmpLayout('evolve-overlay-');
  try {
    const staged = stageOverlay(paths, 'evolution-rollout', 'overlay-v1\n');
    assert.ok(staged.path.endsWith(join('evolve', 'proposals', 'evolution-rollout.overlay')));
    assert.equal(readFileSync(staged.path, 'utf8'), 'overlay-v1\n');
    assert.deepEqual(verifyEvolveLayout(root), { ok: true, violations: [] });

    stageOverlay(paths, 'evolution-rollout', 'overlay-v2\n');
    assert.equal(readFileSync(staged.path, 'utf8'), 'overlay-v2\n');
    assert.deepEqual(verifyEvolveLayout(root), { ok: true, violations: [] });

    assert.throws(
      () => stageOverlay(paths, '../escape', 'nope\n'),
      (err: unknown) => err instanceof EvolveError && err.kind === 'unsafe-path',
    );

    const outside = join(root, 'outside-overlay');
    writeFileSync(outside, 'keep', 'utf8');
    rmSync(staged.path);
    symlinkSync(outside, staged.path);
    assert.throws(
      () => stageOverlay(paths, 'evolution-rollout', 'pwn\n'),
      (err: unknown) => err instanceof EvolveError && err.kind === 'unsafe-path',
    );
    assert.equal(readFileSync(outside, 'utf8'), 'keep');
    const drifted = verifyEvolveLayout(root);
    assert.equal(drifted.ok, false);
    assert.equal(drifted.violations.some((v) => v.path === 'proposals/evolution-rollout.overlay'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});