import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

function fail(message) {
  throw new Error(`Invalid vendored skills: ${message}`);
}

function safeRelativePath(value, field) {
  if (typeof value !== 'string' || value.length === 0) fail(`${field} must be a non-empty string`);
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\')) {
    fail(`${field} must be a repository-relative POSIX path`);
  }
  const parts = value.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    fail(`${field} contains path traversal or empty segments: ${value}`);
  }
  return value;
}

function pathInside(root, candidate, field) {
  const rootReal = realpathSync(root);
  const candidateReal = realpathSync(candidate);
  const rel = relative(rootReal, candidateReal);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail(`${field} resolves outside vendor/skills`);
  }
  return candidateReal;
}

function frontmatterName(skillMd) {
  const text = readFileSync(skillMd, 'utf8');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) fail(`${skillMd} has no YAML frontmatter`);
  const nameLine = match[1].split(/\r?\n/).find((line) => /^name\s*:/.test(line));
  if (!nameLine) fail(`${skillMd} frontmatter has no name`);
  const value = nameLine.slice(nameLine.indexOf(':') + 1).trim();
  return value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_, double, single) => double ?? single);
}

function validateTemplates(skillDir) {
  const templatesDir = join(skillDir, 'templates');
  const manifestPath = join(templatesDir, 'boundary-manifest.json');
  if (!existsSync(manifestPath)) fail('ai-catapult-init/templates/boundary-manifest.json is missing');

  for (const template of [
    'graph-automation/config.json',
    'graph-automation/graph-refresh.sh',
    'graph-automation/harness-hooks.json',
    'graph-automation/hook-body.sh',
  ]) {
    if (!existsSync(join(templatesDir, template))) fail(`required template is missing: ${template}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(`boundary-manifest.json is malformed: ${error.message}`);
  }
  if (!Array.isArray(manifest.paths)) fail('boundary-manifest.json paths must be an array');
  for (const entry of manifest.paths) {
    if (entry?.classification !== 'mechanical') continue;
    const template = safeRelativePath(entry.template, 'boundary manifest template');
    const templatePath = join(templatesDir, template);
    if (!existsSync(templatePath)) fail(`required template is missing: ${template}`);
    pathInside(templatesDir, templatePath, 'boundary manifest template');
  }
}

function readCatalog(vendorSkillsDir) {
  if (!existsSync(vendorSkillsDir)) fail(`directory not found: ${vendorSkillsDir}`);

  const catalogPath = join(vendorSkillsDir, 'catalog.json');
  if (!existsSync(catalogPath)) {
    fail(`catalog.json is missing from ${vendorSkillsDir}; refresh the vendored skills checkout from skills.lock.json`);
  }
  let catalog;
  try {
    catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  } catch (error) {
    fail(`catalog.json is malformed: ${error.message}`);
  }
  if (!Array.isArray(catalog.skills)) fail('catalog.json skills must be an array');
  return catalog;
}

/** Resolve and validate a canonical skill from a vendored skills checkout. */
export function resolveVendorSkill(vendorSkillsDir, skillName = 'ai-catapult-init') {
  const catalog = readCatalog(vendorSkillsDir);
  const matches = catalog.skills.filter((entry) => entry?.name === skillName);
  if (matches.length !== 1) {
    fail(`catalog.json must contain exactly one canonical ${skillName} entry (found ${matches.length})`);
  }
  const sourcePath = safeRelativePath(matches[0].source_path, `${skillName} source_path`);

  const skillDir = join(vendorSkillsDir, sourcePath);
  const skillMd = join(skillDir, 'SKILL.md');
  if (!existsSync(skillMd)) fail(`${sourcePath}/SKILL.md is missing`);
  const resolvedSkillDir = pathInside(vendorSkillsDir, skillDir, `${skillName} source_path`);
  if (frontmatterName(join(resolvedSkillDir, 'SKILL.md')) !== skillName) {
    fail(`${sourcePath}/SKILL.md frontmatter name does not match ${skillName}`);
  }
  if (skillName === 'ai-catapult-init') validateTemplates(resolvedSkillDir);
  return resolvedSkillDir;
}

/**
 * Resolve every skill the plugin bundles for `host`, as `{ name, dir }` sorted
 * by name.
 *
 * The set is derived from the vendored catalog rather than declared here: a
 * hand-maintained roster in this repo would silently lag the skills repo, which
 * is the SSOT. A skill is bundled unless it is deprecated or declares
 * `supported_hosts` without `host`; an entry that omits `supported_hosts`
 * predates the field and is treated as host-agnostic.
 *
 * Fails closed if ai-catapult-init is absent — it is the scaffolding skill the
 * CLI, the README contract, and the template staging all resolve against, so a
 * catalog without it means the vendored checkout is wrong, not that the plugin
 * should ship without it.
 */
export function resolveBundledSkills(vendorSkillsDir, { host = 'claude-code' } = {}) {
  const catalog = readCatalog(vendorSkillsDir);
  const names = catalog.skills
    .filter((entry) => entry?.lifecycle !== 'deprecated')
    .filter((entry) => !Array.isArray(entry?.supported_hosts) || entry.supported_hosts.includes(host))
    .map((entry) => entry?.name)
    .sort();

  if (!names.includes('ai-catapult-init')) {
    fail(`catalog.json has no ai-catapult-init entry bundled for host ${host}`);
  }
  return names.map((name) => ({ name, dir: resolveVendorSkill(vendorSkillsDir, name) }));
}
