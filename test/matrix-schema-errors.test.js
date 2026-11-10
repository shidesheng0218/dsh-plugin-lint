import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCell } from '../src/matrix/cell.js';
import { buildIndex } from '../src/matrix/index.js';
import { buildManifest } from '../src/matrix/manifest.js';
import { validateCell, validateIndex, validateManifest } from '../src/matrix/schema.js';
import { sha256 } from '../src/shared/hash.js';
import { cellInput } from './matrix-helpers.js';

const clone = (value) => structuredClone(value);
const validCell = () => createCell(cellInput());

const CELL_CASES = [
  ['a non-object', () => 42],
  ['a legacy schemaVersion', (cell) => { cell.schemaVersion = 1; }],
  ['a missing cacheKey', (cell) => { delete cell.cacheKey; }],
  ['a missing plugin name', (cell) => { delete cell.plugin.name; }],
  ['a missing requestedVersion', (cell) => { delete cell.plugin.requestedVersion; }],
  ['a non-boolean local flag', (cell) => { cell.plugin.local = 'no'; }],
  ['a registry artifact without integrity', (cell) => { delete cell.plugin.integrity; }],
  ['a local artifact without sourceDigest', (cell) => { cell.plugin.local = true; delete cell.plugin.sourceDigest; }],
  ['a completed cell without loadedVersion', (cell) => { delete cell.plugin.loadedVersion; }],
  ['loadedVersion differing from resolvedVersion', (cell) => { cell.plugin.loadedVersion = '9.9.9'; }],
  ['a missing dsh version', (cell) => { delete cell.dsh.version; }],
  ['a missing dsh source', (cell) => { delete cell.dsh.source; }],
  ['an unknown composition', (cell) => { cell.dsh.composition = 'tui'; }],
  ['a missing probe version', (cell) => { delete cell.probe.version; }],
  ['a missing isolation', (cell) => { delete cell.probe.isolation; }],
  ['a probe host without os', (cell) => { delete cell.probe.host.os; }],
  ['an unknown run outcome', (cell) => { cell.run.outcome = 'maybe'; }],
  ['an unknown trust level', (cell) => { cell.run.trust = 'trusted'; }],
  ['an invalid run date', (cell) => { cell.run.at = 'yesterday'; }],
  ['a negative duration', (cell) => { cell.run.durationMs = -1; }],
  ['a verified cell without provenance', (cell) => { cell.run.trust = 'verified'; }],
  ['a verified cell with the wrong probe version', (cell) => {
    cell.run.trust = 'verified';
    cell.run.verification = { workflow: 'w', runId: 'r', url: 'https://example.test/r', probeVersion: '0.0.1' };
  }],
  ['a disputed cell without both verdicts', (cell) => { cell.run.trust = 'disputed'; cell.run.dispute = { reported: 'active' }; }],
  ['an error cell that also carries a verdict', (cell) => {
    cell.run.outcome = 'error';
    cell.run.error = { code: 'X', message: 'boom' };
  }],
  ['an error cell without an error code', (cell) => {
    cell.run.outcome = 'error';
    cell.run.error = { message: 'boom' };
    delete cell.result;
  }],
  ['a completed cell without a result', (cell) => { delete cell.result; }],
  ['a completed result without entries', (cell) => { delete cell.result.entries; }],
  ['a completed result without awaitedServices', (cell) => { delete cell.result.awaitedServices; }],
  ['a completed result without clientHalf', (cell) => { delete cell.result.clientHalf; }],
  ['a result composition that differs from dsh.composition', (cell) => { cell.result.composition = 'web'; }],
  ['an evidence block without outputSha256', (cell) => { delete cell.evidence.outputSha256; }],
  ['a missing reproduce command', (cell) => { delete cell.reproduce.command; }],
  ['a cacheKey that does not match the inputs', (cell) => { cell.cacheKey = '0'.repeat(64); }],
];

