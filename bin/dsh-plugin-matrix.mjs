#!/usr/bin/env node
import { runMatrixCli, USAGE } from '../src/matrix/cli.js';

const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help') || argv.length === 0) {
  console.log(USAGE);
  process.exit(argv.length === 0 ? 2 : 0);
}

try {
  process.exitCode = await runMatrixCli(argv);
} catch (error) {
  console.error(`${error.code || 'MATRIX_DATA_FAILED'}: ${error.message}`);
  process.exitCode = 2;
}
