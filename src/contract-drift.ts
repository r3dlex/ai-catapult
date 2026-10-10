/**
 * contract-drift.ts — the readiness-contract drift sweep (ACH-C-02, AC-8).
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
 *   6. the loaded cache: every ai-catapult@* entry in
 *      ~/.claude/plugins/installed_plugins.json is inspected (all keys, all
 *      registered installPaths, deduplicated; flat layout)
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
 * surface). Absent surfaces are skipped and reported as `absent`; a surface is
 * absent only when its installation root itself is missing — an existing
 * installation whose contract directories are gone drifts (missing-contract-dir)
 * instead of being silently skipped. A surface whose bytes or manifests
 * disagree names path/expected/actual and the sweep exits non-zero; unreadable
 * pinned files fail closed with structured `unreadable` findings. Loaded-cache
 * drift additionally carries the two refresh hints (`claude plugin marketplace
 * update`, `claude plugin update`) because that surface is reloaded from the
 * marketplace, not re-copied.
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

export type DriftFinding = { path: string; expected: string; actual: string; kind: string };

export type ContractDriftSweepSurface = {
  label: string;
  status: 'ok' | 'drift' | 'absent';
  findings: DriftFinding[];
  refreshHints: string[];
};

export type ContractDriftSweep = {
  ok: boolean;
  exitCode: number;
  surfaces: ContractDriftSweepSurface[];
};

type SurfaceRecord = {
  label: string;
  status: 'ok' | 'drift' | 'absent';
  findings: DriftFinding[];
  refreshHints: string[];
  autobahnDir: string | null;
  pinnedEntries?: number;
  registrationDirs?: string[];
};

type FixedSurfaceSpec = {
  label: string;
  installRoot: string | null;
  autobahnDir: string | null;
  northstarDir: string | null;
  sharedRoot?: boolean;
  loadedCache?: undefined;
};

/** The loaded cache is resolved from registrations, so it has no fixed dirs. */
type LoadedCacheSpec = { label: string; loadedCache: true };

type SurfaceSpec = FixedSurfaceSpec | LoadedCacheSpec;

type LoadedCacheRegistration = { pluginsFile: string; payloadDir: string };

type LoadedCacheCollected = {
  registrations: LoadedCacheRegistration[];
  invalidKeys: Array<{ key: string; reason: string }>;
};

type LoadedCacheResolution = {
  kind: 'absent' | 'corrupt' | 'ok';
  path: string;
  registrations: LoadedCacheRegistration[];
  invalidKeys: Array<{ key: string; reason: string }>;
};

type SweepArgs = {
  env?: NodeJS.ProcessEnv;
  vendorRoot?: string;
  distRoot?: string;
};

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Stable `unreadable (<errno>)` wording shared by every read-failure finding. */
function unreadableActual(err: unknown): string {
  return `unreadable (${(err as NodeJS.ErrnoException | undefined)?.code ?? 'unknown'})`;
}

/**
 * Resolve a manifest path key against a peer-dir pair.
 * Matches the pinned contract-run-v2.sh resolution rule exactly.
 */
export function resolvePinnedPath(key: string, autobahnDir: string, northstarDir: string): string {
  return key.startsWith('northstar/')
    ? join(northstarDir, key.slice('northstar/'.length))
    : join(autobahnDir, key);
}

/**
 * Hash every file named by one manifest copy in a surface's autobahn dir.
 * Returns the pinned-file count and findings; empty findings on a fresh surface.
 */
function hashPinnedFiles(
  manifest: { files?: Record<string, string> },
  autobahnDir: string,
  northstarDir: string,
): { pinned: number; findings: DriftFinding[] } {
  const findings: DriftFinding[] = [];
  let pinned = 0;
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
    let actual: string;
    try {
      actual = sha256(readFileSync(pinnedPath));
    } catch (err) {
      findings.push({
        path: pinnedPath,
        expected: digest,
        actual: unreadableActual(err),
        kind: 'unreadable',
      });
      continue;
    }
    if (actual !== digest) {
      findings.push({ path: pinnedPath, expected: digest, actual, kind: 'digest' });
    }
  }
  return { pinned, findings };
}

/**
 * Producer/consumer fingerprint parity inside one surface: the northstar
 * peer's manifest copy must be byte-identical to the autobahn copy.
 */
