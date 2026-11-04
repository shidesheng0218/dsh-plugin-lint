import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportPublicArtifact } from '../src/matrix/export.js';
import { createCell } from '../src/matrix/cell.js';
import { writeCell } from '../src/matrix/cells.js';
import { cellInput } from './matrix-helpers.js';
import { refreshPublicMatrix, maybeRefreshInBackground, DEFAULT_MAX_AGE_MS } from '../panel/host/sync.js';

async function publicFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-panel-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cellsDir = join(root, 'input-cells');
  writeCell(cellsDir, createCell(cellInput({ composition: 'headless' })));
  writeCell(cellsDir, createCell(cellInput({ composition: 'web' })));
  const conflictsPath = join(root, 'conflicts.json');
  writeFileSync(conflictsPath, JSON.stringify({ schemaVersion: 2, tools: [], slots: [], routes: [], verified: { tools: [], slots: [], routes: [] }, errors: [] }));
  const source = join(root, 'public');
  await exportPublicArtifact({ cellsDir, conflictsPath, outDir: source, runId: 'panel-test', generatedAt: '2026-10-02T00:00:00.000Z', expectedCells: 2 });
  return { root, source };
}

test('refreshPublicMatrix syncs a verified artifact into the cache dir', async (t) => {
  const { root, source } = await publicFixture(t);
  const cacheDir = join(root, 'cache');
  const result = await refreshPublicMatrix({ cacheDir, source });
  assert.equal(result.ok, true);
  assert.equal(existsSync(join(cacheDir, 'index', 'latest.json')), true);
  assert.equal(existsSync(join(cacheDir, 'manifest.json')), true);
});

test('refreshPublicMatrix never throws on a sync failure', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-panel-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = await refreshPublicMatrix({ cacheDir: join(root, 'cache'), source: join(root, 'does-not-exist') });
  assert.equal(result.ok, false);
  assert.ok(result.reason);
});

test('refreshPublicMatrix reports no-cache-dir when no profile is available', async () => {
  const result = await refreshPublicMatrix({ cacheDir: undefined });
  assert.deepEqual(result, { ok: false, reason: 'no-cache-dir' });
});

test('maybeRefreshInBackground skips a fresh cache', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-panel-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cacheDir = join(root, 'cache');
  // Seed a just-generated manifest so the age check short-circuits.
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, 'manifest.json'), JSON.stringify({ generatedAt: new Date().toISOString() }));
  let fetched = false;
  const outcome = maybeRefreshInBackground({
    cacheDir,
    source: join(root, 'unused'),
    now: Date.now(),
    fetchImpl: async () => { fetched = true; throw new Error('must not be called'); },
  });
  assert.equal(outcome.started, false);
  assert.equal(outcome.reason, 'fresh');
  assert.equal(fetched, false);
});

test('maybeRefreshInBackground refreshes a stale or missing cache and reports via onDone', async (t) => {
  const { root, source } = await publicFixture(t);
  const cacheDir = join(root, 'cache');
  // A stale manifest (older than maxAgeMs) must trigger a refresh.
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, 'manifest.json'), JSON.stringify({ generatedAt: new Date(Date.now() - DEFAULT_MAX_AGE_MS - 1000).toISOString() }));
  let observed;
  const outcome = maybeRefreshInBackground({ cacheDir, source, onDone: (result) => { observed = result; } });
  assert.equal(outcome.started, true);
  await outcome.promise;
  assert.equal(observed.ok, true);
  assert.equal(existsSync(join(cacheDir, 'index', 'latest.json')), true);
});

test('maybeRefreshInBackground does not start when there is no cache dir', () => {
  const outcome = maybeRefreshInBackground({ cacheDir: undefined });
  assert.deepEqual(outcome, { started: false, reason: 'no-cache-dir' });
});
