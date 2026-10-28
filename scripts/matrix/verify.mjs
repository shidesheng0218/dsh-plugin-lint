#!/usr/bin/env node
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runVerification } from '../../src/matrix/verify.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) {
  console.log('Usage: node scripts/matrix/verify.mjs [--cells dir] [--sample 0.2] [--seed 1] [--concurrency 2] [--all] [--unsafe-host] [--workflow name --run-id id --run-url url]');
  process.exit(0);
}
const argOf = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};

try {
  const out = argOf('--out', join(ROOT, 'matrix/index/verification.json'));
  const { report } = await runVerification({
    cellsDir: argOf('--cells', join(ROOT, 'matrix/cells')),
    cacheRoot: argOf('--cache', join(ROOT, '.matrix-cache')),
    sample: Number(argOf('--sample', '0.2')),
    seed: Number(argOf('--seed', '1')),
    all: argv.includes('--all'),
    concurrency: Number(argOf('--concurrency', '2')),
    backend: argv.includes('--unsafe-host') ? 'host-unsafe' : 'auto',
    workflow: argOf('--workflow', 'local'),
    runId: argOf('--run-id', 'local'),
    runUrl: argOf('--run-url', ''),
    out,
  });
  console.log(`checked ${report.checked} | confirmed ${report.confirmed} | disputed ${report.disputed} | errors ${report.errors}`);
  console.log('report written to ' + out);
  process.exitCode = report.errors > 0 ? 2 : 0;
} catch (error) {
  console.error(`${error.code || 'VERIFICATION_FAILED'}: ${error.message}`);
  process.exitCode = 2;
}
