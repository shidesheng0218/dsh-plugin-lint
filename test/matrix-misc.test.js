import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateCellV1, readCellAny } from '../src/matrix/migrate.js';
import { escapeHtml, renderSite } from '../src/matrix/site.js';
import { createCell, recommendationEligible, selectCells } from '../src/matrix/cell.js';
import { cacheKeyFor } from '../src/matrix/cache.js';
import { cellFilePath, readCells, writeCell } from '../src/matrix/cells.js';
import { cellInput, v1ActiveVerified } from './matrix-helpers.js';

function dir(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-matrix-misc-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('migrateCellV1 marks a legacy cell unpinned and ineligible', () => {
  const migrated = migrateCellV1(v1ActiveVerified());
  assert.equal(migrated.run.trust, 'legacy-unpinned');
  assert.equal(migrated.recommendationEligible, false);
  assert.equal(migrated.migration.originalTrust, 'verified');
  assert.equal(migrated.plugin.resolvedVersion, '1.0.0');
  assert.equal(migrated.dsh.composition, 'headless');
  assert.equal(migrated.probe.version, 'legacy');
  assert.equal(migrated.plugin.loadedVersion, undefined);
});

test('migrateCellV1 derives composition from the available legacy fields', () => {
  const base = v1ActiveVerified();
  const fromResult = migrateCellV1({ ...structuredClone(base), dsh: { version: '0.2.0' }, probe: {} , result: { status: 'active', composition: 'web' } });
  assert.equal(fromResult.dsh.composition, 'web');
  const fromProfile = migrateCellV1({ ...structuredClone(base), dsh: { version: '0.2.0', profile: 'headless' }, probe: {}, result: { status: 'active' } });
  assert.equal(fromProfile.dsh.composition, 'headless');
  const fromProbe = migrateCellV1({ ...structuredClone(base), dsh: { version: '0.2.0' }, probe: { mode: 'web' }, result: { status: 'active' } });
  assert.equal(fromProbe.dsh.composition, 'web');
});

test('migrateCellV1 and readCellAny fail closed on invalid input', () => {
  assert.throws(() => migrateCellV1({}), (error) => error.code === 'CELL_INVALID');
  assert.throws(() => readCellAny({ schemaVersion: 3 }), (error) => error.code === 'CELL_SCHEMA_UNSUPPORTED');
  assert.equal(readCellAny(v1ActiveVerified()).kind, 'legacy-v1');
  assert.equal(readCellAny(createCell(cellInput())).kind, 'v2');
  assert.throws(() => readCellAny({ ...createCell(cellInput()), schemaVersion: 2, cacheKey: 'bad' }), (error) => error.code === 'CELL_INVALID');
});

test('selectCells distinguishes exact, mixed, unknown and untested evidence', () => {
  const headless = createCell(cellInput({ composition: 'headless' }));
  const web = createCell(cellInput({ composition: 'web' }));
  assert.deepEqual(selectCells([headless], { dshVersion: '0.2.0-rc.2', composition: 'headless' }), { kind: 'cells', cells: [headless] });
  assert.deepEqual(selectCells([headless], { dshVersion: '0.2.0-rc.2', composition: 'web' }), { kind: 'untested', cells: [] });
  assert.equal(selectCells([headless, web], { dshVersion: '0.2.0-rc.2' }).kind, 'mixed');
  assert.equal(selectCells([headless], { dshVersion: '0.2.0-rc.2' }).kind, 'unknown');
  assert.deepEqual(selectCells([], {}), { kind: 'untested', cells: [] });
  assert.equal(selectCells([headless], { dshVersion: '9.9.9' }).kind, 'untested');
});

test('recommendationEligible requires verified, pinned, matching, recent evidence', () => {
  const cell = createCell(cellInput({
    trust: 'verified',
    verification: { workflow: 'w', runId: 'r', url: 'https://example.test/r', probeVersion: '0.4.0' },
    at: '2026-10-01T00:00:00.000Z',
  }));
  const now = Date.parse('2026-10-02T00:00:00.000Z');
  assert.equal(recommendationEligible(cell, { now }), true);
  assert.equal(recommendationEligible(cell, { now: Date.parse('2027-01-01T00:00:00.000Z') }), false, 'stale evidence');
  assert.equal(recommendationEligible({ ...cell, migration: {} }, { now }), false);
  assert.equal(recommendationEligible({ ...cell, plugin: { ...cell.plugin, local: true } }, { now }), false);
  assert.equal(recommendationEligible({ ...cell, run: { ...cell.run, trust: 'self-reported' } }, { now }), false);
  assert.equal(recommendationEligible({ ...cell, result: { ...cell.result, status: 'rejected-by-host' } }, { now }), false);
  assert.equal(recommendationEligible({ ...cell, run: { ...cell.run, verification: undefined } }, { now }), false);
});

test('renderSite escapes untrusted strings and keeps compositions separate', () => {
  const index = {
    generatedAt: '2026-10-01T00:00:00.000Z',
    dshVersions: ['0.2.0', '0.3.0'],
    plugins: [{
      name: '<script>alert(1)</script>',
      versions: [{
        version: '1.0.0',
        cells: [
          { dsh: '0.2.0', composition: 'headless', status: 'active', trust: 'verified', at: '2026-10-01T00:00:00.000Z', toolsAdded: ['a'], awaitedServices: [] },
          { dsh: '0.2.0', composition: 'web', status: 'awaiting-service', trust: 'self-reported', at: '2026-10-01T00:00:00.000Z', awaitedServices: ['webServer'], note: '<b>waiting</b>' },
        ],
      }],
    }],
    source: { runId: 'run-1' },
  };
  const html = renderSite(index);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert/);
  assert.match(html, /\+1 tools/);
  assert.match(html, /needs webServer/);
  assert.match(html, /&lt;b&gt;waiting&lt;\/b&gt;/);
  assert.match(html, /2 cells · 1 plugins · 2 DSH versions/);
  assert.match(html, /source run-1/);
  assert.match(html, /<span class="none">—<\/span>/);
});

