import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCell } from '../src/matrix/cell.js';
import { buildIndex } from '../src/matrix/index.js';
import { buildManifest } from '../src/matrix/manifest.js';
import { validateIndex, validateManifest } from '../src/matrix/schema.js';
import { cellInput } from './matrix-helpers.js';

test('Index v2 preserves multiple versions and composition-specific summaries', () => {
  const first = createCell(cellInput({ composition: 'headless' }));
  const second = createCell(cellInput({ composition: 'web' }));
  const newer = createCell(cellInput({
    artifact: { ...cellInput().artifact, resolvedVersion: '1.2.4', installTarget: 'demo@1.2.4' },
    observation: { ...cellInput().observation, loadedVersion: '1.2.4' },
    composition: 'web',
  }));
  const index = buildIndex([first, second, newer], { generatedAt: '2026-10-02T00:00:00.000Z', source: { runId: 'run-1' } });
  assert.equal(index.schemaVersion, 2);
  assert.equal(index.plugins.length, 1);
  assert.deepEqual(index.plugins[0].versions.map((version) => version.version), ['1.2.3', '1.2.4']);
  assert.equal(index.plugins[0].versions[0].cells.length, 2);
  assert.deepEqual(index.plugins[0].versions[0].cells.map((cell) => cell.composition), ['headless', 'web']);
  assert.equal(validateIndex(index).ok, true, JSON.stringify(validateIndex(index)));
});

test('buildIndex refuses infrastructure errors instead of shrinking the sample', () => {
  const errorCell = createCell(cellInput({
    observation: { outcome: 'error', error: { code: 'ARTIFACT_MISSING', message: 'missing' }, entries: [], durationMs: 1 },
  }));
  assert.throws(() => buildIndex([errorCell], { generatedAt: '2026-10-02T00:00:00.000Z', source: {} }), (error) => error.code === 'INDEX_INPUT_INVALID');
});

test('validateIndex rejects damaged version summaries', () => {
  const index = buildIndex([createCell(cellInput())], { generatedAt: '2026-10-02T00:00:00.000Z', source: {} });
  index.plugins[0].versions[0].cells[0].cacheKey = 'broken';
  assert.equal(validateIndex(index).ok, false);
});

test('manifest binds inputs and artifact hashes with safe relative paths', () => {
  const manifest = buildManifest({
    runId: 'local-acceptance',
    generatedAt: '2026-10-02T00:00:00.000Z',
    probeVersion: '0.4.0',
    inputs: { targets: ['demo@1.2.3'], compositions: ['headless', 'web'] },
    artifacts: [{ path: 'index/latest.json', bytes: 123, sha256: 'a'.repeat(64) }],
  });
  assert.equal(manifest.schemaVersion, 2);
  assert.match(manifest.inputsSha256, /^[0-9a-f]{64}$/);
  assert.equal(validateManifest(manifest).ok, true);
  manifest.artifacts[0].path = '../escape.json';
  assert.equal(validateManifest(manifest).ok, false);
});
