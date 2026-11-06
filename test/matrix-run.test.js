import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMatrix } from '../src/matrix/run.js';
import { cellFilePath, readCells } from '../src/matrix/cells.js';
import { artifact123, completedObservation } from './matrix-helpers.js';

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-matrix-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { outDir: join(root, 'out'), cacheRoot: join(root, 'cache') };
}

function fakeServices({ observation = completedObservation(), resolveError } = {}) {
  const resolveArtifact = async (target) => {
    resolveArtifact.calls.push(target);
    if (resolveError) throw resolveError;
    const name = typeof target === 'string' ? target : target.name;
    return { ...artifact123(), name: name.startsWith('@') || !name.includes('/') ? name : 'demo' };
  };
  resolveArtifact.calls = [];
  const createProbeEnvironment = async () => {
    const environment = { isolation: 'docker', async destroy() { environment.destroyed = (environment.destroyed || 0) + 1; } };
    createProbeEnvironment.calls.push(environment);
    return environment;
  };
  createProbeEnvironment.calls = [];
  const probePackage = async ({ environment, composition }) => {
    probePackage.calls.push(environment);
    await environment.destroy();
    const value = typeof observation === 'function' ? observation() : observation;
    const copy = structuredClone(value);
    if (copy.result) copy.result.composition = composition;
    return copy;
  };
  probePackage.calls = [];
  const startStub = async () => {
    startStub.calls.push(1);
    return { seen: [], server: { close() {} } };
  };
  startStub.calls = [];
  return { resolveArtifact, createProbeEnvironment, probePackage, startStub };
}

function options(t, overrides = {}) {
  return {
    targets: [{ name: 'demo', version: '1.2.3', integrity: 'sha512-abc' }],
    targetMode: 'pinned',
    dshVersions: ['0.2.0-rc.2'],
    compositions: ['headless', 'web'],
    concurrency: 4,
    useTools: true,
    ...workspace(t),
    ...overrides,
  };
}

test('one target is resolved once before concurrent cells and cached by full key', async (t) => {
  const services = fakeServices();
  const result = await runMatrix(options(t, { services }));
  assert.equal(services.resolveArtifact.calls.length, 1);
  assert.equal(result.summary.completed, 2);
  assert.equal(result.summary.errors, 0);
  assert.equal(new Set(result.cells.map((cell) => cell.cacheKey)).size, 2);
  assert.equal(result.cells.every((cell) => cell.run.trust === 'self-reported'), true);
  assert.equal(result.cells.every((cell) => existsSync(cellFilePath(result.summary.outDir, cell))), true);
});

test('only a fully valid completed cache is reused; damaged cache is regenerated', async (t) => {
  const shared = workspace(t);
  const first = await runMatrix({ ...options(t), ...shared, services: fakeServices() });
  assert.equal(first.summary.cached, 0);
  const secondServices = fakeServices();
  const second = await runMatrix({ ...options(t), ...shared, services: secondServices });
  assert.equal(second.summary.cached, 2);
  assert.equal(secondServices.probePackage.calls.length, 0);
  const damaged = cellFilePath(shared.cacheRoot, second.cells[0]);
  writeFileSync(damaged, '{not-json');
  const reads = await readCells(shared.cacheRoot);
  assert.equal(reads.some((entry) => entry.ok === false), true);
  const thirdServices = fakeServices();
  const third = await runMatrix({ ...options(t), ...shared, services: thirdServices });
  assert.equal(third.summary.cached, 1);
  assert.equal(thirdServices.probePackage.calls.length, 1);
});

test('pinned requires the target pin while refresh-latest explicitly re-resolves and records it', async (t) => {
  const pinnedServices = fakeServices();
  await assert.rejects(
    runMatrix(options(t, { targets: [{ name: 'demo' }], services: pinnedServices })),
    (error) => error.code === 'ARTIFACT_SPEC_UNSUPPORTED',
  );
  assert.equal(pinnedServices.resolveArtifact.calls.length, 0);
  const services = fakeServices();
  const result = await runMatrix(options(t, {
    targets: [{ name: 'demo', version: '0.0.1', integrity: 'sha512-old' }],
    targetMode: 'refresh-latest',
    services,
  }));
  assert.equal(services.resolveArtifact.calls[0], 'demo');
  assert.equal(result.summary.targetMode, 'refresh-latest');
  assert.equal(result.summary.inputs[0].resolvedVersion, '1.2.3');
  const manifest = JSON.parse(readFileSync(result.summary.manifestPath, 'utf8'));
  assert.equal(manifest.targetMode, 'refresh-latest');
  assert.equal(manifest.inputs[0].resolvedVersion, '1.2.3');
});

test('infrastructure errors fail the run summary but negative plugin observations do not', async (t) => {
  const observations = [
    { outcome: 'error', error: { code: 'ARTIFACT_MISSING', message: 'missing' }, entries: [], durationMs: 1 },
    completedObservation(),
  ];
  const services = fakeServices({ observation: () => observations.shift() });
  const result = await runMatrix(options(t, { services }));
  assert.equal(result.summary.errors, 1);
  assert.equal(result.summary.completed, 1);
  assert.equal(result.summary.total, 2);
  assert.equal(result.cells.find((cell) => cell.run.outcome === 'error').run.error.code, 'ARTIFACT_MISSING');
  assert.equal(existsSync(cellFilePath(result.summary.cacheRoot, result.cells.find((cell) => cell.run.outcome === 'error'))), false);
});

test('a local artifact without registry integrity still writes a run manifest', async (t) => {
  const services = fakeServices();
  services.resolveArtifact = async () => ({
    ...artifact123(),
    local: true,
    integrity: undefined,
    sourceDigest: 'sha256-local',
  });
  const result = await runMatrix(options(t, {
    services,
    targets: [{ path: '../demo' }],
    targetMode: 'refresh-latest',
  }));
  assert.equal(result.summary.completed, 2);
  assert.equal(result.summary.errors, 0);
  assert.equal(existsSync(result.summary.manifestPath), true, 'the manifest is written for a local artifact');
});
