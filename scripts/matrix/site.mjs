#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCells } from '../../src/matrix/cells.js';
import { buildIndex } from '../../src/matrix/index.js';
import { renderSite } from '../../src/matrix/site.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) {
  console.log('Usage: node scripts/matrix/site.mjs [--cells dir] [--out site] [--index matrix/index/latest.json]');
  process.exit(0);
}
const argOf = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};

try {
  const reads = readCells(argOf('--cells', join(ROOT, 'matrix/cells')));
  const damaged = reads.filter((entry) => !entry.ok);
  if (damaged.length > 0) throw new Error(`cannot read ${damaged.length} cell file(s), first: ${damaged[0].path}`);
  const cells = reads.filter((entry) => entry.kind === 'v2').map((entry) => entry.cell);
  if (cells.length === 0) throw new Error('no v2 cells found; run the matrix first');
  const conflictsPath = join(ROOT, 'matrix/index/conflicts.json');
  const conflicts = existsSync(conflictsPath) ? JSON.parse(readFileSync(conflictsPath, 'utf8')) : undefined;
  const index = buildIndex(cells, { source: { runId: argOf('--run-id', 'local-site'), conflicts } });
  const outDir = argOf('--out', join(ROOT, 'site'));
  const indexPath = argOf('--index', join(ROOT, 'matrix/index/latest.json'));
  mkdirSync(outDir, { recursive: true });
  mkdirSync(dirname(indexPath), { recursive: true });
  writeFileSync(join(outDir, 'index.html'), renderSite(index));
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
  console.log(`site written to ${join(outDir, 'index.html')} · cells: ${cells.length}`);
} catch (error) {
  console.error(`${error.code || 'SITE_FAILED'}: ${error.message}`);
  process.exitCode = 2;
}
