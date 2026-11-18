import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildQueue, applyWriteVersions, formatWatch } from '../src/matrix/watch.js';
import { writeCell } from '../src/matrix/cells.js';
import { createCell } from '../src/matrix/cell.js';
import { cellInput, completedObservation } from './matrix-helpers.js';

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'watch-'));
}

function writeJson(root, rel, value) {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
  return path;
}

function cellAt(name, version, dsh) {
  const observation = { ...completedObservation(), loadedVersion: version, result: { ...completedObservation().result, composition: 'headless' } };
  return createCell(cellInput({
    artifact: { name, requestedVersion: version, resolvedVersion: version, integrity: 'sha512-x', local: false },
    dsh: { version: dsh, source: 'npm', composition: 'headless' },
    composition: 'headless',
    observation,
  }));
}

function packument(latest, extra = {}) {
  return {
    'dist-tags': { latest },
    time: { [latest]: '2026-11-15T00:00:00.000Z' },
    versions: { [latest]: { dist: { integrity: 'sha512-newintegrity' } } },
    ...extra,
  };
}

function fetchMap(map) {
  return async (url) => {
    for (const [needle, value] of Object.entries(map)) {
      if (url.includes(needle)) {
        if (value instanceof Error) throw value;
        return { ok: true, json: async () => value };
      }
    }
    throw new Error('unexpected url ' + url);
  };
}

// The DSH packument needle must match the encoded scoped URL %40deepseek-ai%2Fdsh.
const DSH = '%40deepseek-ai';

const VERSIONS_FILE = {
  $comment: 'pinned versions',
  versions: [
    { version: '0.2.0-rc.2', channel: 'mainline', note: 'ships' },
    { version: '0.2.1-alpha.2', channel: 'frontier', note: 'alpha' },
  ],
};

test('watch flags a dist-tag version absent from versions.json, channel mainline for latest', async () => {
  const root = makeRoot();
  const cellsDir = join(root, 'cells');
  const versionsPath = writeJson(root, 'versions.json', VERSIONS_FILE);
  const targetsPath = writeJson(root, 'targets.json', { targets: [] });
  const dshPackument = {
    'dist-tags': { latest: '0.2.2-rc.1', alpha: '0.2.2-alpha.3' },
    time: { '0.2.2-rc.1': '2026-11-10T00:00:00.000Z', '0.2.2-alpha.3': '2026-11-12T00:00:00.000Z' },
  };
  const queue = await buildQueue({
    versionsPath, targetsPath, cellsDir, dsh: '@deepseek-ai/dsh',
    fetchImpl: fetchMap({ [DSH]: dshPackument }),
  });
  const versions = queue.newDshVersions.map((v) => [v.version, v.channel]);
  assert.deepEqual(versions, [['0.2.2-rc.1', 'mainline'], ['0.2.2-alpha.3', 'frontier']]);
  assert.equal(queue.newDshVersions[0].publishedAt, '2026-11-10T00:00:00.000Z');
});

test('watch dedupes two tags pointing at the same version, latest wins channel', async () => {
  const root = makeRoot();
  const cellsDir = join(root, 'cells');
  const versionsPath = writeJson(root, 'versions.json', VERSIONS_FILE);
  const targetsPath = writeJson(root, 'targets.json', { targets: [] });
  const dshPackument = {
    'dist-tags': { latest: '0.2.2-rc.1', next: '0.2.2-rc.1' },
    time: { '0.2.2-rc.1': '2026-11-10T00:00:00.000Z' },
  };
  const queue = await buildQueue({
    versionsPath, targetsPath, cellsDir,
    fetchImpl: fetchMap({ [DSH]: dshPackument }),
  });
  assert.equal(queue.newDshVersions.length, 1);
  assert.equal(queue.newDshVersions[0].channel, 'mainline');
});