function checkNsParity(abCopy: string, nsCopy: string, abBytes: Buffer): DriftFinding | null {
  let nsBytes: Buffer;
  try {
    nsBytes = readFileSync(nsCopy);
  } catch (err) {
    return {
      path: nsCopy,
      expected: sha256(abBytes),
      actual: unreadableActual(err),
      kind: 'manifest-parity',
    };
  }
  if (nsBytes.equals(abBytes) === false) {
    return {
      path: nsCopy,
      expected: sha256(abBytes),
      actual: sha256(nsBytes),
      kind: 'manifest-parity',
    };
  }
  return null;
}

/**
 * Hash every file named by the v1+v2 manifest copies in one surface and check
 * the surface-internal northstar/autobahn manifest parity.
 * Returns { pinned, findings } — findings are empty on a fresh surface.
 */
function hashSurface(autobahnDir: string, northstarDir: string): { pinned: number; findings: DriftFinding[] } {
  const findings: DriftFinding[] = [];
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
    let abBytes: Buffer;
    let manifest: { files?: Record<string, string> };
    try {
      abBytes = readFileSync(abCopy);
      manifest = JSON.parse(abBytes.toString('utf8')) as { files?: Record<string, string> };
    } catch {
      findings.push({
        path: abCopy,
        expected: 'valid manifest JSON',
        actual: 'unreadable',
        kind: 'unreadable-manifest',
      });
      continue;
    }
    const files = hashPinnedFiles(manifest, autobahnDir, northstarDir);
    pinned += files.pinned;
    findings.push(...files.findings);
    // Order preserved: file findings are emitted before the northstar-copy check.
    const nsFinding = checkNsParity(abCopy, nsCopy, abBytes);
    if (nsFinding) findings.push(nsFinding);
  }
  return { pinned, findings };
}

/**
 * Component-wise trust check on a registered installPath, applied BEFORE any
 * filesystem resolution: it mirrors the safePath()/unsafeReason() convention
 * established at 2ede4ce (XSKP-P4-02, src/knowledge.ts) — reject '\0', empty
 * values, and traversal ('.', '..' or empty components) before the path is
 * resolved. Returns null when trusted, else a stable reason string.
 *
 * The knowledge symlink-chain and realpath containment rules do not
 * transfer to registration-declared install roots: those are machine-local
 * locations the plugin manager declares (not in-repo relatives), and this
 * sweep's reads are content-compared against the vendored pin, so a
 * symlink-redirected read fails parity instead of passing.
 */
function unsafeRegistrationPathReason(installPath: unknown): string | null {
  if (typeof installPath !== 'string' || installPath.length === 0 || installPath.includes('\0')) {
    return 'missing';
  }
  // Classify the root designator ('/…' absolute, '~/…' home-relative or a
  // bare path relative to HOME), then check the remaining components.
  const body = installPath.startsWith('/') ? installPath.slice(1) : installPath.replace(/^~\/?/, '');
  if (body === '' || body.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    return 'traversal';
  }
  return null;
}

/** Walk every ai-catapult@* record, trusting each installPath before resolution. */
function collectRegistrationsOf(plugins: Record<string, unknown>, home: string): LoadedCacheCollected {
  const pluginsFile = join(home, '.claude', 'plugins', 'installed_plugins.json');
  const registrations: LoadedCacheRegistration[] = [];
  const invalidKeys: Array<{ key: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const key of Object.keys(plugins).filter((key) => key.startsWith('ai-catapult@'))) {
    const recordField = plugins[key];
    const records: unknown[] = Array.isArray(recordField) ? recordField : [recordField];
    for (const record of records) {
      const installPath = (record as { installPath?: unknown } | null | undefined)?.installPath;
      // Trust check before resolution (2ede4ce safePath convention).
      const reason = unsafeRegistrationPathReason(installPath);
      if (reason) {
        invalidKeys.push({ key, reason });
        continue;
      }
      // Real installs store either an absolute path, a ~/… path or a path
      // relative to HOME; all three resolve against the sweep's HOME.
      const path = installPath as string;
      const payloadDir = path.startsWith('/') ? path : join(home, path.replace(/^~\/?/, ''));
      if (seen.has(payloadDir)) continue;
      seen.add(payloadDir);
      registrations.push({ pluginsFile, payloadDir });
    }
  }
  return { registrations, invalidKeys };
}

/**
 * Resolve the loaded-cache payload dirs from ~/.claude/plugins/
 * installed_plugins.json: every ai-catapult@* entry is inspected (later keys,
 * later array records), deduplicated by resolved payload dir. Absent when the
 * file is missing or carries no ai-catapult@* entry; corrupt manifests fail
 * closed; registrations with invalid or unsafe installPaths are reported
 * without being resolved.
 */
