#!/usr/bin/env node
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintPackage } from '../src/index.js';

function fail(message) {
  console.error('official baseline: ' + message);
  process.exit(2);
}

const args = process.argv.slice(2);
let dir;
let expected;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--expect') {
    const value = args[++index];
    if (!/^\d+$/.test(value || '')) fail('--expect needs a non-negative integer');
    expected = Number(value);
  } else if (arg.startsWith('-')) {
    fail('unknown option: ' + arg);
  } else if (dir === undefined) {
    dir = arg;
  } else {
    fail('unexpected argument: ' + arg);
  }
}

const DIR = dir || fileURLToPath(new URL('../fixtures', import.meta.url));
if (!existsSync(DIR)) fail('no fixtures at ' + DIR + ' — run scripts/extract-official-fixtures.mjs first');
const targets = readdirSync(DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(DIR, entry.name));
if (targets.length === 0) fail('no packages found; refusing a 0-package PASS');

const byRule = new Map();
const errors = [];
const loadErrors = [];
let checked = 0;
for (const target of targets) {
  let report;
  try {
    report = lintPackage(target);
  } catch (error) {
    loadErrors.push({ target, message: error.message });
    continue;
  }
  checked += 1;
  for (const finding of report.findings) {
    const key = finding.rule + ' ' + finding.level;
    byRule.set(key, (byRule.get(key) || 0) + 1);
    if (finding.level === 'error') errors.push({ pkg: report.target.name, rule: finding.rule, file: finding.file, line: finding.line, message: finding.message });
  }
}

console.log('packages checked: ' + checked);
for (const failure of loadErrors) console.error('failed to load ' + failure.target + ': ' + failure.message);
console.log('\nfindings by rule');
for (const [key, count] of [...byRule.entries()].sort()) console.log('  ' + String(count).padStart(4) + '  ' + key);
console.log('\nerror-level findings (must be zero)');
if (errors.length === 0) console.log('  none');
for (const error of errors.slice(0, 25)) console.log('  ' + error.pkg + '  ' + error.rule + '  ' + error.file + ':' + error.line + '  ' + error.message);

if (loadErrors.length > 0) fail(loadErrors.length + ' package(s) could not be loaded');
if (expected !== undefined && checked !== expected) fail('expected ' + expected + ' packages, checked ' + checked);
console.log('\n' + (errors.length === 0 ? 'PASS' : 'FAIL: ' + errors.length + ' error-level finding(s) on official packages'));
process.exit(errors.length === 0 ? 0 : 1);
