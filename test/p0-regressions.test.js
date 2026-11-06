import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProbeEnvironment } from '../src/probe/environment.js';
import { createCell } from '../src/matrix/cell.js';
import { buildIndex } from '../src/matrix/index.js';
import { writeCell } from '../src/matrix/cells.js';
import { exportPublicArtifact } from '../src/matrix/export.js';
import { validateCell } from '../src/matrix/schema.js';
import { stableStringify } from '../src/shared/hash.js';
import { cellInput, completedObservation } from './matrix-helpers.js';

/**
 * Regressions for the defects the 2026-11-06 audit found in the 0.4.0 paths.
 * Each one was invisible to the module tests because they never crossed the
 * seam that was broken: backend wiring, the rejection branch, and the
 * index -> export -> verify chain for cells without tool evidence.
 */

const dsh = { kind: 'npm', node: 'node', cli: '/dsh/bin.js', extraArgs: [] };

test('the host-unsafe backend sets DSH_HOME to the profile dir, not the work dir', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-p0-host-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: '', stderr: '' };
  };
  const environment = await createProbeEnvironment({ backend: 'host-unsafe', workDir: root, runner, timeoutMs: 1000 });
  assert.equal(environment.isolation, 'host-unsafe');
  assert.notEqual(environment.profileDir, environment.workDir, 'the test only means something when the two differ');

  await environment.install({ dsh, target: '/tmp/plugin', profile: 'headless' });
  await environment.boot({ dsh, args: ['probe'], env: {} });

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.options.env.DSH_HOME, environment.profileDir);
  }
  await environment.destroy();
});

test('a host-rejected cell records no loaded version and still validates', () => {
  const observation = {
    outcome: 'completed',
    install: 'ok',
    durationMs: 12,
    result: {
      status: 'rejected-by-host',
      composition: 'headless',
      rejection: { reason: 'tool "collide_probe" is already registered' },
      entries: [],
      awaitedServices: [],
      clientHalf: 'not-covered',
    },
    note: 'rejected',
    outputSha256: 'a'.repeat(64),
    reproduce: { command: 'node scripts/probe-boot.mjs demo@1.2.3' },
  };

  const cell = createCell(cellInput({ observation }));
  assert.equal(cell.plugin.loadedVersion, undefined);
  assert.equal(cell.result.status, 'rejected-by-host');
  assert.equal(validateCell(cell).ok, true, JSON.stringify(validateCell(cell)));
  assert.doesNotThrow(() => buildIndex([cell], { generatedAt: '2026-10-02T00:00:00.000Z', source: {} }));
});

test('a cell without tool or system-prompt evidence still produces a hashable index', () => {
  const observation = completedObservation();
  delete observation.result.audit;
  delete observation.result.systemPrompt;
  delete observation.result.tools;

  const cell = createCell(cellInput({ observation, composition: 'web' }));
  const index = buildIndex([cell], { generatedAt: '2026-10-02T00:00:00.000Z', source: {} });
  const entry = index.plugins[0].versions[0].cells[0];
  assert.equal('audit' in entry, false);
  assert.equal('systemPromptChars' in entry, false);
  assert.doesNotThrow(() => stableStringify(index));
});

test('export and verify accept a web cell with no tool evidence', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-p0-export-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const observation = completedObservation();
  delete observation.result.audit;
  delete observation.result.systemPrompt;
  delete observation.result.tools;

  const cellsDir = join(root, 'cells');
  writeCell(cellsDir, createCell(cellInput({ observation, composition: 'web' })));
  const conflictsPath = join(root, 'conflicts.json');
  writeFileSync(conflictsPath, JSON.stringify({ schemaVersion: 2, tools: [], slots: [], routes: [], verified: { tools: [], slots: [], routes: [] }, errors: [] }));

  const result = await exportPublicArtifact({
    cellsDir,
    conflictsPath,
    outDir: join(root, 'public'),
    runId: 'p0-export',
    generatedAt: '2026-10-02T00:00:00.000Z',
    expectedCells: 1,
  });
  assert.equal(result.cells, 1);
  assert.equal(result.manifest.cellCount, 1);
});