function resolveLoadedCachePaths(home: string): LoadedCacheResolution {
  const pluginsFile = join(home, '.claude', 'plugins', 'installed_plugins.json');
  if (!existsSync(pluginsFile)) return { kind: 'absent', path: pluginsFile, registrations: [], invalidKeys: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(pluginsFile, 'utf8'));
  } catch {
    return { kind: 'corrupt', path: pluginsFile, registrations: [], invalidKeys: [] };
  }
  const plugins = (parsed !== null && typeof parsed === 'object' ? (parsed as { plugins?: unknown }).plugins : undefined) ?? {};
  const collected = collectRegistrationsOf(plugins as Record<string, unknown>, home);
  if (collected.registrations.length === 0 && collected.invalidKeys.length === 0) {
    return { kind: 'absent', path: pluginsFile, registrations: [], invalidKeys: [] };
  }
  return { kind: 'ok', path: pluginsFile, ...collected };
}

/** Report registrations whose installPath failed the trust check. */
function pushInvalidRegistrationFindings(
  findings: DriftFinding[],
  pluginsFile: string,
  invalidKeys: Array<{ key: string; reason: string }>,
): void {
  for (const { key, reason } of invalidKeys) {
    findings.push(
      {
        path: pluginsFile,
        expected: `valid installPath under ${key}`,
        actual: reason === 'missing' ? 'missing-or-invalid-installPath' : `unsafe-installPath (${reason})`,
        kind: 'unreadable-installed-plugins',
      },
    );
  }
}

/** Sweep the loaded-cache surface into a record (or an absent one). */
function sweepLoadedCache(label: string, home: string): SurfaceRecord {
  const resolved = resolveLoadedCachePaths(home);
  if (resolved.kind === 'absent') {
    return { label, status: 'absent', findings: [], refreshHints: [], autobahnDir: null };
  }
  const findings: DriftFinding[] = [];
  if (resolved.kind === 'corrupt') {
    findings.push(
      { path: resolved.path, expected: 'valid installed_plugins.json JSON', actual: 'unreadable', kind: 'unreadable-installed-plugins' },
    );
  }
  // Every registration is hashed (deduplicated dirs once). The first
  // registration dir anchors cross-surface parity; extra registrations get
  // the full in-surface manifest+file sweep.
  for (const { payloadDir } of resolved.registrations) {
    const scanned = hashSurface(
      join(payloadDir, 'skills', 'autobahn'),
      join(payloadDir, 'skills', 'northstar'),
    );
    findings.push(...scanned.findings);
  }
  pushInvalidRegistrationFindings(findings, resolved.path, resolved.invalidKeys);
  const firstPayloadDir = resolved.registrations[0]?.payloadDir ?? null;
  return {
    label,
    status: findings.length > 0 ? 'drift' : 'ok',
    findings,
    refreshHints: findings.length > 0 ? LOADED_CACHE_REFRESH_HINTS : [],
    autobahnDir: firstPayloadDir === null ? null : join(firstPayloadDir, 'skills', 'autobahn'),
    // Every registered payload dir participates in cross-surface parity —
    // not only the anchor-carrying first registration (which stays
    // autobahnDir for packaged-context anchoring).
    registrationDirs: resolved.registrations.map((r) => join(r.payloadDir, 'skills', 'autobahn')),
  };
}

/** Sweep a fixed install-root surface into a record. */
function sweepFixedSurface(spec: FixedSurfaceSpec): SurfaceRecord {
  // A rootless surface (no dirs provided) is absent by construction, not an
  // installed payload.
  if (!spec.installRoot || !spec.autobahnDir || !spec.northstarDir) {
    return { label: spec.label, status: 'absent', findings: [], refreshHints: [], autobahnDir: null };
  }
  const { installRoot, autobahnDir, northstarDir } = spec;
  // Ownership test: a surface is installed when its ownership evidence exists.
  // Path-scoped roots (vendor, dist, marketplace, codex cache) are ai-catapult's
  // own directories — the root's existence proves the payload is installed.
  // A sharedRoot surface (the OpenCode skills root) also hosts unrelated
  // payloads, so only the presence of an ai-catapult contract dir proves
  // ownership. A surface is reported `absent` only when that evidence is
  // missing; an existing installation whose contract directories are missing
  // or incomplete drifts.
  const installed = spec.sharedRoot
    ? existsSync(autobahnDir) || existsSync(northstarDir)
    : existsSync(installRoot);
  if (!installed) {
    // The surface cannot be proven present here: absent by construction.
    return { label: spec.label, status: 'absent', findings: [], refreshHints: [], autobahnDir: null };
  }
  if (!existsSync(autobahnDir)) {
    // The surface is installed (its root exists) but the contract dir is
    // gone: fail closed instead of silently skipping the surface.
    return {
      label: spec.label,
      status: 'drift',
      findings: [
        { path: autobahnDir, expected: 'autobahn contract dir', actual: 'missing-contract-dir', kind: 'missing' },
      ],
      refreshHints: [],
      autobahnDir: null,
    };
  }
  if (!existsSync(northstarDir)) {
    return {
      label: spec.label,
      status: 'drift',
      findings: [
        { path: northstarDir, expected: 'northstar peer dir', actual: 'missing-peer-dir', kind: 'missing' },
      ],
      refreshHints: [],
      autobahnDir: null,
    };
  }
  const scanned = hashSurface(autobahnDir, northstarDir);
  return {
    label: spec.label,
    status: scanned.findings.length > 0 ? 'drift' : 'ok',
    findings: scanned.findings,
    refreshHints: [],
    pinnedEntries: scanned.pinned,
    autobahnDir,
  };
}

