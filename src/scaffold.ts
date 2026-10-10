/**
 * scaffold.ts — deterministic v3 .ai/ scaffold engine (Slice 3).
 *
 * Reads vendored ai-catapult-init/templates/ + boundary-manifest.json and
 * emits all MECHANICAL paths into a target directory. Judgment-laden paths
 * are not written as files (only their parent dirs may be created where a
 * .gitkeep sits in the template tree to track the directory).
 *
 * Determinism guarantees:
 *   - Template files are iterated in sorted manifest order (not filesystem order).
 *   - Token substitution is a pure synchronous replace — no timestamps beyond
 *     the injected {{DATE}}, no Math.random, no OS entropy.
 *   - Same inputs → byte-identical output.
 *
 * Token map (all tokens that appear across templates):
 *   {{REPO_ID}}       → repoId
 *   {{DATE}}          → date  (YYYY-MM-DD)
 *   {{UPSTREAM_URL}}  → upstreamUrl
 *   {{UPSTREAM_REF}}  → upstreamRef
 *
 * Path-prefix mapping (template path → real filesystem path):
 *   dot-ai/       → .ai/
 *   dot-github/   → .github/
 *   dot-rules.ts  → .rules.ts
 *   (everything else maps 1:1)
 *
 * Besides the manifest entries the scaffold byte-copies the vendored
 * scripts/validate-rules.sh validator into <target>/scripts/ — the template's
 * prek.toml hook and the emitted .rules.ts header reference it (packaged
 * installs source the staged copy; see scripts/stage-skill-templates.ts).
 */

import { mkdirSync, readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

type BoundaryManifestEntry = {
  path?: string;
  classification?: string;
  template?: string | null;
};

type BoundaryManifest = { paths: BoundaryManifestEntry[] };

/**
 * Map a template-relative path to its real output path.
 * e.g. "dot-ai/matrix.json" → ".ai/matrix.json"
 *      "dot-github/workflows/ci.yml" → ".github/workflows/ci.yml"
 *      "dot-rules.ts" → ".rules.ts"
 */
function templatePathToRealPath(templatePath: string): string {
  if (templatePath.startsWith('dot-ai/')) {
    return '.ai/' + templatePath.slice('dot-ai/'.length);
  }
  if (templatePath.startsWith('dot-github/')) {
    return '.github/' + templatePath.slice('dot-github/'.length);
  }
  if (templatePath === 'dot-rules.ts') {
    return '.rules.ts';
  }
  // All other templates (AGENTS.md, CLAUDE.md, GEMINI.md, prek.toml) map 1:1.
  return templatePath;
}

function manifestPathToRealPath(manifestPath: string): string {
  return manifestPath;
}

/** Substitute all {{TOKEN}} placeholders in content. */
function substituteTokens(content: string, tokens: Tokens): string {
  return content
    .replaceAll('{{REPO_ID}}', tokens.REPO_ID)
    .replaceAll('{{DATE}}', tokens.DATE)
    .replaceAll('{{UPSTREAM_URL}}', tokens.UPSTREAM_URL)
    .replaceAll('{{UPSTREAM_REF}}', tokens.UPSTREAM_REF);
}

type Tokens = {
  REPO_ID: string;
  DATE: string;
  UPSTREAM_URL: string;
  UPSTREAM_REF: string;
};

/**
 * Assert that destPath is strictly inside targetDir.
 * Throws a clear error if a path traversal is detected.
 */
function assertNoTraversal(destPath: string, targetDir: string): void {
  const resolvedDest = resolve(destPath);
  const resolvedRoot = resolve(targetDir) + sep;
  if (!resolvedDest.startsWith(resolvedRoot)) {
    throw new Error(
      `Path traversal detected: manifest path resolves to "${resolvedDest}" which is outside target directory "${resolve(targetDir)}". Aborting.`,
    );
  }
}

/**
 * Recursively copy any .gitkeep files from the template tree into targetDir,
 * using the same dot-* path mapping as templatePathToRealPath. Collisions
 * (when force=false) accumulate into `collisions` as real relative paths.
 */
function emitGitkeeps(
  baseTemplatesDir: string,
  currentDir: string,
  targetDir: string,
  force: boolean,
  collisions: string[],
): void {
  const entries = readdirSync(currentDir, { withFileTypes: true });
  // Sort for determinism
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const srcFull = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      emitGitkeeps(baseTemplatesDir, srcFull, targetDir, force, collisions);
    } else if (entry.name === '.gitkeep') {
      // e.g. baseTemplatesDir = "/…/templates", srcFull = "/…/templates/dot-ai/evals/.gitkeep"
      // relFromTemplates = "dot-ai/evals/.gitkeep"
      const relFromTemplates = srcFull.slice(baseTemplatesDir.length + 1);
      const realRel = templatePathToRealPath(relFromTemplates);
      const destFull = join(targetDir, realRel);
      assertNoTraversal(destFull, targetDir);
      if (!force && existsSync(destFull)) {
        collisions.push(realRel);
        continue;
      }
      mkdirSync(dirname(destFull), { recursive: true });
      writeFileSync(destFull, '', 'utf8');
    }
  }
}

/**
 * Mechanical manifest entries in manifest order (deterministic — not
 * filesystem readdir order): the destinations the scaffold writes and the
 * templates it renders them from. Judgment-laden entries are skipped.
 */
function mechanicalEntries(manifest: BoundaryManifest): Array<{ path: string; template: string }> {
  return manifest.paths
    .filter((entry) => entry.classification === 'mechanical' && entry.template !== null)
    .map((entry) => ({ path: entry.path as string, template: entry.template as string }));
}

/**
 * First pass (Fix #3): collect collisions before writing anything — resolve
 * every mechanical destination and run the defensive traversal check up front.
 */