test('renderSite handles an empty index and escapeHtml covers every entity', () => {
  const html = renderSite({ generatedAt: '2026-10-01T00:00:00.000Z' });
  assert.match(html, /0 cells · 0 plugins · 0 DSH versions/);
  assert.match(html, /source unknown/);
  assert.equal(escapeHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
});
test('cacheKeyFor rejects every incomplete identity input', () => {
  const artifact = { name: 'demo', resolvedVersion: '1.0.0', integrity: 'sha512-x' };
  const base = { artifact, dshVersion: '0.2.0', composition: 'headless', probeVersion: '0.4.0' };
  const cases = [
    { artifact: undefined },
    { artifact: { ...artifact, name: undefined } },
    { artifact: { ...artifact, resolvedVersion: undefined } },
    { artifact: { name: 'demo', resolvedVersion: '1.0.0' } },
    { dshVersion: undefined },
    { composition: undefined },
    { probeVersion: undefined },
  ];
  for (const override of cases) {
    assert.throws(() => cacheKeyFor({ ...base, ...override }), (error) => error.code === 'CACHE_INPUT_INVALID');
  }
  assert.equal(cacheKeyFor(base).length, 64);
  const local = cacheKeyFor({ ...base, artifact: { name: 'demo', resolvedVersion: '1.0.0', sourceDigest: 'sha256-y', local: true } });
  assert.equal(local.length, 64);
});

test('writeCell guards the schema and readCells reports damaged files', (t) => {
  const root = dir(t);
  assert.throws(() => writeCell(root, v1ActiveVerified()), (error) => error.code === 'CELL_SCHEMA_UNSUPPORTED');
  const invalid = { ...createCell(cellInput()), cacheKey: 'bad' };
  assert.throws(() => writeCell(root, invalid), (error) => error.code === 'CELL_INVALID');

  const cellsDir = join(root, 'cells');
  const cell = createCell(cellInput());
  const path = writeCell(cellsDir, cell);
  assert.match(path, /demo\/1\.2\.3\/0\.2\.0-rc\.2\+headless\.[0-9a-f]{16}\.json/);
  const scoped = { ...cell, plugin: { ...cell.plugin, name: '@scope/name', resolvedVersion: '1.0.0+build' } };
  assert.match(cellFilePath(root, scoped), /scope_name\/1\.0\.0_build\//);

  mkdirSync(join(cellsDir, 'nested'), { recursive: true });
  writeFileSync(join(cellsDir, 'nested', 'broken.json'), '{nope');
  writeFileSync(join(cellsDir, 'run-manifest.json'), JSON.stringify({ schemaVersion: 2 }));
  writeFileSync(join(cellsDir, 'note.txt'), 'ignored');
  const reads = readCells(cellsDir);
  assert.equal(reads.some((entry) => entry.kind === 'run-manifest'), true);
  assert.equal(reads.some((entry) => entry.ok === false), true);
  assert.equal(reads.some((entry) => entry.path.endsWith('note.txt')), false);
  assert.throws(() => readCells(join(root, 'absent')), (error) => error.code === 'CELL_READ_FAILED');
});
