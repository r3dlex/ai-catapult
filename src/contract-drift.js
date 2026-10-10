/**
 * contract-drift.js — the readiness-contract drift sweep (ACH-C-02, AC-8).
 *
 * Mirrors the pinned contract-run.sh / contract-run-v2.sh verification rule:
 * the driver checks the sha256 of every file named in the vendored
 * readiness-dependency.json (readiness-contract/1) and
 * readiness-dependency-v2.json (readiness-contract/2) copies before anything
 * runs. This module applies the same rule to the six deployment surfaces so an
 * install that would load drifted contract bytes fails instead:
 *
 *   1. vendor/skills            (skills-repo layout: 04-validate-handoff/autobahn
 *                                + 02-govern-plan/northstar)
 *   2-4. dist/<harness>-plugin  (flat payload layout: skills/autobahn +
 *                                skills/northstar)
 *   5. installed marketplace ~/.claude/plugins/ai-catapult (flat layout)
 *   6. the loaded cache resolved from ~/.claude/plugins/installed_plugins.json
 *      installPath for the ai-catapult@* entry (flat layout)
 *   7. the Codex plugin cache ${CODEX_HOME}/plugins/cache/ai-catapult-local/…
 *      (flat layout)
 *   8. the OpenCode skills directory ${XDG_CONFIG_HOME:-~/.config}/opencode/skills
 *
 * Resolution rule (must mirror the pinned driver): a manifest key starting with
 * "northstar/" resolves against the northstar peer dir with the prefix
 * stripped; every other key resolves against the autobahn dir. Each manifest
 * copy in the surface's northstar peer dir must be byte-identical to the
 * surface's autobahn copy (producer/consumer fingerprint parity), and every
 * present surface's manifests must be byte-identical to the vendored pin
 * (vendor absent — packaged contexts — fall back to the first present payload
 * surface). Absent surfaces are skipped and reported as `absent`; a surface
 * whose bytes or manifests disagree names path/expected/actual and the sweep
 * exits non-zero. Loaded-cache drift additionally carries the two refresh
 * hints (`claude plugin marketplace update`, `claude plugin update`) because
 * that surface is reloaded from the marketplace, not re-copied.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const V1_MANIFEST = 'readiness-dependency.json';
const V2_MANIFEST = 'readiness-dependency-v2.json';
const MANIFEST_NAMES = [V1_MANIFEST, V2_MANIFEST];
const LOADED_CACHE_REFRESH_HINTS = [
  'claude plugin marketplace update',
  'claude plugin update',
];

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Resolve a manifest path key against a peer-dir pair.
 * Matches the pinned contract-run-v2.sh resolution rule exactly.
 */
export function resolvePinnedPath(key, autobahnDir, northstarDir) {
  return key.startsWith('northstar/')
    ? join(northstarDir, key.slice('northstar/'.length))
    : join(autobahnDir, key);
}

/**
 * Hash every file named by the v1+v2 manifest copies in one surface and check
 * the surface-internal northstar/autobahn manifest parity.
 * Returns { pinned, findings } — findings are empty on a fresh surface.
 */
function hashSurface(autobahnDir, northstarDir) {
  const findings = [];
  let pinned = 0;
  for (const manifestName of MANIFEST_NAMES) {
    const abCopy = join(autobahnDir, manifestName);
    const nsCopy = join(northstarDir, manifestName);
    if (!existsSync(abCopy) || !existsSync(nsCopy)) {
      const missingPath = existsSync(abCopy) ? nsCopy : abCopy;
      findings.push({
        path: missingPath,
        expected: `manifest ${manifestName}`,
        actual: 'missing-manifest',
        kind: 'manifest-missing',
      });
      continue;
    }
    let abBytes;
    let manifest;
    try {
      abBytes = readFileSync(abCopy);
      manifest = JSON.parse(abBytes.toString('utf8'));
    } catch {
      findings.push({
        path: abCopy,
        expected: 'valid manifest JSON',
        actual: 'unreadable',
        kind: 'unreadable-manifest',
      });
      continue;
    }
    for (const [key, digest] of Object.entries(manifest.files ?? {})) {
      pinned += 1;
      const pinnedPath = resolvePinnedPath(key, autobahnDir, northstarDir);
      if (!existsSync(pinnedPath)) {
        findings.push({
          path: pinnedPath,
          expected: digest,
          actual: 'missing-file',
          kind: 'missing',
        });
        continue;
      }
      const actual = sha256(readFileSync(pinnedPath));
      if (actual !== digest) {
        findings.push({ path: pinnedPath, expected: digest, actual, kind: 'digest' });
      }
    }
    // Producer/consumer fingerprint parity inside this surface: the northstar
    // peer's manifest copy must be byte-identical to the autobahn copy.
    const nsBytes = readFileSync(nsCopy);
    if (nsBytes.equals(abBytes) === false) {
      findings.push({
        path: nsCopy,
        expected: sha256(abBytes),
        actual: sha256(nsBytes),
        kind: 'manifest-parity',
      });
    }
  }
  return { pinned, findings };
}

