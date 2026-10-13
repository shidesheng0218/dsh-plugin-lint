#!/usr/bin/env node
import { resolve } from 'node:path';
import { lintPackage, formatText, toSarif } from '../src/index.js';

const USAGE = [
  'dsh-plugin-lint — conformance checks for DeepSeek Harness plugins',
  '',
  'Usage',
  '  dsh-plugin-lint [dir ...] [options]',
  '',
  'Options',
  '  --json                 machine-readable report on stdout',
  '  --sarif                SARIF 2.1.0 report on stdout (for code scanning)',
  '  --dsh-version <ver>    check dsh.compatibility against this DSH version',
  '  --exit-code            exit 1 when any error-level finding is present',
  '  --no-color             disable ANSI colour',
  '  --quiet                print only the summary line',
  '  -h, --help             show this message',
  '',
  'Exit codes: 0 ok · 1 errors found (with --exit-code) · 2 run failed',
].join('\n');

function parseArgs(argv) {
  const options = { dirs: [], json: false, sarif: false, exitCode: false, color: process.stdout.isTTY === true, quiet: false, dshVersion: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else if (a === '--json') options.json = true;
    else if (a === '--sarif') options.sarif = true;
    else if (a === '--exit-code') options.exitCode = true;
    else if (a === '--no-color') options.color = false;
    else if (a === '--quiet') options.quiet = true;
    else if (a === '--dsh-version') { options.dshVersion = argv[++i]; if (!options.dshVersion) fail('--dsh-version needs a value'); }
    else if (a.startsWith('-')) fail('unknown option: ' + a);
    else options.dirs.push(a);
  }
  if (options.dirs.length === 0) options.dirs.push('.');
  if (process.env.NO_COLOR !== undefined) options.color = false;
  return options;
}

function fail(message) {
  console.error('dsh-plugin-lint: ' + message);
  process.exit(2);
}

const options = parseArgs(process.argv.slice(2));
const reports = [];
for (const dir of options.dirs) {
  try {
    reports.push(lintPackage(resolve(dir), { dshVersion: options.dshVersion }));
  } catch (error) {
    fail(error.message);
  }
}

if (options.json) {
  console.log(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2));
} else if (options.sarif) {
  console.log(JSON.stringify(toSarif(reports), null, 2));
} else {
  for (const report of reports) {
    console.log(options.quiet
      ? report.target.name + ': ' + report.summary.error + ' error · ' + report.summary.warn + ' warn · ' + report.summary.info + ' info'
      : formatText(report, { color: options.color }));
  }
}

if (options.exitCode && reports.some((r) => r.summary.error > 0)) process.exit(1);
