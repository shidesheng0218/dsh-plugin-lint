#!/usr/bin/env node
/**
 * Lint published npm packages, as a user receives them.
 *
 *   node scripts/lint-npm-packages.mjs pkg-a pkg-b ...
 *   node scripts/lint-npm-packages.mjs --from-report reports/top.json
 *
 * Downloads each tarball with \`npm pack\`, extracts it, lints the extracted
 * package, and prints a per-rule summary plus every error-level finding.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintPackage } from '../src/index.js';

const names = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (names.length === 0) {
  console.error('usage: node scripts/lint-npm-packages.mjs <package> [package ...]');
  process.exit(2);
}
const work = mkdtempSync(join(tmpdir(), 'dsh-plugin-lint-npm-'));
const byRule = new Map();
const reports = [];
let failed = 0;

for (const name of names) {
  const dir = join(work, name.replace(/[^a-z0-9.-]/gi, '_'));
  mkdirSync(dir, { recursive: true });
  try {
    execFileSync('npm', ['pack', name, '--silent', '--pack-destination', dir], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120000 });
    execFileSync('tar', ['xzf', join(dir, readdirSync(dir).find((f) => f.endsWith('.tgz'))), '-C', dir], { stdio: 'ignore' });
    const report = lintPackage(join(dir, 'package'));
    reports.push(report);
    for (const f of report.findings) {
      const key = f.rule + ' ' + f.level;
      byRule.set(key, (byRule.get(key) || 0) + 1);
    }
    const s = report.summary;
    console.log(String(s.error).padStart(2) + 'E ' + String(s.warn).padStart(2) + 'W ' + String(s.info).padStart(2) + 'I  ' + report.target.name + '@' + report.target.version);
    for (const f of report.findings.filter((x) => x.level === 'error')) {
      console.log('        ' + f.rule + '  ' + f.file + ':' + f.line + '  ' + f.message);
    }
  } catch (error) {
    failed += 1;
    console.log('  --  ' + name + '  skipped: ' + String(error.message).split('\n')[0].slice(0, 90));
  }
}

console.log('\npackages linted: ' + reports.length + ' (' + failed + ' skipped)');
console.log('\nfindings by rule');
for (const [key, n] of [...byRule.entries()].sort()) console.log('  ' + String(n).padStart(4) + '  ' + key);
const errors = reports.reduce((a, r) => a + r.summary.error, 0);
const warns = reports.reduce((a, r) => a + r.summary.warn, 0);
console.log('\ntotals: ' + errors + ' error · ' + warns + ' warn across ' + reports.length + ' published plugins');
rmSync(work, { recursive: true, force: true });
