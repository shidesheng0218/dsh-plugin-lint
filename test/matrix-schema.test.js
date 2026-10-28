import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheKeyFor } from '../src/matrix/cache.js';
import { createCell, recommendationEligible, selectCells } from '../src/matrix/cell.js';
import { readCellAny } from '../src/matrix/migrate.js';
import { validateCell } from '../src/matrix/schema.js';
import { PROVENANCE, artifact123, cellInput, completedObservation, v1ActiveVerified } from './matrix-helpers.js';

test('cache key changes with composition and resolved artifact', () => {
  const base = { artifact: artifact123(), dshVersion: '0.2.0-rc.2', probeVersion: '0.4.0' };
  assert.notEqual(cacheKeyFor({ ...base, composition: 'web' }), cacheKeyFor({ ...base, composition: 'headless' }));
  assert.notEqual(
    cacheKeyFor({ ...base, artifact: { ...base.artifact, resolvedVersion: '1.2.4' }, composition: 'web' }),
    cacheKeyFor({ ...base, composition: 'web' }),
  );
});

test('createCell emits valid v2 self-reported evidence with a matching cache key', () => {
  const input = cellInput();
  const cell = createCell(input);
  assert.equal(cell.schemaVersion, 2);
  assert.equal(cell.run.trust, 'self-reported');
  assert.equal(cell.plugin.loadedVersion, '1.2.3');
  assert.equal(cell.cacheKey, cacheKeyFor({ artifact: input.artifact, dshVersion: input.dsh.version, composition: 'headless', probeVersion: '0.4.0' }));
  assert.deepEqual(validateCell(cell), { ok: true, errors: [] });
});

test('v1 is legacy-unpinned and cannot be recommended or assigned a loaded version', () => {
  const { kind, cell } = readCellAny(v1ActiveVerified());
  assert.equal(kind, 'legacy-v1');
  assert.equal(cell.schemaVersion, 1);
  assert.equal(cell.run.trust, 'legacy-unpinned');
  assert.equal(cell.migration.originalTrust, 'verified');
  assert.equal(cell.recommendationEligible, false);
  assert.equal(cell.plugin.loadedVersion, undefined);
  assert.equal(recommendationEligible(cell), false);
});

test('recommendation requires trusted verification, recent evidence, and registry integrity', () => {
  const cell = createCell(cellInput());
  assert.equal(recommendationEligible(cell, { now: Date.parse('2026-10-15T00:00:00Z') }), false);
  cell.run.trust = 'verified';
  cell.run.verification = { ...PROVENANCE };
  assert.equal(recommendationEligible(cell, { now: Date.parse('2026-10-15T00:00:00Z') }), true);
  assert.equal(recommendationEligible(cell, { now: Date.parse('2026-11-01T00:00:00Z') }), false, 'older than 30 days');
  const local = createCell(cellInput({ artifact: { ...artifact123(), local: true, integrity: undefined, sourceDigest: 'abc123' } }));
  local.run.trust = 'verified';
  local.run.verification = { ...PROVENANCE };
  assert.equal(recommendationEligible(local), false);
});

test('composition selection never picks a best result across compositions', () => {
  const headless = createCell(cellInput({ composition: 'headless' }));
  const web = createCell(cellInput({ composition: 'web' }));
  assert.equal(selectCells([headless], { dshVersion: '0.2.0-rc.2' }).kind, 'unknown');
  assert.equal(selectCells([headless, web], { dshVersion: '0.2.0-rc.2' }).kind, 'mixed');
  const exact = selectCells([headless, web], { dshVersion: '0.2.0-rc.2', composition: 'web' });
  assert.equal(exact.kind, 'cells');
  assert.deepEqual(exact.cells.map((cell) => cell.dsh.composition), ['web']);
  assert.equal(selectCells([headless], { dshVersion: '0.2.0-rc.2', composition: 'web' }).kind, 'untested');
});

test('schema validation rejects missing integrity, bad keys, drift, and damaged fields', () => {
  const valid = createCell(cellInput());
  for (const mutate of [
    (cell) => { cell.schemaVersion = 99; },
    (cell) => { cell.cacheKey = 'bad'; },
    (cell) => { cell.plugin.integrity = undefined; },
    (cell) => { cell.plugin.loadedVersion = '1.2.4'; },
    (cell) => { cell.dsh.composition = 'best'; },
    (cell) => { cell.run.outcome = 'completed'; cell.result.entries = 'not-an-array'; },
    (cell) => { cell.cacheKey = '0'.repeat(64); },
  ]) {
    const cell = structuredClone(valid);
    mutate(cell);
    assert.equal(validateCell(cell).ok, false, JSON.stringify(cell));
  }
});

test('infrastructure error cells remain diagnosable without a plugin verdict', () => {
  const observation = completedObservation();
  const cell = createCell(cellInput({
    observation: {
      outcome: 'error',
      error: { code: 'VERSION_MISMATCH', message: 'version drift' },
      install: 'ok',
      entries: [],
      durationMs: 5,
    },
  }));
  assert.equal(cell.run.outcome, 'error');
  assert.equal(cell.run.error.code, 'VERSION_MISMATCH');
  assert.equal(cell.result, undefined);
  assert.equal(validateCell(cell).ok, true);
  assert.equal(recommendationEligible(cell), false);
});
