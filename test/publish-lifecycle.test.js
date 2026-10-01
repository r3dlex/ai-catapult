import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function publishWithRealNpm(prepackExit) {
  const dir = mkdtempSync(join(tmpdir(), 'publish-lifecycle-'));
  try {
    for (const rel of ['scripts', 'dist/claude-plugin/.claude-plugin', 'dist/codex-plugin/.codex-plugin']) {
      mkdirSync(join(dir, rel), { recursive: true });
    }
    copyFileSync(join(root, 'scripts/publish-both.sh'), join(dir, 'scripts/publish-both.sh'));
    for (const host of ['claude', 'codex']) {
      writeFileSync(join(dir, `dist/${host}-plugin/.${host}-plugin/plugin.json`), '{}');
    }
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'ai-catapult', version: '1.2.3', files: ['dist/'],
      scripts: { prepack: 'node prepack.cjs' },
    }));
    writeFileSync(join(dir, 'prepack.cjs'), `
require('node:fs').appendFileSync('prepack-count', 'ran\\n');
console.log('NOISY_PREPACK_STDOUT');
console.error('PREPACK_DIAGNOSTIC');
process.exit(${prepackExit});
`);
    const result = spawnSync('bash', ['scripts/publish-both.sh', '--package', 'ai-catapult'], {
      cwd: dir, encoding: 'utf8', timeout: 60000,
      env: {
        ...process.env, AI_CATAPULT_PUBLISH: '', CI: '', NPM_PROVENANCE: '',
        // npm 11 pack --json defaults this to true. Exercise that posture even
        // when the developer's npm version or config uses another default.
        npm_config_foreground_scripts: 'true', npm_config_ignore_scripts: 'false',
        npm_config_offline: 'true', npm_config_provenance: 'false',
      },
    });
    return { ...result, lifecycle: readFileSync(join(dir, 'prepack-count'), 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('real npm keeps noisy prepack out of pack JSON and executes lifecycle exactly once', () => {
  const result = publishWithRealNpm(0);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.lifecycle, 'ran\n');
  assert.match(result.stdout, /Dry-run complete/);
  assert.doesNotMatch(result.stdout, /REAL PUBLISH MODE|Publication complete/);
});

test('real npm preserves failing prepack status and diagnostics without completing publication', () => {
  const result = publishWithRealNpm(23);
  assert.equal(result.status, 23, result.stdout + result.stderr);
  assert.equal(result.lifecycle, 'ran\n');
  assert.match(result.stdout + result.stderr, /PREPACK_DIAGNOSTIC/);
  assert.doesNotMatch(result.stdout, /Dry-run complete|Publication complete/);
});
