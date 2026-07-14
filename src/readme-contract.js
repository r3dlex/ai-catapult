import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { resolveVendorSkill } from './skill-resolver.js';

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

export function generateScaffoldReadme({ contract, targetDir, repoId, force, sourceSha }) {
  const args = [
    contract.generator,
    '--mode', 'template',
    '--repo', targetDir,
    '--project', repoId,
    '--tagline', 'Deterministic init-ai-repo v3 AI-SDLC governance scaffold.',
    '--why', 'Establish reviewable governance before repository-specific decisions are completed in an AI coding agent.',
    '--archetype', 'cli-tool',
    '--primary-surface', '`ai-catapult init` for mechanical setup; the `ai-catapult-init` plugin skill for repository-specific decisions.',
    '--mental-model', 'Generated files are deterministic review inputs: the CLI writes mechanical state, while the plugin completes judgment-laden governance.',
    '--install-command', 'npx ai-catapult install',
    '--first-success-command', 'test -f .ai/matrix.json && test -f .ai/handoff/NEXT-STEPS.md',
    '--success-evidence', `both generated files exist; \`.ai/matrix.json\` identifies \`${repoId}\` and \`.ai/handoff/NEXT-STEPS.md\` lists the in-harness completion step.`,
    '--requirements', 'Node.js 18 or newer and Bash.',
    '--update-command', 'npm install -g ai-catapult@latest',
    '--visibility', 'private',
  ];

  if (force && sourceSha) args.push('--force', '--source-sha', sourceSha);

  const result = spawnSync('bash', args, {
    cwd: targetDir,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `canonical README generator failed (exit ${result.status})\n${result.stderr || result.stdout}`,
    );
  }
}