/**
 * Resolve the loaded-cache payload dir from ~/.claude/plugins/
 * installed_plugins.json: the installPath of the first ai-catapult@* entry.
 * Absent when the file is missing or carries no ai-catapult@* entry; corrupt
 * manifests fail closed.
 */
function resolveLoadedCachePath(env) {
  const pluginsFile = join(env.HOME, '.claude', 'plugins', 'installed_plugins.json');
  if (!existsSync(pluginsFile)) return { kind: 'absent', path: pluginsFile };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(pluginsFile, 'utf8'));
  } catch {
    return { kind: 'corrupt', path: pluginsFile };
  }
  const plugins = (parsed && typeof parsed === 'object' && parsed.plugins) ?? {};
  const ownKeys = Object.keys(plugins).filter((key) => key.startsWith('ai-catapult@'));
  if (ownKeys.length === 0) return { kind: 'absent', path: pluginsFile };
  const record = plugins[ownKeys[0]];
  const installPath = (
    Array.isArray(record) ? record[0] : record
  )?.installPath;
  if (typeof installPath !== 'string' || installPath.length === 0) {
    return { kind: 'corrupt', path: pluginsFile };
  }
  // Real installs store either an absolute path, a ~/… path or a path relative
  // to HOME; all three resolve against the sweep's HOME.
  const resolved = installPath.startsWith('/')
    ? installPath
    : join(env.HOME, installPath.replace(/^~\/?/, ''));
  return { kind: 'ok', path: pluginsFile, payloadDir: resolved };
}

/**
 * Sweep every deployment surface against the vendored pinned bytes.
 *
 * @param {object} args
 * @param {NodeJS.ProcessEnv|object} args.env      - HOME / CODEX_HOME / XDG_CONFIG_HOME
 * @param {string} [args.vendorRoot]               - the vendor/skills checkout root
 * @param {string} [args.distRoot]                 - the dist/ root carrying <harness>-plugin payloads
 * @returns {{ok: boolean, exitCode: number, surfaces: Array<object>}}
 */
