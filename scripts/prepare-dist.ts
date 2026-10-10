#!/usr/bin/env node
// prepare-dist.ts — build the publishable dist/ contents (plugin payloads,
// staged vendored runtimes/templates, and the test snapshot).
// (Replaces the former scripts/prepare-dist.sh.)
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleDir, packageRoot } from '../src/paths.ts';
import { run as buildClaudePlugin } from './build-claude-plugin.ts';
import { run as buildCodexPlugin } from './build-codex-plugin.ts';
import { run as buildOpencodePlugin } from './build-opencode-plugin.ts';
import { run as snapshotDist } from './snapshot-dist.ts';
import { run as stageCiAdaptersRuntime } from './stage-ci-adapters-runtime.ts';
import { run as stageKnowledgeContract } from './stage-knowledge-contract.ts';
import { run as stageMatrixRuntime } from './stage-matrix-runtime.ts';
import { run as stageReadmeContract } from './stage-readme-contract.ts';
import { run as stageSkillTemplates } from './stage-skill-templates.ts';

export function run(): void {
  // The compiled bin is reached through npm's bin symlink shim, which requires
  // exec permission on the target file; tsc emits everything as 0644. The
  // tracked bin keeps its 0755 mode (mode fidelity), so the compiled artifact
  // must too — otherwise `npm i -g` installs a CLI that cannot be executed.
  chmodSync(join(packageRoot(moduleDir(import.meta.url)), 'dist', 'bin', 'ai-catapult.js'), 0o755);
  buildClaudePlugin();
  buildCodexPlugin();
  buildOpencodePlugin();
  stageSkillTemplates();
  stageReadmeContract();
  stageKnowledgeContract();
  stageMatrixRuntime();
  stageCiAdaptersRuntime();
  snapshotDist();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run();