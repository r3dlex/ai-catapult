#!/usr/bin/env node
// prepare-dist.ts — build the publishable dist/ contents (plugin payloads,
// staged vendored runtimes/templates, and the test snapshot).
// (Replaces the former scripts/prepare-dist.sh.)
import { fileURLToPath } from 'node:url';
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