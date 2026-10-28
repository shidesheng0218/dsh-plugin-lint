import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCell } from '../src/matrix/cell.js';
import { writeCell } from '../src/matrix/cells.js';
import { artifact123, completedObservation } from './matrix-helpers.js';

const SCRIPT = fileURLToPath(new URL('../scripts/build-notification-pack.mjs', import.meta.url));

test('notification compares DSH changes only within the same composition', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-notification-pack-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const reportDir = join(root, 'report');
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, 'raw.json'), JSON.stringify({ results: [], provenance: { tool: { name: 'dsh-plugin-lint', version: '0.4.0' } } }));
  const cellsDir = join(root, 'cells');
  const artifact = { ...artifact123(), name: 'demo' };
  for (const [dshVersion, composition, status] of [
    ['0.2.0-rc.2', 'headless', 'active'],
    ['0.2.0-rc.2', 'web', 'active'],
    ['0.2.1-alpha.2', 'headless', 'rejected-by-host'],
    ['0.2.1-alpha.2', 'web', 'active'],
  ]) {
    const observation = completedObservation();
    observation.result.status = status;
    observation.result.composition = composition;
    writeCell(cellsDir, createCell({ artifact, dsh: { version: dshVersion, source: 'npm', composition }, observation, isolation: 'docker', host: { os: 'linux', node: 'v22' } }));
  }
  const outDir = join(root, 'notify');
  const script = `process.argv = ['node', 'build-notification-pack.mjs', '--report', ${JSON.stringify(reportDir)}, '--cells', ${JSON.stringify(cellsDir)}, '--out', ${JSON.stringify(outDir)}]; globalThis.fetch = async () => new Response(JSON.stringify({ maintainers: [] }), { status: 200 }); await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});`;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DSH_NOTIFICATION_REPORT: reportDir, DSH_NOTIFICATION_CELLS: cellsDir, DSH_NOTIFICATION_OUT: outDir },
  });
  const message = readFileSync(join(outDir, 'packages', 'demo.md'), 'utf8');
  assert.match(message, /headless composition/);
  assert.match(message, /rejected-by-host/);
  assert.doesNotMatch(message, /web composition/);
});
