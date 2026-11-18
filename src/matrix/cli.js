import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { exportPublicArtifact } from './export.js';
import { syncMatrix } from './sync.js';
import { runVerification } from './verify.js';
import { computeStatus, formatStatus } from './freshness.js';
import { buildQueue, formatWatch, applyWriteVersions } from './watch.js';
import { diffRuns, formatDiff } from './diff.js';

// cli.js lives in src/matrix/, so the repo root is two levels up.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const USAGE = [
  'dsh-plugin-matrix — reproducible matrix data tools (experimental)',
  '',
  'Usage',
  '  dsh-plugin-matrix status [--cells dir] [--targets file] [--versions file] [--registry] [--stale-days 14] [--json]',
  '  dsh-plugin-matrix watch [--versions file] [--targets file] [--top N] [--dsh <packument>] [--write-versions] [--out queue.json] [--json]',
  '  dsh-plugin-matrix diff <a> <b> [--json]',
  '  dsh-plugin-matrix export --cells <dir> --conflicts <file> [--out matrix/public] [--run-id id] [--expected-cells n]',
  '  dsh-plugin-matrix sync --source <dir-or-https-url> --out <dir>',
  '  dsh-plugin-matrix verify [--cells dir] [--sample 0.2] [--seed 1] [--all] [--out report.json]',
  '',
  'status reports coverage, data age, and registry drift. watch resolves new DSH/plugin',
  'releases into a refresh queue (it never runs the matrix). diff compares two runs.',
  'Export validates and sanitizes local v2 evidence. Sync reads only bytes, verifies',
  'hashes and schemas, then atomically replaces the output. Neither command executes artifacts.',
].join('\n');

const argOf = (rest, name, fallback) => {
  const index = rest.indexOf(name);
  return index >= 0 ? rest[index + 1] : fallback;
};

export async function runMatrixCli(argv) {
  const [command, ...rest] = argv;
  const json = rest.includes('--json');

  if (command === 'status') {
    const report = await computeStatus({
      cellsDir: argOf(rest, '--cells', join(ROOT, 'matrix/cells')),
      targetsPath: argOf(rest, '--targets', join(ROOT, 'matrix/targets.json')),
      versionsPath: argOf(rest, '--versions', join(ROOT, 'matrix/versions.json')),
      registry: rest.includes('--registry'),
      staleDays: Number(argOf(rest, '--stale-days', '14')),
    });
    console.log(json ? JSON.stringify(report, null, 2) : formatStatus(report));
    return 0;
  }

  if (command === 'watch') {
    const queue = await buildQueue({
      versionsPath: argOf(rest, '--versions', join(ROOT, 'matrix/versions.json')),
      targetsPath: argOf(rest, '--targets', join(ROOT, 'matrix/targets.json')),
      cellsDir: argOf(rest, '--cells', join(ROOT, 'matrix/cells')),
      dsh: argOf(rest, '--dsh', '@deepseek-ai/dsh'),
      top: argOf(rest, '--top') === undefined ? undefined : Number(argOf(rest, '--top')),
    });
    const out = argOf(rest, '--out');
    if (out) {
      mkdirSync(dirname(resolve(out)), { recursive: true });
      writeFileSync(out, JSON.stringify(queue, null, 2) + '\n');
      console.error('dsh-plugin-matrix: wrote ' + out);
    }
    if (rest.includes('--write-versions')) {
      const result = applyWriteVersions(argOf(rest, '--versions', join(ROOT, 'matrix/versions.json')), queue.newDshVersions);
      console.error(`dsh-plugin-matrix: appended ${result.added} version(s) to ${result.versionsPath}`);
    }
    if (!json && !out) console.log(formatWatch(queue));
    if (json) console.log(JSON.stringify(queue, null, 2));
    return 0;
  }

  if (command === 'diff') {
    const positional = rest.filter((a) => !a.startsWith('-'));
    if (positional.length !== 2) {
      console.error('dsh-plugin-matrix: diff requires two cell/run directories');
      return 2;
    }
    const report = diffRuns(positional[0], positional[1]);
    console.log(json ? JSON.stringify(report, null, 2) : formatDiff(report));
    return 0;
  }

  if (command === 'export') {
    const result = await exportPublicArtifact({
      cellsDir: argOf(rest, '--cells', join(ROOT, 'matrix/cells')),
      conflictsPath: argOf(rest, '--conflicts', join(ROOT, 'matrix/index/conflicts.json')),
      outDir: argOf(rest, '--out', join(ROOT, 'matrix/public')),
      runId: argOf(rest, '--run-id', 'local-matrix'),
      expectedCells: argOf(rest, '--expected-cells') === undefined ? undefined : Number(argOf(rest, '--expected-cells')),
    });
    console.log(`exported ${result.cells} cells and ${result.filesWritten} files`);
    return 0;
  }

  if (command === 'sync') {
    const source = argOf(rest, '--source');
    const outDir = argOf(rest, '--out');
    if (!source || !outDir) {
      console.error('dsh-plugin-matrix: sync requires --source and --out');
      return 2;
    }
    const result = await syncMatrix({ source, outDir });
    console.log(`synced ${result.filesWritten} files from ${source}`);
    return 0;
  }

  if (command === 'verify') {
    const out = argOf(rest, '--out', join(ROOT, 'matrix/index/verification.json'));
    const { report } = await runVerification({
      cellsDir: argOf(rest, '--cells', join(ROOT, 'matrix/cells')),
      cacheRoot: argOf(rest, '--cache', join(ROOT, '.matrix-cache')),
      sample: Number(argOf(rest, '--sample', '0.2')),
      seed: Number(argOf(rest, '--seed', '1')),
      all: rest.includes('--all'),
      concurrency: Number(argOf(rest, '--concurrency', '2')),
      backend: rest.includes('--unsafe-host') ? 'host-unsafe' : 'auto',
      workflow: argOf(rest, '--workflow', 'local'),
      runId: argOf(rest, '--run-id', 'local'),
      runUrl: argOf(rest, '--run-url', ''),
      out,
    });
    console.log(`checked ${report.checked} | confirmed ${report.confirmed} | disputed ${report.disputed} | errors ${report.errors}`);
    console.log('report written to ' + out);
    return report.errors > 0 ? 2 : 0;
  }

  console.error(USAGE);
  return 2;
}
