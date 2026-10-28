#!/usr/bin/env node
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportPublicArtifact } from '../src/matrix/export.js';
import { syncMatrix } from '../src/matrix/sync.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const USAGE = [
  'dsh-plugin-matrix — reproducible matrix data tools (experimental)',
  '',
  'Usage',
  '  dsh-plugin-matrix export --cells <dir> --conflicts <file> [--out matrix/public] [--run-id id] [--expected-cells n]',
  '  dsh-plugin-matrix sync --source <dir-or-https-url> --out <dir>',
  '',
  'Export validates and sanitizes local v2 evidence. Sync reads only bytes, verifies',
  'hashes and schemas, then atomically replaces the output. Neither command executes artifacts.',
].join('\n');

const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help') || argv.length === 0) {
  console.log(USAGE);
  process.exit(argv.length === 0 ? 2 : 0);
}
const [command, ...rest] = argv;
const argOf = (name, fallback) => {
  const index = rest.indexOf(name);
  return index >= 0 ? rest[index + 1] : fallback;
};

try {
  if (command === 'export') {
    const result = await exportPublicArtifact({
      cellsDir: argOf('--cells', join(ROOT, 'matrix/cells')),
      conflictsPath: argOf('--conflicts', join(ROOT, 'matrix/index/conflicts.json')),
      outDir: argOf('--out', join(ROOT, 'matrix/public')),
      runId: argOf('--run-id', 'local-matrix'),
      expectedCells: argOf('--expected-cells') === undefined ? undefined : Number(argOf('--expected-cells')),
    });
    console.log(`exported ${result.cells} cells and ${result.filesWritten} files`);
    process.exitCode = 0;
  } else if (command === 'sync') {
    const source = argOf('--source');
    const outDir = argOf('--out');
    if (!source || !outDir) {
      console.error('dsh-plugin-matrix: sync requires --source and --out');
      process.exit(2);
    }
    const result = await syncMatrix({ source, outDir });
    console.log(`synced ${result.filesWritten} files from ${source}`);
    process.exitCode = 0;
  } else {
    console.error(USAGE);
    process.exit(2);
  }
} catch (error) {
  console.error(`${error.code || 'MATRIX_DATA_FAILED'}: ${error.message}`);
  process.exitCode = 2;
}
