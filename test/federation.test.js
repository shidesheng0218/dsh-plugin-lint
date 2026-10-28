import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCell } from '../src/matrix/cell.js';
import { cellFilePath, writeCell } from '../src/matrix/cells.js';
import { exportPublicArtifact } from '../src/matrix/export.js';
import { applyVerification, sampleCells, verifyCells } from '../src/matrix/verify.js';
import { cellInput, completedObservation, PROVENANCE } from './matrix-helpers.js';

function confirmedEntry(cell, overrides = {}) {
  return {
    cacheKey: cell.cacheKey,
    reported: { status: cell.result.status },
    observed: { status: cell.result.status },
    verdict: 'confirmed',
    verification: { ...PROVENANCE },
    ...overrides,
  };
}

test('local confirmation does not self-promote to project verified', () => {
  const cell = createCell(cellInput());
  const updated = applyVerification(cell, confirmedEntry(cell));
  assert.equal(updated.run.trust, 'self-reported');
  assert.equal(cell.run.trust, 'self-reported', 'input is untouched');
});

test('only a trusted verifier with the same cache key promotes to verified', () => {
  const cell = createCell(cellInput());
  const updated = applyVerification(cell, confirmedEntry(cell), { trustedVerifier: true });
  assert.equal(updated.run.trust, 'verified');
  assert.equal(updated.run.verification.runId, PROVENANCE.runId);
  assert.equal(cell.run.trust, 'self-reported');
});

test('a different cache key is invalid verification, not comparable evidence', () => {
  const cell = createCell(cellInput());
  assert.throws(
    () => applyVerification(cell, confirmedEntry(cell, { cacheKey: '0'.repeat(64) }), { trustedVerifier: true }),
    (error) => error.code === 'VERIFICATION_KEY_MISMATCH',
  );
  assert.equal(cell.run.trust, 'self-reported');
});

test('the same artifact with a different observed status is disputed with both results', () => {
  const cell = createCell(cellInput());
  const entry = confirmedEntry(cell, { observed: { status: 'rejected-by-host' }, verdict: 'disputed' });
  const updated = applyVerification(cell, entry, { trustedVerifier: true });
  assert.equal(updated.run.trust, 'disputed');
  assert.equal(updated.run.dispute.reported, cell.result.status);
  assert.equal(updated.run.dispute.observed, 'rejected-by-host');
});

test('verifyCells binds cache keys and separates observation disagreement from infrastructure errors', async () => {
  const cells = [createCell(cellInput()), createCell(cellInput({ composition: 'web' }))];
  const observations = [
    { ...completedObservation(), result: { ...completedObservation().result, status: 'rejected-by-host' } },
    { outcome: 'error', error: { code: 'ARTIFACT_MISSING', message: 'missing' }, entries: [], durationMs: 1 },
  ];
  const report = await verifyCells({ cells, probe: async () => observations.shift(), verifier: PROVENANCE });
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.checked, 2);
  assert.equal(report.cells[0].cacheKey, cells[0].cacheKey);
  assert.equal(report.cells[0].verdict, 'disputed');
  assert.equal(report.cells[1].verdict, 'error');
  assert.equal(report.errors, 1);
  assert.equal(cells[0].run.trust, 'self-reported');
});

test('sampleCells is deterministic and --all disables sampling', () => {
  const cells = Array.from({ length: 10 }, (_, index) => ({ index }));
  assert.deepEqual(sampleCells(cells, { sample: 0.5, seed: 7 }), sampleCells(cells, { sample: 0.5, seed: 7 }));
  assert.equal(sampleCells(cells, { sample: 0.5, seed: 7, all: true }).length, 10);
  assert.equal(sampleCells(cells, { sample: 0, seed: 7 }).length, 0);
});

test('offline publication applies trusted verification and revalidates the artifact', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-federation-public-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cell = createCell(cellInput());
  writeCell(join(root, 'cells'), cell);
  const conflictsPath = join(root, 'conflicts.json');
  writeFileSync(conflictsPath, JSON.stringify({ schemaVersion: 2, tools: [], slots: [], routes: [], verified: { tools: [], slots: [], routes: [] }, errors: [] }));
  const dir = join(root, 'public');
  await exportPublicArtifact({ cellsDir: join(root, 'cells'), conflictsPath, outDir: dir, runId: 'run-123', generatedAt: '2026-10-02T00:00:00.000Z', expectedCells: 1 });
  const reportPath = join(root, 'verification.json');
  writeFileSync(reportPath, JSON.stringify({ schemaVersion: 2, checked: 1, cells: [confirmedEntry(cell)], verifier: PROVENANCE }));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/matrix/verify-public.mjs', import.meta.url)), '--source', dir, '--verification', reportPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const updated = JSON.parse(readFileSync(cellFilePath(join(dir, 'cells'), cell), 'utf8'));
  assert.equal(updated.run.trust, 'verified');
  assert.equal(updated.run.verification.runId, PROVENANCE.runId);
});
