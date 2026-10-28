import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanConflicts } from '../src/matrix/conflicts.js';
import { createCell } from '../src/matrix/cell.js';
import { writeCell } from '../src/matrix/cells.js';
import { artifact123, cellInput, completedObservation } from './matrix-helpers.js';

function pluginCell(name, tools, composition = 'headless') {
  const observation = completedObservation();
  observation.result.tools = { added: tools };
  observation.result.composition = composition;
  return createCell(cellInput({ artifact: { ...artifact123(), name, installTarget: `${name}@1.2.3` }, observation, composition }));
}

function fakeMaterialize(t, sources) {
  const calls = [];
  const materialize = async (artifact) => {
    calls.push(artifact);
    const dir = mkdtempSync(join(tmpdir(), 'dsh-conflict-package-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: artifact.name, version: artifact.resolvedVersion, main: 'index.js' }));
    writeFileSync(join(dir, 'index.js'), sources[artifact.name] || 'export function apply() {}');
    mkdirSync(join(dir, 'client'), { recursive: true });
    writeFileSync(join(dir, 'client', 'index.js'), sources[artifact.name] || '');
    return dir;
  };
  materialize.calls = calls;
  materialize.latestCalls = 0;
  return materialize;
}

test('slot and route scans cover UI-only plugins with pinned artifacts and method semantics', async (t) => {
  const cells = [pluginCell('a', ['shared']), pluginCell('b', ['shared']), pluginCell('ui-only', [])];
  const materialize = fakeMaterialize(t, {
    a: "ctx.slots.register({ name: 'sidebar' }); connection.fetch.register({ path: '/api/x', methods: ['GET'] });",
    b: "ctx.slots.register({ name: 'sidebar' }); connection.fetch.register({ path: '/api/x', methods: ['POST'] });",
    'ui-only': "ctx.slots.register({ name: 'sidebar' }); connection.fetch.register({ path: '/api/x', methods: ['GET'] });",
  });
  const report = await scanConflicts({ cells, materialize });
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.pluginsScanned.includes('ui-only'), true);
  assert.equal(materialize.latestCalls, 0);
  assert.equal(materialize.calls.every((artifact) => artifact.resolvedVersion === '1.2.3' && artifact.integrity === 'sha512-abc'), true);
  assert.equal(report.tools.length, 1);
  assert.equal(report.slots.length, 1);
  assert.equal(report.routes.length, 1);
  assert.equal(report.routes[0].resource, 'GET /api/x');
  assert.equal(report.verified.tools.length, 0);
});

test('runtime conflict results stay separate from static candidates', async (t) => {
  const cells = [pluginCell('a', ['shared']), pluginCell('b', ['shared'])];
  const materialize = fakeMaterialize(t, {});
  const verifiedCalls = [];
  const report = await scanConflicts({
    cells,
    materialize,
    verify: true,
    verifyCombo: async (input) => {
      verifiedCalls.push(input);
      return { status: 'collision', trust: 'self-reported', entries: [] };
    },
  });
  assert.equal(report.tools.length, 1);
  assert.equal(report.verified.tools.length, 1);
  assert.equal(report.verified.tools[0].status, 'collision');
  assert.equal(verifiedCalls[0].artifacts.every((artifact) => artifact.resolvedVersion === '1.2.3'), true);
});

test('conflicts CLI writes an explicit output from local pinned artifacts', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-conflicts-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['a', 'b']) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.2.3', main: 'index.js' }));
    writeFileSync(join(dir, 'index.js'), "ctx.slots.register({ name: 'sidebar' });");
    const artifact = { ...artifact123(), name, installTarget: `${name}@1.2.3`, local: true, path: dir, integrity: undefined, sourceDigest: `local-${name}` };
    writeCell(join(root, 'cells'), createCell(cellInput({ artifact, observation: completedObservation() })));
  }
  const out = join(root, 'nested', 'conflicts.json');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/matrix/conflicts.mjs', import.meta.url)), '--cells', join(root, 'cells'), '--out', out], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.slots.length, 1);
});
