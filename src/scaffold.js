/**
 * scaffold.js — deterministic v3 .ai/ scaffold engine (Slice 3).
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
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * Map a template-relative path to its real output path.
 * e.g. "dot-ai/matrix.json" → ".ai/matrix.json"
 *      "dot-github/workflows/ci.yml" → ".github/workflows/ci.yml"
 *      "dot-rules.ts" → ".rules.ts"
 */
function templatePathToRealPath(templatePath) {
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

/**
 * Substitute all {{TOKEN}} placeholders in content.
 * @param {string} content - raw template content
 * @param {object} tokens  - { REPO_ID, DATE, UPSTREAM_URL, UPSTREAM_REF }
 * @returns {string}
 */
function substituteTokens(content, tokens) {
  return content
    .replaceAll('{{REPO_ID}}', tokens.REPO_ID)
    .replaceAll('{{DATE}}', tokens.DATE)
    .replaceAll('{{UPSTREAM_URL}}', tokens.UPSTREAM_URL)
    .replaceAll('{{UPSTREAM_REF}}', tokens.UPSTREAM_REF);
}

/**
 * Assert that destPath is strictly inside targetDir.
 * Throws a clear error if a path traversal is detected.
 * @param {string} destPath  - absolute destination path
 * @param {string} targetDir - absolute target root
 */
function assertNoTraversal(destPath, targetDir) {
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
 * using the same dot-* path mapping as templatePathToRealPath.
 *
 * @param {string} baseTemplatesDir - absolute path to templates root (for computing relative paths)
 * @param {string} currentDir       - current directory being walked
 * @param {string} targetDir        - absolute output root
 * @param {boolean} force           - overwrite existing files
 * @param {string[]} collisions     - accumulator for collision paths (when force=false)
 */
function emitGitkeeps(baseTemplatesDir, currentDir, targetDir, force, collisions) {
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
 * Scaffold the mechanical v3 .ai/ skeleton into targetDir.
 *
 * @param {object} opts
 * @param {string} opts.targetDir      - absolute path to emit into
 * @param {string} opts.templatesDir   - absolute path to vendored templates/
 * @param {string} opts.repoId         - {{REPO_ID}} substitution value
 * @param {string} opts.date           - {{DATE}} substitution value (YYYY-MM-DD)
 * @param {string} opts.upstreamUrl    - {{UPSTREAM_URL}} substitution value
 * @param {string} opts.upstreamRef    - {{UPSTREAM_REF}} substitution value
 * @param {boolean} [opts.force]       - overwrite existing files without error
 */
export function scaffold({ targetDir, templatesDir, repoId, date, upstreamUrl, upstreamRef, force = false }) {
  const manifestPath = join(templatesDir, 'boundary-manifest.json');

  // Fix #8: friendly error when vendor/manifest is missing
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      process.stderr.write('vendor/ missing or stale — run: bash setup.sh\n');
      process.exit(1);
    }
    throw err;
  }

  const tokens = {
    REPO_ID: repoId,
    DATE: date,
    UPSTREAM_URL: upstreamUrl,
    UPSTREAM_REF: upstreamRef,
  };

  // Fix #3: collect collisions before writing anything
  const collisions = [];

  // Iterate in manifest order (deterministic — not filesystem readdir order).
  for (const entry of manifest.paths) {
    if (entry.classification !== 'mechanical' || entry.template === null) {
      // Judgment-laden: do not emit any file.
      continue;
    }

    const templateRelPath = entry.template; // e.g. "dot-ai/matrix.json"
    const realRelPath = templatePathToRealPath(templateRelPath); // e.g. ".ai/matrix.json"

    const srcPath = join(templatesDir, templateRelPath);
    const destPath = join(targetDir, realRelPath);

    // Fix #4: defense-in-depth traversal check
    assertNoTraversal(destPath, targetDir);

    if (!force && existsSync(destPath)) {
      collisions.push(realRelPath);
    }
  }

  // Fix #3: refuse if collisions exist and --force not passed
  if (collisions.length > 0) {
    process.stderr.write(
      `error: init would overwrite existing files in ${targetDir}:\n` +
      collisions.map((p) => `  ${p}`).join('\n') +
      '\nPass --force to overwrite.\n',
    );
    process.exit(1);
  }

  // All clear — write files
  for (const entry of manifest.paths) {
    if (entry.classification !== 'mechanical' || entry.template === null) {
      continue;
    }

    const templateRelPath = entry.template;
    const realRelPath = templatePathToRealPath(templateRelPath);

    const srcPath = join(templatesDir, templateRelPath);
    const destPath = join(targetDir, realRelPath);

    const raw = readFileSync(srcPath, 'utf8');
    const rendered = substituteTokens(raw, tokens);

    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, rendered, 'utf8');
  }

  // Emit .gitkeep files so tracked empty directories land in the target.
  // These are not listed in the boundary-manifest (they are git artifacts),
  // so we walk the template tree for .gitkeep files and mirror them verbatim.
  const gitkeepCollisions = [];
  emitGitkeeps(templatesDir, templatesDir, targetDir, force, gitkeepCollisions);
  // .gitkeep collisions are non-fatal — they are empty marker files; silently
  // skip them if --force was not given (the directory already exists).
}
