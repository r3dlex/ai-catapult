#!/usr/bin/env node
// list-bundled-skills.js <vendor-skills-dir> [host]
//
// Prints one "<name>\t<absolute-dir>" line per bundled skill so the bash build
// scripts can iterate the set without reimplementing catalog parsing.
import { resolveBundledSkills } from '../src/skill-resolver.js';

const skills = resolveBundledSkills(process.argv[2], { host: process.argv[3] ?? 'claude-code' });
process.stdout.write(skills.map((s) => `${s.name}\t${s.dir}`).join('\n') + '\n');
