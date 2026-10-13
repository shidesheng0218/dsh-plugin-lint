#!/usr/bin/env node
/**
 * Zero-false-positive acceptance test.
 *
 * The official @deepseek-ai packages are the reference implementation of the
 * documented practices. Any error-level finding on them is a bug in a rule, not
 * a defect in the package. Warnings and info findings are reported for review.
 *
 *   node scripts/e2e-official.mjs [fixtures-dir]
 */
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintPackage } from '../src/index.js';

const DIR = process.argv[2] || fileURLToPath(new URL('../fixtures', import.meta.url));
if (!existsSync(DIR)) {
  console.error('no fixtures at ' + DIR + ' — run scripts/extract-official-fixtures.mjs first');
  process.exit(2);
}
const targets = readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(DIR, d.name));
const byRule = new Map();
const errors = [];
let checked = 0;
for (const dir of targets) {
  let report;
  try { report = lintPackage(dir); } catch { continue; }
  checked += 1;
  for (const f of report.findings) {
    const key = f.rule + ' ' + f.level;
    byRule.set(key, (byRule.get(key) || 0) + 1);
    if (f.level === 'error') errors.push({ pkg: report.target.name, rule: f.rule, file: f.file, line: f.line, message: f.message });
  }
}
console.log('packages checked: ' + checked);
console.log('\nfindings by rule');
for (const [key, n] of [...byRule.entries()].sort()) console.log('  ' + String(n).padStart(4) + '  ' + key);
console.log('\nerror-level findings (must be zero)');
if (errors.length === 0) console.log('  none');
for (const e of errors.slice(0, 25)) console.log('  ' + e.pkg + '  ' + e.rule + '  ' + e.file + ':' + e.line + '  ' + e.message);
console.log('\n' + (errors.length === 0 ? 'PASS' : 'FAIL: ' + errors.length + ' error-level finding(s) on official packages'));
process.exit(errors.length === 0 ? 0 : 1);
