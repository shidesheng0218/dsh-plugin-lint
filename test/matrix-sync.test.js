import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportPublicArtifact, verifyPublicArtifact } from '../src/matrix/export.js';
import { syncMatrix } from '../src/matrix/sync.js';
import { createCell } from '../src/matrix/cell.js';
import { writeCell } from '../src/matrix/cells.js';
import { sha256 } from '../src/shared/hash.js';
import { cellInput } from './matrix-helpers.js';

async function publicFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-public-artifact-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cellsDir = join(root, 'input-cells');
  writeCell(cellsDir, createCell(cellInput({ composition: 'headless' })));
  writeCell(cellsDir, createCell(cellInput({ composition: 'web' })));
  const conflictsPath = join(root, 'conflicts.json');
  writeFileSync(conflictsPath, JSON.stringify({ schemaVersion: 2, tools: [], slots: [], routes: [], verified: { tools: [], slots: [], routes: [] }, errors: [] }));
  const dir = join(root, 'public');
  await exportPublicArtifact({ cellsDir, conflictsPath, outDir: dir, runId: 'test-run', generatedAt: '2026-10-02T00:00:00.000Z', expectedCells: 2 });
  return { root, dir };
}

test('export and sync verify hashes, counts, aggregate, and safe replacement', async (t) => {
  const fixture = await publicFixture(t);
  assert.deepEqual(await verifyPublicArtifact({ dir: fixture.dir }), { ok: true, errors: [] });
  const outDir = join(fixture.root, 'synced');
  const result = await syncMatrix({ source: fixture.dir, outDir });
  assert.equal(result.manifest.runId, 'test-run');
  assert.equal(result.manifest.cellCount, 2);
  assert.equal(result.filesWritten > 3, true);
  assert.equal(JSON.parse(readFileSync(join(outDir, 'aggregate.json'), 'utf8')).plugins, 1);
  assert.equal(existsSync(join(outDir, 'manifest.json')), true);
});

test('sync rejects a modified artifact and never escapes the output directory', async (t) => {
  const fixture = await publicFixture(t);
  writeFileSync(join(fixture.dir, 'index', 'latest.json'), readFileSync(join(fixture.dir, 'index', 'latest.json'), 'utf8') + '\n');
  const outDir = join(fixture.root, 'synced');
  await assert.rejects(syncMatrix({ source: fixture.dir, outDir }), (error) => error.code === 'ARTIFACT_INTEGRITY_MISMATCH');
  assert.equal(existsSync(join(fixture.root, 'escape.json')), false);
  assert.equal(existsSync(outDir), false);
});

test('a manifest path escape is rejected before any write', async (t) => {
  const fixture = await publicFixture(t);
  const manifestPath = join(fixture.dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.artifacts.push({ path: '../escape.json', bytes: 1, sha256: 'a'.repeat(64) });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const outDir = join(fixture.root, 'synced');
  await assert.rejects(syncMatrix({ source: fixture.dir, outDir }));
  assert.equal(existsSync(join(fixture.root, 'escape.json')), false);
  assert.equal(existsSync(outDir), false);
});

test('aggregate tampering is detected even when its manifest hash is updated', async (t) => {
  const fixture = await publicFixture(t);
  const aggregatePath = join(fixture.dir, 'aggregate.json');
  const aggregate = JSON.parse(readFileSync(aggregatePath, 'utf8'));
  aggregate.plugins = 50;
  writeFileSync(aggregatePath, JSON.stringify(aggregate, null, 2) + '\n');
  const manifestPath = join(fixture.dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const bytes = readFileSync(aggregatePath);
  const entry = manifest.artifacts.find((artifact) => artifact.path === 'aggregate.json');
  entry.bytes = bytes.length;
  entry.sha256 = sha256(bytes);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const verification = await verifyPublicArtifact({ dir: fixture.dir });
  assert.equal(verification.ok, false);
  assert.equal(verification.errors.some((error) => /aggregate/i.test(error)), true);
});
