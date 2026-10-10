/**
 * TDD tests for Goal tswc-ac-b1 AC-1/AC-2 — the evolve/ flow, integrated.
 *
 * One full pass through the three-layer workspace (master §3a), as the layers
 * compose into a deterministic pipeline:
 *
 *   1. raw/   recordTrace() pins a write-once turn trace for the run
 *   2. raw/   recordJudgment() pins the §5.4 judgment record write-once
 *             under evolve/raw/<run-id>/judgment-<judgment_id>.json
 *   3. wiki/  appendWikiFile() appends the run log line to logs.md and
 *             appendAuditEntry() appends the audit-entry fenced block to
 *             skill-impact.md (the skill audit trail — append-only,
 *             never rolled back)
 *
 * Determinism contract: two independent roots replaying the identical script
 * must end up byte-identical trees. The serializers therefore emit fields in
 * a fixed canonical order independent of input key order, so the recorded
 * bytes depend only on the data.
 *
 * All filesystem work happens in mkdtemp() dirs under os.tmpdir(); nothing in
 * the checkout is ever written.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { evolvePaths, initEvolveLayout, verifyEvolveLayout } from '../src/evolve/layout.ts';
import { recordTrace } from '../src/evolve/write-once.ts';
import { recordJudgment, serializeJudgmentRecord, JUDGMENT_FIELD_ORDER } from '../src/evolve/judgment.ts';
import { renderAuditEntryBlock, appendAuditEntry, AUDIT_FIELD_ORDER } from '../src/evolve/audit.ts';
import { appendWikiFile } from '../src/evolve/append-only.ts';
import { EvolveError } from '../src/evolve/errors.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = join(__dirname, 'fixtures/evolve');

const RUN_ID = 'run-2026-10-10-alpha';
const TRACE_NAME = 'trace-turn-1.json';
const LOG_LINE = 'log: run-2026-10-10-alpha traced turn 1\n';

/** Load a golden fixture as a generic record. */
function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixtures, name), 'utf8')) as Record<string, unknown>;
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Recursively collect all files under a directory as sorted relative paths. */
function collectFiles(dir: string, base: string = dir, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(fullPath, base, acc);
    } else {
      acc.push(relative(base, fullPath));
    }
  }
  return acc;
}

/** Hash an entire tree byte-exactly, walking files in sorted order. */
function treeDigest(root: string): string {
  const parts: string[] = [];
  for (const rel of collectFiles(root)) {
    parts.push(`${rel}:${sha256(readFileSync(join(root, rel)))}`);
  }
  return sha256(Buffer.from(parts.join('\n'), 'utf8'));
}

/** Rebuild a record with fields in a fixed order (shallow copy). */
function canonicalByOrder(record: Record<string, unknown>, order: readonly string[]): Record<string, unknown> {
  const canonical: Record<string, unknown> = {};
  for (const key of order) {
    canonical[key] = record[key];
  }
  return canonical;
}

/** Build a copy of a record with every key order reversed (top level + score items). */
function reversedKeyOrder(record: Record<string, unknown>): Record<string, unknown> {
  const reversed: Record<string, unknown> = {};
  for (const key of Object.keys(record).reverse()) {
    const nested = record[key];
    if (Array.isArray(nested)) {
      reversed[key] = nested.map((item) => reverseShallow(item));
    } else {
      reversed[key] = reverseShallow(nested);
    }
  }
  return reversed;
}

function reverseShallow(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return reversedKeyOrder(value as Record<string, unknown>);
}

interface FlowResult {
  digest: string;
  files: string[];
  tracePath: string;
  judgmentPath: string;
  judgmentSha: string;
}

/** Run the identical evolve flow script on a root; returns artifacts + digests. */
function runFlow(root: string): FlowResult {
  const paths = evolvePaths(root);
  initEvolveLayout(root);

  const trace = recordTrace(paths, RUN_ID, TRACE_NAME, '{"turn":1}\n');
  const goldenJudgment = loadFixture('judgment-record-v1.golden.json');
  const judgment = recordJudgment(paths, goldenJudgment);

  appendWikiFile(paths, 'logs.md', LOG_LINE);
  const goldenAudit = loadFixture('audit-entry-v1.golden.json');
  appendAuditEntry(paths, goldenAudit);

  return {
    digest: treeDigest(root),
    files: collectFiles(root),
    tracePath: trace.path,
    judgmentPath: judgment.path,
    judgmentSha: judgment.sha256,
  };
}

void test('evolve flow: the identical script on two independent roots produces byte-identical trees', () => {
  const rootA = mkdtempSync(join(tmpdir(), 'evolve-flow-a-'));
  const rootB = mkdtempSync(join(tmpdir(), 'evolve-flow-b-'));
  const roots = [rootA, rootB];
  try {
    const a = runFlow(rootA);
    const b = runFlow(rootB);

    // Determinism: same script, same bytes — the whole tree digest matches.
    assert.equal(a.digest, b.digest);

    // The flow produces exactly the expected artifact set (root-relative,
    // with the evolve/ workspace prefix collectFiles() reports from the root).
    const expected = [
      join('evolve', 'PURPOSE.md'),
      join('evolve', 'raw', RUN_ID, 'judgment-j-20261010-0001.json'),
      join('evolve', 'raw', RUN_ID, TRACE_NAME),
      join('evolve', 'wiki', 'logs.md'),
      join('evolve', 'wiki', 'skill-impact.md'),
    ];
    assert.deepEqual(a.files.sort(), expected.slice().sort());

    // Judgment bytes land pinned under raw/<run-id>/ with the recorded digest.
    assert.ok(a.judgmentPath.endsWith(join('evolve', 'raw', RUN_ID, 'judgment-j-20261010-0001.json')));
    assert.equal(a.judgmentSha, sha256(readFileSync(a.judgmentPath)));
    assert.ok(a.tracePath.endsWith(join('evolve', 'raw', RUN_ID, TRACE_NAME)));

    // The layout verifier stays green with wiki content and run dirs present:
    // logs.md, skill-impact.md and raw/<run-id>/ files are expected content.
    for (const root of roots) {
      assert.deepEqual(verifyEvolveLayout(root), { ok: true, violations: [] });
    }
  } finally {
    roots.forEach((root) => rmSync(root, { recursive: true, force: true }));
  }
});

