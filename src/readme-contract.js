import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveVendorSkill } from './skill-resolver.js';

// The canonical generator validates the whole rendered README. Keep the user
// repository identifier opaque during that validation so names such as TODO or
// downloads are not mistaken for unresolved content or public proof signals.
const REPO_ID_MARKER = 'ai-catapult-repository-id';
const UNRESOLVED_TEMPLATE_PATTERN = /@@[A-Z_]+@@|\{\{[^}]+\}\}|\[\[[^\]]+\]\]|<(?:your|insert|replace)[^>]*>|<(?:project[_ -]?name|tagline|install[_ -]?command|first[_ -]?success|success[_ -]?evidence)>/i;

function contractPaths(root) {
  return {
    generator: join(root, 'scripts', 'readme-generate.sh'),
    template: join(root, 'assets', 'readme', 'template.md'),
  };
}

export function resolveReadmeContract({ vendorSkillsDir, distDir }) {
  if (existsSync(vendorSkillsDir)) {
    const vendored = contractPaths(resolveVendorSkill(vendorSkillsDir));
    if (existsSync(vendored.generator) && existsSync(vendored.template)) return vendored;
    throw new Error('vendored ai-catapult-init skill is missing the canonical README contract; run bash setup.sh');
  }

  const staged = contractPaths(join(distDir, 'readme-contract'));
  if (existsSync(staged.generator) && existsSync(staged.template)) return staged;

  throw new Error(
    'canonical README contract not found; run bash setup.sh and bash scripts/stage-readme-contract.sh',
  );
}

export function reviewedReadmeSha(targetDir) {
  const readmePath = join(targetDir, 'README.md');
  if (!existsSync(readmePath)) return '';
  return createHash('sha256').update(readFileSync(readmePath)).digest('hex');
}

export function assertReadmeWriteAllowed(targetDir, force) {
  const readmePath = join(targetDir, 'README.md');
  if (existsSync(readmePath) && !force) {
    throw new Error(`init would overwrite existing file ${readmePath}; pass --force to overwrite`);
  }
}

function generatorArgs({ contract, targetDir, project, force, sourceSha, out }) {
  const args = [
    contract.generator,
    '--mode', 'template',
    '--repo', targetDir,
    '--project', project,
    '--tagline', 'Deterministic init-ai-repo v3 AI-SDLC governance scaffold.',
    '--why', 'Establish reviewable governance before repository-specific decisions are completed in an AI coding agent.',
    '--archetype', 'cli-tool',
    '--primary-surface', '`ai-catapult init` for mechanical setup; the `ai-catapult-init` plugin skill for repository-specific decisions.',
    '--mental-model', 'Generated files are deterministic review inputs: the CLI writes mechanical state, while the plugin completes judgment-laden governance.',
    '--install-command', 'npx ai-catapult install',
    '--first-success-command', 'test -f .ai/matrix.json && test -f .ai/handoff/NEXT-STEPS.md',
    '--success-evidence', `both generated files exist; \`.ai/matrix.json\` identifies \`${project}\` and \`.ai/handoff/NEXT-STEPS.md\` lists the in-harness completion step.`,
    '--requirements', 'Node.js 18 or newer and Bash.',
    '--update-command', 'npm install -g ai-catapult@latest',
    '--visibility', 'private',
  ];

  if (out) args.push('--out', out);
  if (force && sourceSha) args.push('--force', '--source-sha', sourceSha);
  return args;
}

function runGenerator(args, targetDir) {
  const result = spawnSync('bash', args, {
    cwd: existsSync(targetDir) ? targetDir : undefined,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(
      `canonical README generator failed (exit ${result.status})\n${result.stderr || result.stdout}`,
    );
  }
}

function injectRepoId(generated, repoId) {
  if (!generated.includes(REPO_ID_MARKER)) {
    throw new Error('canonical README generator omitted the repository identifier marker');
  }
  return generated.replaceAll(REPO_ID_MARKER, () => repoId);
}

function assertSafeRepoId(repoId) {
  if (!repoId.trim()) throw new Error('repository identifier must not be empty');
  if (/[\0\r\n]/.test(repoId)) {
    throw new Error('repository identifier must be a single line');
  }
  if (UNRESOLVED_TEMPLATE_PATTERN.test(repoId)) {
    throw new Error('repository identifier contains unresolved template content');
  }
}

export function preflightScaffoldReadme({ contract, targetDir, repoId }) {
  // Run the immutable contract before scaffold() performs its first write. The
  // candidate is intentionally discarded; the real render still owns guarded
  // replacement, backup, and audit behavior after the scaffold succeeds.
  const stagingDir = mkdtempSync(join(tmpdir(), 'ai-catapult-readme-preflight-'));
  const candidatePath = join(stagingDir, 'README.md');
  try {
    assertSafeRepoId(repoId);
    runGenerator(generatorArgs({
      contract,
      targetDir,
      project: REPO_ID_MARKER,
      force: false,
      sourceSha: '',
      out: candidatePath,
    }), targetDir);
    injectRepoId(readFileSync(candidatePath, 'utf8'), repoId);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

export function generateScaffoldReadme({ contract, targetDir, repoId, force, sourceSha }) {
  assertSafeRepoId(repoId);
  runGenerator(generatorArgs({
    contract,
    targetDir,
    project: REPO_ID_MARKER,
    force,
    sourceSha,
  }), targetDir);

  const readmePath = join(targetDir, 'README.md');
  const generated = readFileSync(readmePath, 'utf8');
  writeFileSync(readmePath, injectRepoId(generated, repoId), 'utf8');
}
