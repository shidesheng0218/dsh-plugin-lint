import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncMatrix } from '../panel/host/matrix-sync.js';

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-panel-sync-errors-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function sourceWith(t, manifest) {
  const root = workspace(t);
  const source = join(root, 'source');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'manifest.json'), JSON.stringify(manifest));
  return { root, source };
}

test('the panel sync requires explicit endpoints', async (t) => {
  const root = workspace(t);
  await assert.rejects(syncMatrix({ source: '', outDir: join(root, 'out') }), (error) => error.code === 'MATRIX_SOURCE_REQUIRED');
  await assert.rejects(syncMatrix({ source: root, outDir: '' }), (error) => error.code === 'MATRIX_OUTPUT_REQUIRED');
});

test('the panel sync rejects every malformed manifest', async (t) => {
  const cases = [
    null,
    [],
    { schemaVersion: 1, artifacts: [] },
    { schemaVersion: 2, artifacts: {} },
    { schemaVersion: 2, artifacts: [null] },
    { schemaVersion: 2, artifacts: [{ path: '../x', bytes: 1, sha256: 'a'.repeat(64) }] },
    { schemaVersion: 2, artifacts: [{ path: 'a.json', bytes: 1, sha256: 'a'.repeat(64) }, { path: 'a.json', bytes: 1, sha256: 'a'.repeat(64) }] },
    { schemaVersion: 2, artifacts: [{ path: 'a.json', bytes: -1, sha256: 'a'.repeat(64) }] },
    { schemaVersion: 2, artifacts: [{ path: 'a.json', bytes: 1, sha256: 'abc' }] },
  ];
  for (const manifest of cases) {
    const { root, source } = sourceWith(t, manifest);
    await assert.rejects(
      syncMatrix({ source, outDir: join(root, 'out') }),
      (error) => error.code === 'MANIFEST_INVALID',
      JSON.stringify(manifest),
    );
  }
});

test('the panel sync reports a missing remote as unavailable', async (t) => {
  const root = workspace(t);
  await assert.rejects(
    syncMatrix({
      source: 'https://example.test/public/',
      outDir: join(root, 'out'),
      fetchImpl: async () => ({ ok: false, status: 503 }),
    }),
    (error) => error.code === 'MATRIX_SOURCE_UNAVAILABLE',
  );
});

test('the panel sync refuses a required file with the wrong schema', async (t) => {
  const root = workspace(t);
  const source = join(root, 'source');
  mkdirSync(source, { recursive: true });
  const bytes = Buffer.from('{"schemaVersion":1}');
  const { createHash } = await import('node:crypto');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(source, 'manifest.json'), JSON.stringify({
    schemaVersion: 2,
    artifacts: [
      { path: 'index/latest.json', bytes: bytes.length, sha256 },
      { path: 'aggregate.json', bytes: bytes.length, sha256 },
    ],
  }));
  mkdirSync(join(source, 'index'), { recursive: true });
  writeFileSync(join(source, 'index/latest.json'), bytes);
  writeFileSync(join(source, 'aggregate.json'), bytes);
  await assert.rejects(
    syncMatrix({ source, outDir: join(root, 'out') }),
    (error) => error.code === 'ARTIFACT_INCOMPLETE',
  );
});