function pushCopyReadFailure(record: SurfaceRecord, failedPath: string, err: unknown): void {
  record.status = 'drift';
  if (record.label === 'loaded cache' && record.refreshHints.length === 0) {
    record.refreshHints = LOADED_CACHE_REFRESH_HINTS;
  }
  record.findings.push({
    path: failedPath,
    expected: 'readable manifest copy',
    actual: unreadableActual(err),
    kind: 'surface-pin-parity',
  });
}

type ManifestCopyRead = { kind: 'bytes'; bytes: Buffer } | { kind: 'error'; err: unknown };

/**
 * Read one manifest copy, keeping the read error so parity findings can name
 * the real errno instead of a generic unreadable marker.
 */
function readManifestCopy(dir: string, manifestName: string): ManifestCopyRead {
  try {
    return { kind: 'bytes', bytes: readFileSync(join(dir, manifestName)) };
  } catch (err) {
    return { kind: 'error', err };
  }
}

/**
 * Compare one record dir's v1+v2 manifest copies against the anchor's; drift
 * findings push onto the record and flip its status to drift.
 */
function compareManifestCopies(record: SurfaceRecord, dir: string, anchorDir: string): void {
  for (const manifestName of MANIFEST_NAMES) {
    const copy = join(dir, manifestName);
    const anchorCopy = join(anchorDir, manifestName);
    if (!existsSync(copy) || !existsSync(anchorCopy)) continue;
    const read = readManifestCopy(dir, manifestName);
    if (read.kind === 'error') {
      pushCopyReadFailure(record, copy, read.err);
      continue;
    }
    const anchorRead = readManifestCopy(anchorDir, manifestName);
    if (anchorRead.kind === 'error') {
      pushCopyReadFailure(record, anchorCopy, anchorRead.err);
      continue;
    }
    if (read.bytes.equals(anchorRead.bytes) === false) {
      record.status = 'drift';
      if (record.label === 'loaded cache' && record.refreshHints.length === 0) {
        record.refreshHints = LOADED_CACHE_REFRESH_HINTS;
      }
      record.findings.push({
        path: copy,
        expected: sha256(anchorRead.bytes),
        actual: sha256(read.bytes),
        kind: 'surface-pin-parity',
      });
    }
  }
}

/**
 * Cross-surface producer/consumer parity: every present surface's manifests
 * must be byte-identical to the vendored pin; when the vendor is absent
 * (packaged contexts) the first present surface anchors instead.
 */
function enforceSurfaceParity(records: SurfaceRecord[]): void {
  const present = records.filter((r) => r.status === 'ok' || r.status === 'drift');
  const anchor = present.find((r) => r.label === 'vendor/skills') ?? present[0];
  // Parity fires whenever an anchor exists — including the sole-present-
  // surface case: a lone loaded-cache record's later registrations must
  // compare against its own first (anchor-carrying) dir. Only the anchor's
  // own dir is skipped (it is the comparison base).
  if (!anchor?.autobahnDir) return;
  const anchorDir = anchor.autobahnDir;
  for (const record of present) {
    // Every registered dir of this record is checked: the anchor-carrying
    // dir (autobahnDir) plus all later registrations (registrationDirs on
    // loaded-cache records). Only the anchor's own dir is skipped — it is
    // the comparison base — while a later registration of the anchor record
    // itself must still be compared against the anchor dir.
    const dirs = record.registrationDirs ?? (record.autobahnDir ? [record.autobahnDir] : []);
    for (const dir of dirs) {
      if (record === anchor && dir === record.autobahnDir) continue;
      compareManifestCopies(record, dir, anchorDir);
    }
  }
}

