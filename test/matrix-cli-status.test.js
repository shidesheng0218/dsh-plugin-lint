import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeCell } from '../src/matrix/cells.js';
import { createCell } from '../src/matrix/cell.js';
import { cellInput, completedObservation } from './matrix-helpers.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MATRIX_BIN = join(ROOT, 'bin', 'dsh-plugin-matrix.mjs');
const LINT_BIN = join(ROOT, 'bin', 'dsh-plugin-lint.mjs');

function run(bin, args) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
}

function writeV2(dir, name, dsh, status = 'active') {
  const observation = { ...completedObservation(), loadedVersion: '1.0.0', result: { ...completedObservation().result, status, composition: 'headless' } };
  const cell = createCell(cellInput({
    artifact: { name, requestedVersion: '1.0.0', resolvedVersion: '1.0.0', integrity: 'sha512-x', local: false },
    dsh: { version: dsh, source: 'npm', composition: 'headless' },
    composition: 'headless',
    observation,
  }));
  writeCell(dir, cell);
}

test('dsh-plugin-matrix status prints a table and exits 0', () => {
  const cells = mkdtempSync(join(tmpdir(), 'cli-cells-'));
  writeV2(cells, 'demo', '0.2.0-rc.2');
  const r = run(MATRIX_BIN, ['status', '--cells', cells]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0\.2\.0-rc\.2/);
});

test('dsh-plugin-matrix diff of a dir against itself reports zero transitions', () => {
  const cells = mkdtempSync(join(tmpdir(), 'cli-cells-'));
  writeV2(cells, 'demo', '0.2.0-rc.2');
  const r = run(MATRIX_BIN, ['diff', cells, cells]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /status transitions: 0/);
});

test('dsh-plugin-matrix help lists the new subcommands', () => {
  const r = run(MATRIX_BIN, ['--help']);
  assert.match(r.stdout, /status/);
  assert.match(r.stdout, /watch/);
  assert.match(r.stdout, /diff/);
});

test('dsh-plugin-lint --candidate without --profile fails with exit 2', () => {
  const r = run(LINT_BIN, ['--candidate', '/tmp/x']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--candidate requires --profile/);
});

test('dsh-plugin-lint --profile --candidate runs and marks the candidate', () => {
  const profile = mkdtempSync(join(tmpdir(), 'cli-profile-'));
  mkdirSync(join(profile, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'p', private: true }));
  writeFileSync(join(profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.1' }));
  const cand = mkdtempSync(join(tmpdir(), 'cli-cand-'));
  writeFileSync(join(cand, 'package.json'), JSON.stringify({ name: 'cand', version: '1.0.0', main: 'index.js', peerDependencies: { '@deepseek-ai/dsh': '>=9.9.9' } }));
  writeFileSync(join(cand, 'index.js'), 'module.exports = {};\n');
  const r = run(LINT_BIN, ['--profile', profile, '--candidate', cand, '--format', 'json']);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  const entry = report.plugins.find((p) => p.name === 'cand');
  assert.equal(entry.candidate, true);
  assert.equal(entry.verdict, 'will-reject');
});
