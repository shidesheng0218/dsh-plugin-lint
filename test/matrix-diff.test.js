import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffRuns, formatDiff } from '../src/matrix/diff.js';
import { writeCell } from '../src/matrix/cells.js';
import { createCell } from '../src/matrix/cell.js';
import { cellInput, completedObservation } from './matrix-helpers.js';

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'diff-'));
}

// Build a v2 completed cell with controllable status/tools/prompt.
function v2({ name, version = '1.0.0', dsh, composition = 'headless', status = 'active', tools = ['tool_a'], promptChars = 100 }) {
  const observation = {
    ...completedObservation(),
    loadedVersion: version,
    result: {
      ...completedObservation().result,
      status,
      composition,
      tools: { baseline: 25, total: 25 + tools.length, added: tools, removed: [] },
      systemPrompt: { baselineChars: 200, chars: promptChars },
    },
  };
  return createCell(cellInput({
    artifact: { name, requestedVersion: version, resolvedVersion: version, integrity: 'sha512-x', local: false },
    dsh: { version: dsh, source: 'npm', composition },
    composition,
    observation,
  }));
}

// A v2 error cell (no result, run.outcome = 'error').
function v2error({ name, version = '1.0.0', dsh, composition = 'headless' }) {
  const observation = {
    outcome: 'error',
    durationMs: 5,
    error: { code: 'PROBE_FAILED', message: 'boom' },
    reproduce: { command: 'x' },
  };
  return createCell(cellInput({
    artifact: { name, requestedVersion: version, resolvedVersion: version, integrity: 'sha512-x', local: false },
    dsh: { version: dsh, source: 'npm', composition },
    composition,
    observation,
  }));
}

// A legacy v1 cell: no cacheKey, no tools/systemPrompt.
function v1({ name, version = '1.0.0', dsh, composition = 'headless', status = 'active' }) {
  return {
    schemaVersion: 1,
    plugin: { name, version, integrity: 'sha512-legacy', local: false },
    dsh: { version: dsh, source: 'npm', profile: composition },
    probe: { tool: 'dsh-plugin-lint/probe', mode: composition },
    run: { at: '2026-09-01T00:00:00.000Z', durationMs: 10, trust: 'verified', os: 'linux-x64', node: 'v22.0.0' },
    result: { status, composition, entries: [], clientHalf: 'not-covered' },
    evidence: { note: 'legacy' },
    reproduce: { command: 'node scripts/probe-boot.mjs x' },
  };
}

function writeRaw(dir, cell, filename) {
  const path = join(dir, filename);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(cell, null, 2) + '\n');
}

test('diff puts a completed/completed status change in transitions', () => {
  const a = makeRoot(); const b = makeRoot();
  writeCell(a, v2({ name: 'p', dsh: '0.2.0', status: 'active' }));
  writeCell(b, v2({ name: 'p', dsh: '0.2.0', status: 'rejected-by-host' }));
  const report = diffRuns(a, b);
  assert.equal(report.transitions.length, 1);
  assert.equal(report.transitions[0].from, 'active');
  assert.equal(report.transitions[0].to, 'rejected-by-host');
  assert.equal(report.errorTransitions.length, 0);
});

test('diff buckets an error on exactly one side into errorTransitions, not transitions', () => {
  const a = makeRoot(); const b = makeRoot();
  writeCell(a, v2({ name: 'p', dsh: '0.2.0', status: 'active' }));
  writeCell(b, v2error({ name: 'p', dsh: '0.2.0' }));
  const report = diffRuns(a, b);
  assert.equal(report.transitions.length, 0);
  assert.equal(report.errorTransitions.length, 1);
  assert.deepEqual([report.errorTransitions[0].from, report.errorTransitions[0].to], ['active', 'error']);
});

test('diff marks v1 cells notComparable for tools/prompt but still transitions on status', () => {
  const a = makeRoot(); const b = makeRoot();
  writeRaw(a, v1({ name: 'legacy', dsh: '0.2.0', status: 'active' }), 'legacy/a.json');
  writeRaw(b, v1({ name: 'legacy', dsh: '0.2.0', status: 'rejected-by-host' }), 'legacy/b.json');
  const report = diffRuns(a, b);
  assert.equal(report.transitions.length, 1);
  const reasons = report.notComparable.map((n) => n.reason);
  assert.ok(reasons.some((r) => r.includes('no tools data')));
  assert.ok(reasons.some((r) => r.includes('no prompt data')));
});

test('diff compares tools.added as a set difference and systemPrompt.chars as numbers', () => {
  const a = makeRoot(); const b = makeRoot();
  writeCell(a, v2({ name: 'p', dsh: '0.2.0', status: 'active', tools: ['x', 'y'], promptChars: 100 }));
  writeCell(b, v2({ name: 'p', dsh: '0.2.0', status: 'active', tools: ['y', 'z'], promptChars: 140 }));
  const report = diffRuns(a, b);
  assert.equal(report.transitions.length, 0); // same status
  assert.deepEqual(report.toolDeltas, [{ key: report.toolDeltas[0].key, added: ['z'], removed: ['x'] }]);
  assert.equal(report.promptDelta[0].fromChars, 100);
  assert.equal(report.promptDelta[0].toChars, 140);
});

test('diff reports newCells and droppedCells for unmatched keys', () => {
  const a = makeRoot(); const b = makeRoot();
  writeCell(a, v2({ name: 'only-a', dsh: '0.2.0' }));
  writeCell(b, v2({ name: 'only-b', dsh: '0.2.0' }));
  const report = diffRuns(a, b);
  assert.equal(report.newCells.length, 1);
  assert.equal(report.droppedCells.length, 1);
});

test('formatDiff leads with the active->rejected-by-host count', () => {
  const a = makeRoot(); const b = makeRoot();
  writeCell(a, v2({ name: 'p', dsh: '0.2.0', status: 'active' }));
  writeCell(b, v2({ name: 'p', dsh: '0.2.0', status: 'rejected-by-host' }));
  const text = formatDiff(diffRuns(a, b));
  assert.match(text, /active/);
  assert.match(text, /rejected/);
});