/**
 * The deployment surfaces swept against the vendored pin, in report order.
 * A null vendorRoot/distRoot means the surface cannot exist here (rootless
 * context) — those specs resolve to `absent` in the fixed-surface sweep.
 */
function surfaceSpecs(rootings: {
  home: string;
  codexHome: string;
  xdgConfig: string;
  vendorRoot: string | null;
  distRoot: string | null;
}): SurfaceSpec[] {
  const { home, codexHome, xdgConfig, vendorRoot, distRoot } = rootings;
  return [
    {
      label: 'vendor/skills',
      installRoot: vendorRoot,
      autobahnDir: vendorRoot ? join(vendorRoot, '04-validate-handoff', 'autobahn') : null,
      northstarDir: vendorRoot ? join(vendorRoot, '02-govern-plan', 'northstar') : null,
    },
    ...['claude-plugin', 'codex-plugin', 'opencode-plugin'].map((harness) => ({
      label: `dist/${harness}`,
      installRoot: distRoot ? join(distRoot, harness) : null,
      autobahnDir: distRoot ? join(distRoot, harness, 'skills', 'autobahn') : null,
      northstarDir: distRoot ? join(distRoot, harness, 'skills', 'northstar') : null,
    })),
    {
      label: 'marketplace ~/.claude/plugins/ai-catapult',
      installRoot: join(home, '.claude', 'plugins', 'ai-catapult'),
      autobahnDir: join(home, '.claude', 'plugins', 'ai-catapult', 'skills', 'autobahn'),
      northstarDir: join(home, '.claude', 'plugins', 'ai-catapult', 'skills', 'northstar'),
    },
    { label: 'loaded cache', loadedCache: true },
    {
      label: 'codex cache',
      installRoot: join(codexHome, 'plugins', 'cache', 'ai-catapult-local', 'ai-catapult', 'local'),
      autobahnDir: join(codexHome, 'plugins', 'cache', 'ai-catapult-local', 'ai-catapult', 'local', 'skills', 'autobahn'),
      northstarDir: join(codexHome, 'plugins', 'cache', 'ai-catapult-local', 'ai-catapult', 'local', 'skills', 'northstar'),
    },
    {
      label: 'opencode skills',
      // A SHARED OpenCode surface: unrelated skills may live in this root, so
      // its existence does not prove ai-catapult is installed here. Ownership
      // needs contract evidence instead — at least one contract dir.
      sharedRoot: true,
      installRoot: join(xdgConfig, 'opencode', 'skills'),
      autobahnDir: join(xdgConfig, 'opencode', 'skills', 'autobahn'),
      northstarDir: join(xdgConfig, 'opencode', 'skills', 'northstar'),
    },
  ];
}

/** Sweep every surface spec into its internal report record. */
function sweepAllSpecs(specs: SurfaceSpec[], home: string): SurfaceRecord[] {
  const records: SurfaceRecord[] = [];
  for (const spec of specs) {
    if (spec.loadedCache) records.push(sweepLoadedCache(spec.label, home));
    else records.push(sweepFixedSurface(spec));
  }
  return records;
}

/**
 * Sweep every deployment surface against the vendored pinned bytes.
 *
 * @param {object} [args]
 * @param {NodeJS.ProcessEnv} [args.env]  - HOME / CODEX_HOME / XDG_CONFIG_HOME
 * @param {string}   [args.vendorRoot]    - the vendor/skills checkout root
 * @param {string}   [args.distRoot]      - the dist/ root carrying <harness>-plugin payloads
 * @returns {ContractDriftSweep} { ok, exitCode, surfaces }
 */
export function sweepContractDrift({ env: rawEnv, vendorRoot, distRoot }: SweepArgs = {}): ContractDriftSweep {
  const env = rawEnv ?? {};
  const home = env.HOME;
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

  const specs = surfaceSpecs({ home, codexHome, xdgConfig, vendorRoot: vendorRoot ?? null, distRoot: distRoot ?? null });

  // Sweep each spec into an internal record; loaded-cache records carry the
  // resolved payload dir so cross-surface parity can include them.
  const records: SurfaceRecord[] = sweepAllSpecs(specs, home);

  enforceSurfaceParity(records);

  const exitCode = records.some((r) => r.status === 'drift') ? 1 : 0;
  const surfaces = records.map((r) => ({
    label: r.label,
    status: r.status,
    findings: r.findings,
    refreshHints: r.refreshHints,
  }));
  return { ok: exitCode === 0, exitCode, surfaces };
}