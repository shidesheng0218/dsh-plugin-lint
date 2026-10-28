#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCells } from '../../src/matrix/cells.js';
import { createPinnedMaterializer, scanConflicts } from '../../src/matrix/conflicts.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) {
  console.log('Usage: node scripts/matrix/conflicts.mjs [--cells dir] [--cache dir] [--verify] [--limit 3] [--out file]');
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
  const materialize = createPinnedMaterializer({ cacheRoot: argOf('--cache', join(ROOT, '.matrix-cache')) });
  const report = await scanConflicts({ cells, materialize, verify: argv.includes('--verify'), limit: Number(argOf('--limit', '3')) });
  const out = argOf('--out', join(ROOT, 'matrix/index/conflicts.json'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(`cells read: ${cells.length} · plugins scanned: ${report.pluginsScanned.length}`);
  console.log(`candidates: ${report.tools.length} tools · ${report.slots.length} slots · ${report.routes.length} routes`);
  console.log('written to ' + out);
  process.exitCode = report.errors.length > 0 ? 2 : 0;
} catch (error) {
  console.error(`${error.code || 'CONFLICTS_FAILED'}: ${error.message}`);
  process.exitCode = 2;
}