export function sweepContractDrift({ env, vendorRoot, distRoot } = {}) {
  const home = env?.HOME;
  if (!home) {
    return {
      ok: false,
      exitCode: 2,
      surfaces: [
        {
          label: 'loaded cache',
          status: 'drift',
          findings: [
            { path: '<env.HOME>', expected: 'HOME in env', actual: 'unset', kind: 'environment' },
          ],
          refreshHints: LOADED_CACHE_REFRESH_HINTS,
        },
      ],
    };
  }
  const codexHome = env.CODEX_HOME ?? join(home, '.codex');
  const xdgConfig = env.XDG_CONFIG_HOME ?? join(home, '.config');

  // spec.autobahnDir/northstarDir: null when the surface cannot exist here.
  const specs = [
    {
      label: 'vendor/skills',
      autobahnDir: vendorRoot ? join(vendorRoot, '04-validate-handoff', 'autobahn') : null,
      northstarDir: vendorRoot ? join(vendorRoot, '02-govern-plan', 'northstar') : null,
    },
    ...['claude-plugin', 'codex-plugin', 'opencode-plugin'].map((harness) => ({
      label: `dist/${harness}`,
      autobahnDir: distRoot ? join(distRoot, harness, 'skills', 'autobahn') : null,
      northstarDir: distRoot ? join(distRoot, harness, 'skills', 'northstar') : null,
    })),
    {
      label: 'marketplace ~/.claude/plugins/ai-catapult',
      autobahnDir: join(home, '.claude', 'plugins', 'ai-catapult', 'skills', 'autobahn'),
      northstarDir: join(home, '.claude', 'plugins', 'ai-catapult', 'skills', 'northstar'),
    },
    { label: 'loaded cache', loadedCache: true },
    {
      label: 'codex cache',
      autobahnDir: join(codexHome, 'plugins', 'cache', 'ai-catapult-local', 'ai-catapult', 'local', 'skills', 'autobahn'),
      northstarDir: join(codexHome, 'plugins', 'cache', 'ai-catapult-local', 'ai-catapult', 'local', 'skills', 'northstar'),
    },
    {
      label: 'opencode skills',
      autobahnDir: join(xdgConfig, 'opencode', 'skills', 'autobahn'),
      northstarDir: join(xdgConfig, 'opencode', 'skills', 'northstar'),
    },
  ];

  // Sweep each spec into an internal record; loaded-cache records carry the
  // resolved payload dir so cross-surface parity can include them.
  const records = [];
  for (const spec of specs) {
    if (spec.loadedCache) {
      const resolved = resolveLoadedCachePath(env);
      if (resolved.kind === 'absent') {
        records.push({ label: spec.label, status: 'absent', findings: [], refreshHints: [], autobahnDir: null });
        continue;
      }
      if (resolved.kind === 'corrupt') {
        records.push({
          label: spec.label,
          status: 'drift',
          findings: [
            { path: resolved.path, expected: 'valid installed_plugins.json JSON', actual: 'unreadable', kind: 'unreadable-installed-plugins' },
          ],
          refreshHints: LOADED_CACHE_REFRESH_HINTS,
          autobahnDir: null,
        });
        continue;
      }
      const scanned = hashSurface(
        join(resolved.payloadDir, 'skills', 'autobahn'),
        join(resolved.payloadDir, 'skills', 'northstar'),
      );
      records.push({
        label: spec.label,
        status: scanned.findings.length > 0 ? 'drift' : 'ok',
        findings: scanned.findings,
        refreshHints: scanned.findings.length > 0 ? LOADED_CACHE_REFRESH_HINTS : [],
        autobahnDir: join(resolved.payloadDir, 'skills', 'autobahn'),
      });
      continue;
    }
    if (!spec.autobahnDir || !existsSync(spec.autobahnDir)) {
      records.push({ label: spec.label, status: 'absent', findings: [], refreshHints: [], autobahnDir: null });
      continue;
    }
    if (!existsSync(spec.northstarDir)) {
      records.push({
        label: spec.label,
        status: 'drift',
        findings: [
          { path: spec.northstarDir, expected: 'northstar peer dir', actual: 'missing-peer-dir', kind: 'missing' },
        ],
        refreshHints: [],
        autobahnDir: null,
      });
      continue;
    }
    const scanned = hashSurface(spec.autobahnDir, spec.northstarDir);
    records.push({
      label: spec.label,
      status: scanned.findings.length > 0 ? 'drift' : 'ok',
      findings: scanned.findings,
      refreshHints: [],
      pinnedEntries: scanned.pinned,
      autobahnDir: spec.autobahnDir,
    });
  }

  // Cross-surface producer/consumer parity: every present surface's manifests
  // must be byte-identical to the vendored pin; when the vendor is absent
  // (packaged contexts) the first present surface anchors instead.
  const present = records.filter((r) => r.status === 'ok' || r.status === 'drift');
  const anchor = present.find((r) => r.label === 'vendor/skills') ?? present[0];
  if (anchor?.autobahnDir && present.length > 1) {
    for (const record of present) {
      if (record === anchor || !record.autobahnDir) continue;
      for (const manifestName of MANIFEST_NAMES) {
        const copy = join(record.autobahnDir, manifestName);
        const anchorCopy = join(anchor.autobahnDir, manifestName);
        if (!existsSync(copy) || !existsSync(anchorCopy)) continue;
        const bytes = readFileSync(copy);
        const anchorBytes = readFileSync(anchorCopy);
        if (bytes.equals(anchorBytes) === false) {
          record.status = 'drift';
          if (record.label === 'loaded cache' && record.refreshHints.length === 0) {
            record.refreshHints = LOADED_CACHE_REFRESH_HINTS;
          }
          record.findings.push({
            path: copy,
            expected: sha256(anchorBytes),
            actual: sha256(bytes),
            kind: 'surface-pin-parity',
          });
        }
      }
    }
  }

  const exitCode = records.some((r) => r.status === 'drift') ? 1 : 0;
  const surfaces = records.map(({ label, autobahnDir, pinnedEntries, ...rest }) => ({
    label,
    status: rest.status,
    findings: rest.findings,
    refreshHints: rest.refreshHints,
  }));
  return { ok: exitCode === 0, exitCode, surfaces };
}