void test('judgment serialization: fixed §5.4 order, 2-space indent, independent of input key order', () => {
  const golden = loadFixture('judgment-record-v1.golden.json');

  // Exact serialization: fields in the §5.4 order, indent 2, trailing newline.
  const expected = JSON.stringify(canonicalByOrder(golden, JUDGMENT_FIELD_ORDER), null, 2) + '\n';
  assert.equal(serializeJudgmentRecord(golden), expected);

  // Determinism: a copy with every key order reversed serializes identically
  // (top-level fields and nested per_criterion_scores items alike).
  assert.equal(serializeJudgmentRecord(reversedKeyOrder(golden)), expected);

  // Round-trip: parse-back is the same record.
  assert.deepEqual(JSON.parse(serializeJudgmentRecord(golden)), golden);
});

void test('judgment recording: duplicate judgment_id is refused write-once and the pinned bytes stay untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'evolve-flow-dup-'));
  const paths = evolvePaths(root);
  try {
    initEvolveLayout(root);
    const golden = loadFixture('judgment-record-v1.golden.json');
    const first = recordJudgment(paths, golden);
    const before = readFileSync(first.path);

    // Same record again: the file exists, write-once refuses.
    assert.throws(() => recordJudgment(paths, golden), (err: unknown) =>
      err instanceof EvolveError && err.kind === 'write-once-violation',
    );

    // And even an altered duplicate under the same judgment_id cannot replace it.
    assert.throws(() => recordJudgment(paths, { ...golden, weighted_aggregate: 0.9 }), (err: unknown) =>
      err instanceof EvolveError && err.kind === 'write-once-violation',
    );

    // The pinned bytes are exactly the first write — never rolled back, never edited.
    assert.deepEqual(readFileSync(first.path), before);
    assert.equal(readFileSync(first.path, 'utf8'), serializeJudgmentRecord(golden));

    // A malformed judgment record never lands on disk at all.
    assert.throws(() => recordJudgment(paths, { ...golden, judgment_id: '' }), (err: unknown) =>
      err instanceof EvolveError && err.kind === 'schema-violation',
    );
    assert.deepEqual(collectFiles(join(root, 'evolve/raw')), [
      join(RUN_ID, 'judgment-j-20261010-0001.json'),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('audit entries: fenced single-line blocks in fixed order, appended to skill-impact.md', () => {
  const root = mkdtempSync(join(tmpdir(), 'evolve-flow-audit-'));
  const paths = evolvePaths(root);
  try {
    initEvolveLayout(root);
    const golden = loadFixture('audit-entry-v1.golden.json');
    const meta = golden.metadata as Record<string, unknown>;
    const score = golden.score as Record<string, unknown>;

    // Exact rendering: one fenced json block, keys in the fixed top-level order,
    // metadata and score canonicalised in their fixed field orders too.
    const canonical = canonicalByOrder(golden, AUDIT_FIELD_ORDER);
    canonical.metadata = {
      run_id: meta.run_id,
      cycle: meta.cycle,
      recorded_at: meta.recorded_at,
      recorder: meta.recorder,
    };
    canonical.score = { weighted_aggregate: score.weighted_aggregate, rubric_sha256: score.rubric_sha256 };
    const line = JSON.stringify(canonical);
    const expectedBlock = `\`\`\`json\n${line}\n\`\`\`\n`;

    // Order independence: a copy with reversed key order renders identical bytes.
    assert.equal(renderAuditEntryBlock(golden), expectedBlock);
    assert.equal(renderAuditEntryBlock(reversedKeyOrder(golden)), expectedBlock);
    assert.ok(line.includes('"verdict":"Rejected"'), 'the golden entry is a Rejected verdict');

    const appended = appendAuditEntry(paths, golden);
    assert.ok(appended.path.endsWith(join('evolve', 'wiki', 'skill-impact.md')));
    assert.equal(readFileSync(paths.wikiSkillImpactFile, 'utf8'), expectedBlock);

    // Second entry appends after the first — history in order, never rewritten.
    const acceptedEntry = { ...golden, verdict: 'Accepted' };
    const acceptedBlock = renderAuditEntryBlock(acceptedEntry);
    appendAuditEntry(paths, acceptedEntry);
    assert.equal(
      readFileSync(paths.wikiSkillImpactFile, 'utf8'),
      expectedBlock + acceptedBlock,
    );

    // The workspace stays verifiable with the audit blocks in place.
    assert.deepEqual(verifyEvolveLayout(root), { ok: true, violations: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
