// build-plugin-lib.ts — shared helpers for the three plugin-assembly scripts.
// Everything here is deterministic and fail-closed: no timestamps, no network.
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBundledSkills } from '../src/skill-resolver.ts';

export type BundledEntry = { name: string; dir: string };

/** Resolve the catalog-derived bundled skill set for a host. Fails closed. */
export function readBundledEntries(vendorSkills: string, host: string): BundledEntry[] {
  return resolveBundledSkills(vendorSkills, { host });
}

/** Read the package version used in manifests; exits 1 (fail closed) if absent. */
export function readPackageVersion(packageJsonPath: string, failMessage: string): string {
  const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };
  const version = typeof parsed.version === 'string' ? parsed.version : '';
  if (version.length === 0) {
    process.stderr.write(`${failMessage}\n`);
    process.exit(1);
  }
  return version;
}

/** Copy each bundled skill directory verbatim into skillsOut/<name>. */
export function copyBundledSkills(entries: readonly BundledEntry[], skillsOut: string): void {
  mkdirSync(skillsOut, { recursive: true });
  for (const entry of entries) {
    cpSync(entry.dir, join(skillsOut, entry.name), { recursive: true });
  }
}

/** Remove setup.sh artefacts (.git checkout dir, HEAD_SHA sentinel) from a copy. */
export function pruneSkillArtifacts(skillOutDir: string): void {
  rmSync(join(skillOutDir, '.git'), { recursive: true, force: true });
  rmSync(join(skillOutDir, 'HEAD_SHA'), { force: true });
}

/**
 * Copy the vendored Python runtime pieces (matrix-contract.py,
 * render-ci-adapters.py + canonical ci templates) into the plugin tree.
 * Vendored runtimes stay Python by design; they are data + interpreter
 * scripts pinned by the lock, not first-party code.
 */
export function copyPythonRuntimes(vendorSkills: string, distDir: string): void {
  if (existsSync(join(vendorSkills, 'scripts/matrix-contract.py'))) {
    mkdirSync(join(distDir, 'scripts'), { recursive: true });
    cpSync(join(vendorSkills, 'scripts/matrix-contract.py'), join(distDir, 'scripts/matrix-contract.py'));
    chmodSync(join(distDir, 'scripts/matrix-contract.py'), 0o755);
  }
  if (existsSync(join(vendorSkills, 'scripts/render-ci-adapters.py'))) {
    mkdirSync(join(distDir, 'scripts'), { recursive: true });
    mkdirSync(join(distDir, '03-configure-generate/ai-catapult-init/templates'), { recursive: true });
    cpSync(join(vendorSkills, 'scripts/render-ci-adapters.py'), join(distDir, 'scripts/render-ci-adapters.py'));
    cpSync(
      join(vendorSkills, '03-configure-generate/ai-catapult-init/templates/ci'),
      join(distDir, '03-configure-generate/ai-catapult-init/templates/ci'),
      { recursive: true },
    );
    chmodSync(join(distDir, 'scripts/render-ci-adapters.py'), 0o755);
  }
}

/** Count regular files under root, mirroring `find <root> -type f | wc -l`. */
export function countFilesRecursive(root: string): number {
  let count = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countFilesRecursive(join(root, entry.name));
    else if (entry.isFile()) count += 1;
  }
  return count;
}