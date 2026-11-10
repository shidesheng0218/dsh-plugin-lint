import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { exportPublicArtifact, verifyPublicArtifact } from '../src/matrix/export.js';
import { syncMatrix } from '../src/matrix/sync.js';
import { createCell } from '../src/matrix/cell.js';
import { writeCell } from '../src/matrix/cells.js';
import { cellInput, v1ActiveVerified } from './matrix-helpers.js';
import { sha256 } from '../src/shared/hash.js';

const CONFLICTS = { schemaVersion: 2, tools: [], slots: [], routes: [], verified: { tools: [], slots: [], routes: [] }, errors: [] };

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-export-errors-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function cellsDirWith(root, count = 2) {
  const cellsDir = join(root, 'cells');
  writeCell(cellsDir, createCell(cellInput({ composition: 'headless' })));
  if (count > 1) writeCell(cellsDir, createCell(cellInput({ composition: 'web' })));
  return cellsDir;
}

async function exported(t) {
  const root = workspace(t);
  const cellsDir = cellsDirWith(root);
  const conflictsPath = join(root, 'conflicts.json');
  writeFileSync(conflictsPath, JSON.stringify(CONFLICTS));
  const outDir = join(root, 'public');
  await exportPublicArtifact({ cellsDir, conflictsPath, outDir, runId: 'r', generatedAt: '2026-10-02T00:00:00.000Z', expectedCells: 2 });
  return { root, cellsDir, conflictsPath, outDir };
}

function filesUnder(dir) {
  const out = new Map();
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out.set(relative(dir, path).replace(/\\/g, '/'), readFileSync(path));
    }
  };
  walk(dir);
  return out;
}

const cpRecursive = (from, to) => cpSync(from, to, { recursive: true });

test('export rejects missing inputs and a legacy corpus', async (t) => {
  const root = workspace(t);
  const conflictsPath = join(root, 'conflicts.json');
  writeFileSync(conflictsPath, JSON.stringify(CONFLICTS));
  await assert.rejects(
    exportPublicArtifact({ cellsDir: join(root, 'absent'), conflictsPath, outDir: join(root, 'out'), runId: 'r' }),
    (error) => error.code === 'CELL_READ_FAILED' || error.code === 'EXPORT_INPUT_INVALID',
  );

  const legacyDir = join(root, 'legacy');
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, 'legacy.json'), JSON.stringify(v1ActiveVerified()));
  await assert.rejects(
    exportPublicArtifact({ cellsDir: legacyDir, conflictsPath, outDir: join(root, 'out'), runId: 'r' }),
    (error) => error.code === 'EXPORT_INPUT_INVALID',
  );
});

test('export enforces the expected cell count and the conflicts artifact', async (t) => {
  const root = workspace(t);
  const cellsDir = cellsDirWith(root);
  const conflictsPath = join(root, 'conflicts.json');
  writeFileSync(conflictsPath, JSON.stringify(CONFLICTS));
  await assert.rejects(
    exportPublicArtifact({ cellsDir, conflictsPath, outDir: join(root, 'out'), runId: 'r', expectedCells: 3 }),
    (error) => error.code === 'EXPORT_CELL_COUNT_MISMATCH',
  );
  await assert.rejects(
    exportPublicArtifact({ cellsDir, conflictsPath: join(root, 'absent.json'), outDir: join(root, 'out'), runId: 'r' }),
    (error) => error.code === 'EXPORT_INPUT_INVALID',
  );
  writeFileSync(join(root, 'bad-conflicts.json'), JSON.stringify({ schemaVersion: 1 }));
  await assert.rejects(
    exportPublicArtifact({ cellsDir, conflictsPath: join(root, 'bad-conflicts.json'), outDir: join(root, 'out'), runId: 'r' }),
    (error) => error.code === 'EXPORT_INPUT_INVALID',
  );
});

test('verifyPublicArtifact reports missing, undeclared and tampered artifacts', async (t) => {
  const { outDir, root } = await exported(t);

  const missing = join(root, 'missing');
  cpRecursive(outDir, missing);
  rmSync(join(missing, 'aggregate.json'));
  const missingResult = await verifyPublicArtifact({ dir: missing });
  assert.equal(missingResult.ok, false);
  assert.match(missingResult.errors.join(' '), /artifact is missing/);

  const undeclared = join(root, 'undeclared');
  cpRecursive(outDir, undeclared);
  writeFileSync(join(undeclared, 'extra.json'), '{}');
  const undeclaredResult = await verifyPublicArtifact({ dir: undeclared });
  assert.equal(undeclaredResult.ok, false);
  assert.match(undeclaredResult.errors.join(' '), /undeclared artifact/);

  const tampered = join(root, 'tampered');
  cpRecursive(outDir, tampered);
  writeFileSync(join(tampered, 'index', 'latest.json'), readFileSync(join(tampered, 'index', 'latest.json'), 'utf8') + '\n');
  const tamperedResult = await verifyPublicArtifact({ dir: tampered });
  assert.equal(tamperedResult.ok, false);
  assert.match(tamperedResult.errors.join(' '), /hash mismatch/);
});

test('verifyPublicArtifact detects an index that does not match the cells', async (t) => {
  const { outDir, root } = await exported(t);
  const dir = join(root, 'index-tampered');
  cpRecursive(outDir, dir);
  const indexPath = join(dir, 'index', 'latest.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  index.plugins = [];
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
  const manifestPath = join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const bytes = readFileSync(indexPath);
  const entry = manifest.artifacts.find((artifact) => artifact.path === 'index/latest.json');
  entry.bytes = bytes.length;
  entry.sha256 = sha256(bytes);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const result = await verifyPublicArtifact({ dir });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /index does not match/);
});

test('sync requires explicit endpoints and refuses a non-HTTPS remote', async () => {
  await assert.rejects(syncMatrix({ source: '', outDir: '/tmp/x' }), (error) => error.code === 'MATRIX_SOURCE_REQUIRED');
  await assert.rejects(syncMatrix({ source: '/tmp/source', outDir: '' }), (error) => error.code === 'MATRIX_OUTPUT_REQUIRED');
});

test('sync serves a valid remote artifact over HTTPS and rejects HTTP errors', async (t) => {
  const { outDir: source } = await exported(t);
  const files = filesUnder(source);
  const fetchImpl = async (url) => {
    const key = new URL(url).pathname.replace(/^\/public\//, '');
    const bytes = files.get(key);
    if (!bytes) return { ok: false, status: 404 };
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  };
  const root = workspace(t);
  const result = await syncMatrix({ source: 'https://example.test/public/', outDir: join(root, 'synced'), fetchImpl });
  assert.equal(result.filesWritten > 3, true);
  assert.equal(existsSync(join(root, 'synced', 'manifest.json')), true);

  await assert.rejects(
    syncMatrix({ source: 'https://example.test/public/', outDir: join(root, 'missing'), fetchImpl: async () => ({ ok: false, status: 503 }) }),
    (error) => error.code === 'MATRIX_SOURCE_UNAVAILABLE',
  );
});