test('watch flags a stale plugin whose latest exceeds every covered resolvedVersion', async () => {
  const root = makeRoot();
  const cellsDir = join(root, 'cells');
  writeCell(cellsDir, cellAt('demo', '1.3.0', '0.2.0-rc.2'));
  const versionsPath = writeJson(root, 'versions.json', VERSIONS_FILE);
  const targetsPath = writeJson(root, 'targets.json', { targets: [{ name: 'demo', version: '1.3.0' }] });
  const queue = await buildQueue({
    versionsPath, targetsPath, cellsDir,
    fetchImpl: fetchMap({ [DSH]: { 'dist-tags': {}, time: {} }, '/demo': packument('1.4.0') }),
  });
  assert.deepEqual(queue.stalePlugins, [{ name: 'demo', latest: '1.4.0', covered: ['1.3.0'] }]);
  assert.deepEqual(queue.suggestedTargets, [{ name: 'demo', version: '1.4.0', integrity: 'sha512-newintegrity' }]);
});

test('watch keeps a fresh plugin out of stalePlugins', async () => {
  const root = makeRoot();
  const cellsDir = join(root, 'cells');
  writeCell(cellsDir, cellAt('demo', '1.4.0', '0.2.0-rc.2'));
  const versionsPath = writeJson(root, 'versions.json', VERSIONS_FILE);
  const targetsPath = writeJson(root, 'targets.json', { targets: [{ name: 'demo', version: '1.4.0' }] });
  const queue = await buildQueue({
    versionsPath, targetsPath, cellsDir,
    fetchImpl: fetchMap({ [DSH]: { 'dist-tags': {}, time: {} }, '/demo': packument('1.4.0') }),
  });
  assert.deepEqual(queue.stalePlugins, []);
  assert.deepEqual(queue.suggestedTargets, []);
});

test('watch records a per-target fetch failure and keeps going', async () => {
  const root = makeRoot();
  const cellsDir = join(root, 'cells');
  writeCell(cellsDir, cellAt('demo', '1.3.0', '0.2.0-rc.2'));
  const versionsPath = writeJson(root, 'versions.json', VERSIONS_FILE);
  const targetsPath = writeJson(root, 'targets.json', { targets: [{ name: 'demo' }, { name: 'broken' }] });
  const queue = await buildQueue({
    versionsPath, targetsPath, cellsDir,
    fetchImpl: fetchMap({ [DSH]: { 'dist-tags': {}, time: {} }, '/demo': packument('1.4.0'), '/broken': new Error('404') }),
  });
  assert.deepEqual(queue.errors, [{ name: 'broken', error: '404' }]);
  assert.deepEqual(queue.suggestedTargets, [{ name: 'demo', version: '1.4.0', integrity: 'sha512-newintegrity' }]);
});

test('applyWriteVersions appends without disturbing existing entries', () => {
  const root = makeRoot();
  const versionsPath = writeJson(root, 'versions.json', VERSIONS_FILE);
  const before = readFileSync(versionsPath, 'utf8');
  applyWriteVersions(versionsPath, [
    { version: '0.2.2-rc.1', channel: 'mainline', publishedAt: '2026-11-10T00:00:00.000Z' },
  ]);
  const after = JSON.parse(readFileSync(versionsPath, 'utf8'));
  assert.equal(after.$comment, 'pinned versions');
  assert.deepEqual(after.versions.slice(0, 2), VERSIONS_FILE.versions);
  assert.deepEqual(after.versions[2], { version: '0.2.2-rc.1', channel: 'mainline', note: '' });
  // existing entries byte-identical prefix (comment + first two entries unchanged in order)
  assert.ok(after.versions.length === 3);
  assert.notEqual(before, readFileSync(versionsPath, 'utf8'));
});

test('formatWatch renders queue summary', async () => {
  const root = makeRoot();
  const cellsDir = join(root, 'cells');
  const versionsPath = writeJson(root, 'versions.json', VERSIONS_FILE);
  const targetsPath = writeJson(root, 'targets.json', { targets: [] });
  const queue = await buildQueue({
    versionsPath, targetsPath, cellsDir,
    fetchImpl: fetchMap({ [DSH]: { 'dist-tags': { latest: '0.2.2-rc.1' }, time: {} } }),
  });
  const text = formatWatch(queue);
  assert.match(text, /0\.2\.2-rc\.1/);
  assert.match(text, /mainline/);
});
