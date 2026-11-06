#!/usr/bin/env node
/**
 * Example: comprehensive analysis of one plugin directory.
 *
 *   node examples/comprehensive-analysis.mjs <plugin-directory> [--json]
 *
 * The lint pass is a conformance check; the performance and security results
 * are experimental static heuristics (see the limits each result carries). With
 * --json the script prints one JSON document on stdout and nothing else.
 */

import { loadPackage, lintPackage } from '../src/index.js';
import {
  detectConflicts,
  analyzePerformance,
  analyzeSecurityDeep,
} from '../src/experimental/index.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const pluginPath = args.find((arg) => !arg.startsWith('--'));

if (!pluginPath) {
  console.error('usage: node examples/comprehensive-analysis.mjs <plugin-directory> [--json]');
  process.exit(2);
}

const pkg = loadPackage(pluginPath);
const lint = lintPackage(pluginPath);
const perf = analyzePerformance(pkg);
const security = analyzeSecurityDeep(pkg);
const conflicts = detectConflicts([pkg]);

const errorCount = lint.findings.filter((f) => f.level === 'error').length;
const warnCount = lint.findings.filter((f) => f.level === 'warn').length;
const securityScore = { minimal: 100, low: 85, medium: 70, high: 50 }[security.riskLevel] ?? 50;
const scores = {
  conformance: Math.max(0, 100 - errorCount * 10),
  performance: perf.score,
  security: securityScore,
};
const overallScore = Math.round(scores.conformance * 0.3 + scores.performance * 0.4 + scores.security * 0.3);

if (json) {
  console.log(JSON.stringify({
    plugin: { name: pkg.manifest.name, version: pkg.manifest.version, path: pluginPath },
    generatedAt: new Date().toISOString(),
    experimental: true,
    conformance: {
      checks: lint.checks,
      summary: lint.summary,
      findings: lint.findings,
    },
    performance: {
      score: perf.score,
      rating: perf.rating,
      bundleSize: perf.bundleSize,
      complexity: perf.complexity,
      network: { total: perf.networkCalls.total, domains: perf.networkCalls.externalDomains },
      recommendations: perf.recommendations,
      limits: perf.limits,
    },
    security: {
      riskLevel: security.riskLevel,
      summary: security.summary,
      findings: security.findings,
      limits: security.limits,
    },
    conflicts: {
      summary: conflicts.summary,
      slots: conflicts.slots,
      toolNames: conflicts.toolNames,
      limits: conflicts.limits,
    },
    heuristicOverallScore: overallScore,
    disclaimer: 'The overall score mixes a conformance check with experimental static heuristics; it is not a security or quality verdict.',
  }, null, 2));
  process.exit(0);
}

const line = (char = '=') => console.log(char.repeat(70));
const heading = (title) => { console.log('\n' + '='.repeat(70)); console.log(title); console.log('='.repeat(70) + '\n'); };

console.log('\nComprehensive plugin analysis (experimental sections are labelled)\n');
console.log('Plugin: ' + pkg.manifest.name + '@' + pkg.manifest.version + '  (' + pluginPath + ')');
console.log('Files: ' + pkg.jsFiles.length + ' JavaScript files on disk');

heading('1. Static conformance checks (stable)');
console.log('  checks: ' + lint.checks + ', findings: ' + lint.findings.length
  + ' (error ' + lint.summary.error + ', warn ' + lint.summary.warn + ', info ' + lint.summary.info + ')');
for (const finding of lint.findings.slice(0, 5)) {
  console.log('  [' + finding.level + '] ' + finding.rule + '  ' + finding.file + ':' + finding.line);
  console.log('    ' + finding.message);
}

heading('2. Performance (experimental; static heuristics, no runtime measurement)');
console.log('  score: ' + perf.score + '/100 (' + perf.rating + ')');
console.log('  bundle: ' + perf.bundleSize.totalMB + ' MB across ' + perf.bundleSize.fileCount + ' files');
console.log('  code: ' + perf.complexity.totalLines + ' lines, ' + perf.complexity.totalFunctions + ' functions, '
  + perf.complexity.longFunctions + ' long functions');
if (perf.networkCalls.total > 0) {
  console.log('  network calls: ' + perf.networkCalls.total + ' to ' + perf.networkCalls.externalDomains.join(', '));
}
for (const rec of perf.recommendations.slice(0, 3)) console.log('  - ' + rec.issue);
console.log('  limits:');
for (const limit of perf.limits) console.log('    - ' + limit);

heading('3. Security (experimental; findings are review hints, not a verdict)');
console.log('  risk level: ' + security.riskLevel + ' (heuristic summary)');
console.log('  findings: ' + security.summary.total + ' (warn ' + security.summary.warn + ', info ' + security.summary.info + ')');
for (const finding of security.findings.slice(0, 5)) {
  console.log('  [' + finding.rule + ' ' + finding.level + '] ' + finding.title + '  ' + finding.file + ':' + finding.line);
}
console.log('  limits:');
for (const limit of security.limits) console.log('    - ' + limit);

heading('4. Composition conflicts (experimental static scan)');
console.log('  conflicts with itself: ' + conflicts.summary.total
  + ' (pass two plugin directories to detect cross-plugin collisions)');
console.log('  authoritative runtime check: node scripts/matrix/conflicts.mjs');

heading('5. Heuristic summary');
console.log('  Conformance: ' + scores.conformance + '/100');
console.log('  Performance: ' + scores.performance + '/100 ' + (perf.rating === 'insufficient-data' ? '(insufficient data)' : ''));
console.log('  Security:    ' + scores.security + '/100 (from a heuristic risk level)');
console.log('  Overall:     ' + overallScore + '/100');
console.log('\n  This overall number mixes a conformance check with experimental heuristics.');
console.log('  Do not present it as a security or quality verdict.\n');
line();
console.log('Done. Use --json for a machine-readable report.');
console.log();