for (const [label, mutate] of CELL_CASES) {
  test('validateCell rejects ' + label, () => {
    const cell = mutate.length === 0 ? mutate() : clone(validCell());
    const target = mutate.length === 0 ? cell : cell;
    if (typeof target !== 'object') {
      assert.equal(validateCell(target).ok, false);
      return;
    }
    mutate(target);
    assert.equal(validateCell(target).ok, false);
  });
}

test('validateCell rejects an unknown trust vocabulary and accepts a valid error cell', () => {
  const errorCell = createCell(cellInput({
    observation: {
      outcome: 'error',
      error: { code: 'PROBE_FAILED', message: 'it failed' },
      durationMs: 5,
      reproduce: { command: 'node probe' },
    },
  }));
  assert.equal(validateCell(errorCell).ok, true);
  assert.equal(errorCell.result, undefined);
});

test('validateIndex rejects malformed index shapes', () => {
  const index = buildIndex([validCell()], { generatedAt: '2026-10-01T00:00:00.000Z', source: { runId: 'r' } });
  const cases = [
    (value) => { value.schemaVersion = 1; },
    (value) => { value.generatedAt = 'never'; },
    (value) => { value.dshVersions = '0.2.0'; },
    (value) => { value.plugins = {}; },
    (value) => { delete value.plugins[0].name; },
    (value) => { value.plugins[0].versions = '1'; },
    (value) => { delete value.plugins[0].versions[0].version; },
    (value) => { value.plugins[0].versions[0].cells = {}; },
    (value) => { value.plugins[0].versions[0].cells[0].cacheKey = 'abc'; },
    (value) => { value.plugins[0].versions[0].cells[0].dsh = 1; },
    (value) => { value.plugins[0].versions[0].cells[0].composition = 'tui'; },
    (value) => { value.plugins[0].versions[0].cells[0].status = 1; },
    (value) => { value.plugins[0].versions[0].cells[0].trust = 1; },
    (value) => { value.plugins[0].versions[0].cells[0].at = 'never'; },
    (value) => { value.plugins[0].versions[0].cells[0].toolsAdded = 'x'; },
    (value) => { value.plugins[0].versions[0].cells[0].reproduce = 1; },
  ];
  for (const mutate of cases) {
    const copy = clone(index);
    mutate(copy);
    assert.equal(validateIndex(copy).ok, false);
  }
  assert.equal(validateIndex(index).ok, true);
});

test('validateManifest rejects malformed manifests and unsafe paths', () => {
  const digest = sha256('a');
  const manifest = buildManifest({
    runId: 'run-1',
    generatedAt: '2026-10-01T00:00:00.000Z',
    probeVersion: '0.4.0',
    inputs: { a: 1 },
    artifacts: [{ path: 'cells/a.json', bytes: 1, sha256: digest }],
  });
  const cases = [
    (value) => { value.schemaVersion = 1; },
    (value) => { value.runId = ''; },
    (value) => { value.generatedAt = 'never'; },
    (value) => { value.probeVersion = ''; },
    (value) => { value.inputsSha256 = 'abc'; },
    (value) => { value.artifacts = {}; },
    (value) => { value.artifacts[0].path = '/etc/passwd'; },
    (value) => { value.artifacts[0].path = '../escape'; },
    (value) => { value.artifacts[0].path = 'a\\b'; },
    (value) => { value.artifacts[0].path = 'a\0b'; },
    (value) => { value.artifacts.push({ ...value.artifacts[0] }); },
    (value) => { value.artifacts[0].bytes = -1; },
    (value) => { value.artifacts[0].bytes = 1.5; },
    (value) => { value.artifacts[0].sha256 = 'abc'; },
  ];
  for (const mutate of cases) {
    const copy = clone(manifest);
    mutate(copy);
    assert.equal(validateManifest(copy).ok, false);
  }
  assert.equal(validateManifest(manifest).ok, true);
});