function collectCollisions(manifest: BoundaryManifest, targetDir: string, force: boolean): string[] {
  const collisions: string[] = [];
  for (const entry of mechanicalEntries(manifest)) {
    const realRelPath = manifestPathToRealPath(entry.path);
    const destPath = join(targetDir, realRelPath);
    // Fix #4: defense-in-depth traversal check
    assertNoTraversal(destPath, targetDir);
    if (!force && existsSync(destPath)) {
      collisions.push(realRelPath);
    }
  }
  return collisions;
}

/** Second pass: render and write every mechanical file, returning the emitted paths. */
function writeMechanicalFiles(manifest: BoundaryManifest, templatesDir: string, targetDir: string, tokens: Tokens): string[] {
  const emittedPaths: string[] = [];
  for (const entry of mechanicalEntries(manifest)) {
    const realRelPath = manifestPathToRealPath(entry.path);
    const destPath = join(targetDir, realRelPath);

    const raw = readFileSync(join(templatesDir, entry.template), 'utf8');
    const rendered = substituteTokens(raw, tokens);

    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, rendered, 'utf8');
    emittedPaths.push(realRelPath);
  }
  return emittedPaths;
}

/**
 * Scaffold the mechanical v3 .ai/ skeleton into targetDir.
 *
 * Returns the emitted paths and the judgment-laden manifest paths (for the
 * finish prompt).
 */
export function scaffold({ targetDir, templatesDir, skillsDir, repoId, date, upstreamUrl, upstreamRef, force = false }: {
  targetDir: string;
  templatesDir: string;
  /** Skills root carrying scripts/validate-rules.sh (vendor mode); absent when templates come from the staged dist copy. */
  skillsDir?: string | undefined;
  repoId: string;
  date: string;
  upstreamUrl: string;
  upstreamRef: string;
  force?: boolean;
}): { emittedPaths: string[]; judgmentLadenPaths: string[] } {
  const manifestPath = join(templatesDir, 'boundary-manifest.json');

  // Fix #8: friendly error when vendor/manifest is missing
  let manifest: BoundaryManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BoundaryManifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      process.stderr.write('vendor/ missing or stale — run: node scripts/setup.ts\n');
      process.exit(1);
    }
    throw err;
  }

  const tokens: Tokens = {
    REPO_ID: repoId,
    DATE: date,
    UPSTREAM_URL: upstreamUrl,
    UPSTREAM_REF: upstreamRef,
  };

  // Fix #3: collect collisions before writing anything, then refuse if any
  // exist and --force was not passed.
  const collisions = collectCollisions(manifest, targetDir, force);

  // The template's prek.toml declares a validate-rules local hook whose entry
  // is `bash scripts/validate-rules.sh`, and the emitted .rules.ts header
  // documents that file as its validation entry point — but the vendored
  // template set never shipped it, so every scaffolded tree carried a dead
  // hook. The vendored skills root ships the canonical validator next to the
  // catalog (the skillsDir the caller resolved; the catalog may place the
  // skill at any depth, so the root — not template arithmetic — is the
  // stable anchor); packaged installs get a staged copy at
  // dist/skill-templates/scripts/ (scripts/stage-skill-templates.ts).
  // Resolve it here and treat a collision under the same --force semantics
  // as the manifest paths, so a scaffold that cannot emit a live hook
  // refuses before writing anything.
  const validatorCandidates = [join(templatesDir, 'scripts', 'validate-rules.sh')];
  if (skillsDir) validatorCandidates.push(join(skillsDir, 'scripts', 'validate-rules.sh'));
  const validatorSrc = validatorCandidates.find((candidate) => existsSync(candidate));
  if (!validatorSrc) {
    process.stderr.write(
      'vendor/ missing or stale — vendored scripts/validate-rules.sh not found next to the templates; run: node scripts/setup.ts\n',
    );
    process.exit(1);
  }
  const validatorDest = join(targetDir, 'scripts', 'validate-rules.sh');
  if (!force && existsSync(validatorDest)) {
    collisions.push('scripts/validate-rules.sh');
  }

  if (collisions.length > 0) {
    process.stderr.write(
      `error: init would overwrite existing files in ${targetDir}:\n` +
      collisions.map((p) => `  ${p}`).join('\n') +
      '\nPass --force to overwrite.\n',
    );
    process.exit(1);
  }

  // All clear — write files
  const emittedPaths = writeMechanicalFiles(manifest, templatesDir, targetDir, tokens);

  // Emit .gitkeep files so tracked empty directories land in the target.
  // These are not listed in the boundary-manifest (they are git artifacts),
  // so we walk the template tree for .gitkeep files and mirror them verbatim.
  const gitkeepCollisions: string[] = [];
  emitGitkeeps(templatesDir, templatesDir, targetDir, force, gitkeepCollisions);
  // .gitkeep collisions are non-fatal — they are empty marker files; silently
  // skip them if --force was not given (the directory already exists).

  // Emit the vendored Archgate validator promised by the template's prek.toml
  // hook (resolved and collision-checked above). Byte-exact copy from the
  // pinned vendor source; listed in emittedPaths so the finish prompt and
  // NEXT-STEPS.md reference the live hook target.
  mkdirSync(join(targetDir, 'scripts'), { recursive: true });
  writeFileSync(validatorDest, readFileSync(validatorSrc));
  emittedPaths.push('scripts/validate-rules.sh');

  // Collect judgment-laden paths from manifest (for finish prompt).
  const judgmentLadenPaths = manifest.paths
    .filter((e) => e.classification === 'judgment_laden')
    .map((e) => e.path as string);

  return { emittedPaths, judgmentLadenPaths };
}