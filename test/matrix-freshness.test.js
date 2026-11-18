import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeStatus, formatStatus } from '../src/matrix/freshness.js';
import { writeCell } from '../src/matrix/cells.js';
import { createCell } from '../src/matrix/cell.js';
import { cellInput, completedObservation } from './matrix-helpers.js';

const NOW = Date.parse('2026-11-18T00:00:00.000Z');

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'freshness-'));
}

function writeJson(root, rel, value) {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
  return path;
}

function cell({ name, version = '1.0.0', dsh, composition = 'headless', status = 'active', at = '2026-11-10T00:00:00.000Z', outcome = 'completed' }) {
  const observation = outcome === 'error'
    ? {
        outcome: 'error',
        durationMs: 5,
        error: { code: 'PROBE_FAILED', message: 'boom' },
        reproduce: { command: `node scripts/probe-boot.mjs ${name}@${version} --dsh ${dsh}` },
      }
    : {
        ...completedObservation(),
        loadedVersion: version,
        result: { ...completedObservation().result, status, composition },
      };
  return createCell(cellInput({
    artifact: { name, requestedVersion: version, resolvedVersion: version, integrity: 'sha512-x', local: false },
    dsh: { version: dsh, source: 'npm', composition },
    composition,
    observation,
    at,
  }));
}

test('status groups cells by dsh version with counts, age, stale, missingCompositions', async () => {
  const root = makeRoot();
  const cellsDir = join(root, 'cells');
  // 0.2.0-rc.2: one active headless + one rejected web; 0.2.1-alpha.2: one error headless
  writeCell(cellsDir, cell({ name: 'a', dsh: '0.2.0-rc.2', composition: 'headless', status: 'active', at: '2026-11-10T00:00:00.000Z' }));
  writeCell(cellsDir, cell({ name: 'a', dsh: '0.2.0-rc.2', composition: 'web', status: 'rejected-by-host', at: '2026-11-12T00:00:00.000Z' }));
  writeCell(cellsDir, cell({ name: 'b', dsh: '0.2.1-alpha.2', composition: 'headless', outcome: 'error', at: '2026-11-01T00:00:00.000Z' }));
  const versionsPath = writeJson(root, 'versions.json', {
    versions: [
      { version: '0.2.0-rc.2', channel: 'mainline', note: 'ships' },
      { version: '0.2.1-alpha.2', channel: 'frontier', note: 'alpha' },
    ],
  });
  const targetsPath = writeJson(root, 'targets.json', { targets: [{ name: 'a' }, { name: 'b' }, { name: 'ghost' }] });

  const report = await computeStatus({ cellsDir, targetsPath, versionsPath, now: NOW, staleDays: 14 });
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.cellsDir, cellsDir);
  const byVersion = Object.fromEntries(report.versions.map((v) => [v.version, v]));

  const rc = byVersion['0.2.0-rc.2'];
  assert.equal(rc.channel, 'mainline');
  assert.equal(rc.cells, 2);
  assert.equal(rc.active, 1);
  assert.equal(rc.rejected, 1);
  assert.equal(rc.errors, 0);
  assert.equal(rc.newestAt, '2026-11-12T00:00:00.000Z');
  assert.equal(rc.ageDays, 6);
  assert.equal(rc.stale, false);
  assert.deepEqual(rc.missingCompositions, []);

  const alpha = byVersion['0.2.1-alpha.2'];
  assert.equal(alpha.cells, 1);
  assert.equal(alpha.errors, 1);
  assert.equal(alpha.ageDays, 17);
  assert.equal(alpha.stale, true);
  assert.deepEqual(alpha.missingCompositions, ['web']);

  assert.equal(report.plugins.targets, 3);
  assert.equal(report.plugins.covered, 2);
  assert.deepEqual(report.plugins.missingTargets, ['ghost']);
  assert.equal(report.registry, null);
});

test('status marks untargetedCells (cells for plugins not in targets)', async () => {
  const root = makeRoot();
  const cellsDir = join(root, 'cells');
  writeCell(cellsDir, cell({ name: 'extra', dsh: '0.2.0-rc.2' }));
  const targetsPath = writeJson(root, 'targets.json', { targets: [{ name: 'a' }] });
  const report = await computeStatus({ cellsDir, targetsPath, now: NOW });
  assert.deepEqual(report.plugins.untargetedCells, ['extra']);
});

test('status --registry degrades to registry:null when fetch fails', async () => {
  const root = makeRoot();
  const cellsDir = join(root, 'cells');
  writeCell(cellsDir, cell({ name: 'a', dsh: '0.2.0-rc.2' }));
  const targetsPath = writeJson(root, 'targets.json', { targets: [] });
  const fetchImpl = async () => { throw new Error('offline'); };
  const report = await computeStatus({ cellsDir, targetsPath, registry: true, now: NOW, fetchImpl });
  assert.equal(report.registry, null);
});

test('status --registry maps dist-tags and reports drift for uncovered versions', async () => {
  const root = makeRoot();
  const cellsDir = join(root, 'cells');
  writeCell(cellsDir, cell({ name: 'a', dsh: '0.2.0-rc.2' }));
  const targetsPath = writeJson(root, 'targets.json', { targets: [] });
  const packument = { 'dist-tags': { latest: '0.2.2-rc.1', next: '0.2.2-rc.2', alpha: '0.2.2-alpha.3' } };
  const fetchImpl = async () => ({ ok: true, json: async () => packument });
  const report = await computeStatus({ cellsDir, targetsPath, registry: true, now: NOW, fetchImpl });
  assert.equal(report.registry.latest, '0.2.2-rc.1');
  assert.equal(report.registry.next, '0.2.2-rc.2');
  assert.equal(report.registry.alpha, '0.2.2-alpha.3');
  assert.ok(report.registry.drift.some((line) => line.includes('0.2.2-rc.1')));
});

test('formatStatus renders a table and drift warning', async () => {
  const root = makeRoot();
  const cellsDir = join(root, 'cells');
  writeCell(cellsDir, cell({ name: 'a', dsh: '0.2.0-rc.2' }));
  const targetsPath = writeJson(root, 'targets.json', { targets: [] });
  const report = await computeStatus({ cellsDir, targetsPath, now: NOW });
  const text = formatStatus(report);
  assert.match(text, /0\.2\.0-rc\.2/);
  assert.match(text, /active/);
});
