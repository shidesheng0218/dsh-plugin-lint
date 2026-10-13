#!/usr/bin/env node
/**
 * Turn a report into a notification list.
 *
 *   node scripts/build-contact-list.mjs reports/2026-10-13
 *
 * Project policy (ADR D-001): the report names published packages, so every
 * named maintainer is contacted before public release. This writes CONTACTS.md
 * with one block per package: who to reach, what was found, and the exact
 * command that reproduces it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/build-contact-list.mjs <report-dir>');
  process.exit(2);
}
const raw = JSON.parse(readFileSync(join(dir, 'raw.json'), 'utf8'));
// info-level findings (missing icon, missing compatibility range) are ecosystem-wide
// context, not something to raise with an individual maintainer. Only error and warn
// findings name a package.
const flagged = raw.results.filter((r) => r.version && r.findings.some((f) => f.level !== 'info'));

const BT = String.fromCharCode(96);
const code = (s) => BT + s + BT;
const L = [];
const p = (s) => L.push(s === undefined ? '' : s);

p('# Notification list');
p();
p('Generated ' + new Date().toISOString() + ' from ' + raw.provenance.tool.name + '@' + raw.provenance.tool.version + '.');
p();
p('Policy: name the package, state only what was detected, cite the source document, and contact the maintainer before public release. No scoring, no ranking, no advice.');
p();
p('Packages to notify (error or warn findings): **' + flagged.length + '** of ' + raw.results.filter((r) => r.version).length + ' linted.');
p();
p('Info-level findings (missing icon, missing compatibility range) are ecosystem-wide context and are not raised with individual maintainers.');
p();

for (const r of flagged) {
  let maintainers = [];
  let repo = '';
  try {
    const meta = await (await fetch('https://registry.npmjs.org/' + encodeURIComponent(r.name))).json();
    maintainers = (meta.maintainers || []).map((m) => m.name + ' <' + m.email + '>');
    repo = meta.repository?.url || '';
  } catch { /* contact details stay empty when the registry is unreachable */ }
  p('## ' + r.name + '@' + r.version);
  p();
  p('- downloads (catalog, monthly): ' + r.catalogDownloads);
  p('- maintainers: ' + (maintainers.length ? maintainers.join(', ') : 'not listed'));
  p('- repository: ' + (repo || 'not listed'));
  p('- findings: ' + r.summary.error + ' error, ' + r.summary.warn + ' warn, ' + r.summary.info + ' info');
  p();
  for (const f of r.findings.filter((x) => x.level !== 'info')) {
    p('  - **' + f.rule + '** (' + f.level + ') ' + f.title);
    p('    - where: ' + code(f.file + ':' + f.line));
    p('    - detected: ' + f.message);
    if (f.evidence) p('    - evidence: ' + code(f.evidence));
    p('    - source document: ' + f.doc);
  }
  p();
  p('  Reproduce: ' + code('npx dsh-plugin-lint .') + ' in the published package directory, or ' + code('node scripts/build-report.mjs --top ' + raw.provenance.selection.top) + ' for the whole run.');
  p();
}
writeFileSync(join(dir, 'CONTACTS.md'), L.join('\n'));
console.log('wrote ' + join(dir, 'CONTACTS.md') + ' (' + flagged.length + ' packages, ' + L.length + ' lines)');
