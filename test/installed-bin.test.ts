/**
 * The published package must execute when installed — and npm installs put the
 * package inside node_modules, where Node's type stripping does not apply
 * (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). The bin map therefore must
 * not target an authored `.ts` file; it must target the compiled
 * `dist/bin/ai-catapult.js` that ships in `files`.
 *
 * Execution additionally routes through npm's bin link (a symlink chain on
 * POSIX: `<prefix>/bin/ai-catapult` → `node_modules/.bin/ai-catapult` → the
 * entry file). The bin entrypoint is an entrypoint, never an imported module —
 * v1 executed its module body unconditionally; the port's `argv[1] ===
 * fileURLToPath(import.meta.url)` guard reintroduced dispatch and silently
 * exited through those links (`process.argv[1]` is the link path, not the real
 * module path). Both defects here: the bin must dispatch through a symlink,
 * and the installed `.ts` target must fail loudly in tests, not silently break
 * for users.
 *
 * The end-to-end assertion is staged-install shaped: `stageScopedPackage` lays
 * down the exact `files[]` payload the publish would pack, and the test mounts
 * it at `node_modules/ai-catapult` with npm's POSIX bin link rebuilt by hand.
 * No `npm pack` against the live repository tree — pack.test.ts forbids that
 * inside the suite (npm pack walks the live dist/ directory while other tests
 * write it) — and dist/ is likewise supplied from the stable snapshot rather
 * than the live dist/ that plugin tests wipe and rebuild concurrently. A
 * relative symlink's exec requirement falls on the TARGET, so the compiled
 * compiled artifact must carry its exec bit too: tsc emits 0644, and
 * prepare-dist.ts restores 0755, matching the tracked bin's mode.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageScopedPackage } from '../scripts/publish-both.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  version: string;
  bin: Record<string, string>;
};

/** realpathed temp dir: entries spawn from stable, symlink-free paths. */
function makeTmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-`)));
}

void test('package.json bin map does not target an authored .ts file', () => {
  const target = pkg.bin['ai-catapult'];
  assert.ok(target, 'package.json must declare the ai-catapult bin');
  assert.ok(
    !target.endsWith('.ts'),
    `bin target ${target} is TypeScript; Node refuses type stripping beneath node_modules ` +
      `(ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING) — the installed CLI cannot run`,
  );
  assert.ok(
    target.startsWith('dist/'),
    `bin target ${target} must be compiled output under dist/`,
  );
});

void test('repo bin dispatches identically when invoked through a symlink', () => {
  const dir = makeTmp('ai-catapult-symlink-bin');
  const link = join(dir, 'ai-catapult');
  symlinkSync(join(root, 'bin/ai-catapult.ts'), link);
  const direct = spawnSync(process.execPath, [join(root, 'bin/ai-catapult.ts'), '--version'], {
    encoding: 'utf8',
  });
  const viaLink = spawnSync(process.execPath, [link, '--version'], { encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(direct.status, 0, `direct bin failed: ${direct.stderr}`);
  assert.ok(direct.stdout.includes(pkg.version), `direct bin printed ${JSON.stringify(direct.stdout)}`);
  assert.equal(
    viaLink.status,
    0,
    `symlinked invocation exits ${viaLink.status}; expected 0. ` +
      `stderr: ${viaLink.stderr || '(empty)'}`,
  );
  assert.ok(
    viaLink.stdout.includes(pkg.version),
    `symlinked invocation printed ${JSON.stringify(viaLink.stdout)} (stderr ${JSON.stringify(viaLink.stderr)}) — ` +
      'the entry guard must not skip dispatch for link-style invocations',
  );
});

void test('the staged package installs and executes through its node_modules bin link', () => {
  const stageDir = makeTmp('ai-catapult-staged-install');
  const consumer = makeTmp('ai-catapult-consumer');
  try {
    // The exact files[] payload a publish would pack, mounted the way npm
    // install leaves it: node_modules/ai-catapult plus the POSIX bin shim.
    // dist/ is supplied from the stable snapshot (dist-snapshot/, or whatever
    // AI_CATAPULT_DIST_ROOT points at): plugin tests wipe and rebuild the live
    // dist/ concurrently, and staging directly from it races a half-wiped
    // tree — packed-init.test.ts made the same trade for its npm pack.
    const stableDist = existsSync(join(root, 'dist-snapshot')) ? 'dist-snapshot' : 'dist';
    stageScopedPackage(root, stageDir, { distSource: stableDist });
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', version: '1.0.0' }) + '\n');
    const nm = join(consumer, 'node_modules');
    mkdirSync(join(nm, '.bin'), { recursive: true });
    symlinkSync(stageDir, join(nm, 'ai-catapult'), 'dir');

    const binTargetDeclared = pkg.bin['ai-catapult'];
    assert.ok(binTargetDeclared, 'package.json must declare the ai-catapult bin');
    const declaredTarget = join(nm, 'ai-catapult', binTargetDeclared);
    assert.ok(existsSync(declaredTarget), `declared bin target missing from the package: ${binTargetDeclared}`);

    // npm's POSIX bin link is a relative symlink into the package, and exec
    // permission is resolved on its target: the mode bits recorded in the
    // tarball survive install, so a 0644 artifact yields a CLI that cannot be
    // executed at all (EACCES).
    const targetMode = statSync(declaredTarget).mode & 0o777;
    assert.ok(
      (targetMode & 0o111) !== 0,
      `compiled bin staged with mode ${targetMode.toString(8)} — npm's bin link needs exec on the target ` +
        'or every installed invocation fails with EACCES',
    );
    const shim = join(nm, '.bin/ai-catapult');
    symlinkSync(join('..', 'ai-catapult', binTargetDeclared), shim);

    // Direct execution of the declared target inside node_modules (the F1
    // repro: Node refuses type stripping beneath node_modules).
    const direct = spawnSync(process.execPath, [declaredTarget, '--version'], { encoding: 'utf8' });
    assert.equal(
      direct.status,
      0,
      `installed bin failed when executed directly under node_modules (status ${direct.status}): ` +
        `${direct.stderr || direct.stdout}`,
    );
    assert.ok(direct.stdout.includes(pkg.version), `installed bin printed ${JSON.stringify(direct.stdout)}`);

    // Execution the way users get it: through the bin link (resolved argv[1]
    // is the link path — the old entry guard silently dropped it; see the F2
    // repro).
    const viaShim = spawnSync(shim, ['--version'], { encoding: 'utf8' });
    assert.equal(
      viaShim.status,
      0,
      `installed bin failed through the npm bin link (status ${viaShim.status}): ${viaShim.stderr || viaShim.stdout}`,
    );
    assert.ok(viaShim.stdout.includes(pkg.version), `shim invocation printed ${JSON.stringify(viaShim.stdout)}`);
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
    rmSync(consumer, { recursive: true, force: true });
  }
});