import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportPublicArtifact } from '../src/matrix/export.js';
import { createCell } from '../src/matrix/cell.js';
import { writeCell } from '../src/matrix/cells.js';
import { cellInput } from './matrix-helpers.js';
import { syncMatrix as cliSyncMatrix } from '../src/matrix/sync.js';
import { syncMatrix as panelSyncMatrix } from '../panel/host/matrix-sync.js';

/**
 * The panel is published as its own package, so it must not reach outside its
 * own directory. It used to import ../../src/matrix/sync.js, which resolved in
 * the checkout and failed at load time from npm.
 */
const PANEL_ROOT = fileURLToPath(new URL('../panel/', import.meta.url));

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(path);
  }
  return files;
}

test('every relative import in the panel stays inside the panel package', () => {
  const offenders = [];
  for (const file of walk(PANEL_ROOT)) {
    const source = readFileSync(file, 'utf8');
    const specifiers = [
      ...source.matchAll(/\bfrom\s*['"](\.[^'"]+)['"]/g),
      ...source.matchAll(/\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g),
    ].map((match) => match[1]);
    for (const specifier of specifiers) {
      const target = resolve(dirname(file), specifier);
      if (!target.startsWith(PANEL_ROOT)) {
        offenders.push(`${relative(PANEL_ROOT, file)} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'the packaged panel cannot resolve these imports');
});

test('the panel sync and the CLI sync write identical bytes for the same artifact', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-panel-parity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cellsDir = join(root, 'cells');
  writeCell(cellsDir, createCell(cellInput({ composition: 'headless' })));
  writeCell(cellsDir, createCell(cellInput({ composition: 'web' })));
  const conflictsPath = join(root, 'conflicts.json');
  writeFileSync(conflictsPath, JSON.stringify({ schemaVersion: 2, tools: [], slots: [], routes: [], verified: { tools: [], slots: [], routes: [] }, errors: [] }));
  const source = join(root, 'public');
  await exportPublicArtifact({ cellsDir, conflictsPath, outDir: source, runId: 'parity', generatedAt: '2026-10-02T00:00:00.000Z', expectedCells: 2 });

  const cliOut = join(root, 'cli');
  const panelOut = join(root, 'panel');
  await cliSyncMatrix({ source, outDir: cliOut });
  await panelSyncMatrix({ source, outDir: panelOut });

  const files = (dir) => {
    const out = [];
    const visit = (current) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const path = join(current, entry.name);
        if (entry.isDirectory()) visit(path);
        else out.push(relative(dir, path).replace(/\\/g, '/'));
      }
    };
    visit(dir);
    return out.sort();
  };
  assert.deepEqual(files(panelOut), files(cliOut));
  for (const file of files(cliOut)) {
    assert.deepEqual(readFileSync(join(panelOut, file)), readFileSync(join(cliOut, file)), `bytes differ for ${file}`);
  }
});

test('the panel sync refuses an artifact that omits the files the panel reads', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-panel-incomplete-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  mkdirSync(source, { recursive: true });
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 2, plugins: [] }));
  const { createHash } = await import('node:crypto');
  const sha = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(source, 'index.json'), bytes);
  writeFileSync(join(source, 'manifest.json'), JSON.stringify({
    schemaVersion: 2,
    artifacts: [{ path: 'index.json', bytes: bytes.length, sha256: sha }],
  }));
  await assert.rejects(
    panelSyncMatrix({ source, outDir: join(root, 'out') }),
    (error) => error.code === 'ARTIFACT_INCOMPLETE',
  );
});