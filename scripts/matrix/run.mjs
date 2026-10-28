#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { runMatrix } from '../../src/matrix/run.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) {
  console.log('Usage: node scripts/matrix/run.mjs [--targets file|--plugins a,b] [--dsh a,b] [--mode both|headless|web] [--target-mode pinned|refresh-latest] [--out dir] [--cache dir] [--concurrency 4] [--no-tools] [--force] [--unsafe-host]');
  process.exit(0);
}
const argOf = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const has = (name) => argv.includes(name);

try {
  const versionsFile = JSON.parse(readFileSync(join(ROOT, 'matrix/versions.json'), 'utf8'));
  const dshVersions = (argOf('--dsh', '') || '').split(',').filter(Boolean).length
    ? argOf('--dsh', '').split(',').filter(Boolean)
    : versionsFile.versions.map((version) => version.version);
  const targets = argOf('--plugins', '')
    ? argOf('--plugins', '').split(',').filter(Boolean).map((name) => ({ name }))
    : JSON.parse(readFileSync(argOf('--targets', join(ROOT, 'matrix/targets.json')), 'utf8')).targets;
  const modeArg = argOf('--mode', 'both').split(',').filter(Boolean);
  const compositions = modeArg.includes('both') ? ['headless', 'web'] : modeArg;
  const { summary } = await runMatrix({
    targets,
    targetMode: argOf('--target-mode', 'pinned'),
    dshVersions,
    compositions,
    outDir: argOf('--out', join(ROOT, 'matrix/cells')),
    cacheRoot: argOf('--cache', join(ROOT, '.matrix-cache')),
    concurrency: Number(argOf('--concurrency', '4')),
    force: has('--force'),
    keep: has('--keep'),
    useTools: !has('--no-tools'),
    backend: has('--unsafe-host') ? 'host-unsafe' : argOf('--backend', 'auto'),
    runId: argOf('--run-id', 'local-matrix'),
  });
  console.log(`cells: ${summary.total} (${summary.cached} cached, ${summary.invalidCache} invalid cache)`);
  for (const [status, count] of Object.entries(summary.statuses).sort((a, b) => b[1] - a[1])) console.log(`  ${count} ${status}`);
  console.log(`completed: ${summary.completed} · infrastructure errors: ${summary.errors}`);
  console.log('manifest written to ' + summary.manifestPath);
  process.exitCode = summary.errors > 0 ? 2 : 0;
} catch (error) {
  console.error(`${error.code || 'MATRIX_FAILED'}: ${error.code ? error.message : 'The matrix could not complete.'}`);
  process.exitCode = 2;
}
