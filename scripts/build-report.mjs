#!/usr/bin/env node
/**
 * Build the reproducible coupling-and-declaration report.
 *
 *   node scripts/build-report.mjs --top 100 [--out reports/YYYY-MM-DD] [--concurrency 4]
 *
 * Selection: the community plugin catalog (dsh-plugin-catalog on npm), entries
 * that publish to npm, first-party @deepseek-ai/* excluded, ranked by monthly
 * downloads. Each artifact is pinned by the registry dist.integrity value, so a
 * third party can reproduce the run byte-for-byte.
 *
 * Outputs: raw.json, packages.json, REPORT.md, plus a summary on stdout.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintPackage } from '../src/index.js';

const BT = String.fromCharCode(96);
const code = (s) => BT + s + BT;
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const TOP = Number(argOf('--top', '100'));
const CONCURRENCY = Number(argOf('--concurrency', '8'));
const OUT = argOf('--out', fileURLToPath(new URL('../reports/' + new Date().toISOString().slice(0, 10), import.meta.url)));
const TOOL = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));

const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
const { writeFileSync: writeBin } = await import('node:fs');
async function download(url, dest) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('download failed ' + response.status + ' for ' + url);
  writeBin(dest, Buffer.from(await response.arrayBuffer()));
}
const commit = (() => { try { return sh('git', ['rev-parse', 'HEAD']).toString().trim(); } catch { return 'unknown'; } })();

// ------------------------------------------------------------------ catalog
const work = mkdtempSync(join(tmpdir(), 'dsh-lint-report-'));
const catalogDir = join(work, 'catalog');
mkdirSync(catalogDir, { recursive: true });
process.stderr.write('fetching catalog...\n');
const catalogMetaDoc = await (await fetch('https://registry.npmjs.org/dsh-plugin-catalog', { headers: { accept: 'application/vnd.npm.install-v1+json' } })).json();
const catalogVersion = catalogMetaDoc['dist-tags'].latest;
const catalogTgzPath = join(catalogDir, 'catalog.tgz');
await download(catalogMetaDoc.versions[catalogVersion].dist.tarball, catalogTgzPath);
sh('tar', ['xf', catalogTgzPath, '-C', catalogDir]);
void catalogVersion;
const catalogMeta = JSON.parse(readFileSync(join(catalogDir, 'package/package.json'), 'utf8'));
const catalog = JSON.parse(readFileSync(join(catalogDir, 'package/plugins.json'), 'utf8'));

const selected = catalog.plugins
  .filter((p) => p.npm && !/^@deepseek-ai\//.test(p.npm))
  .sort((a, b) => (b.downloads || 0) - (a.downloads || 0))
  .slice(0, TOP);
process.stderr.write('selected ' + selected.length + ' packages\n');

// --------------------------------------------------------------------- lint
async function one(entry) {
  const dir = join(work, entry.npm.replace(/[^a-z0-9.-]/gi, '_'));
  mkdirSync(dir, { recursive: true });
  try {
    const meta = await (await fetch('https://registry.npmjs.org/' + encodeURIComponent(entry.npm), { headers: { accept: 'application/vnd.npm.install-v1+json' } })).json();
    const version = meta['dist-tags'] && meta['dist-tags'].latest;
    const dist = version && meta.versions && meta.versions[version] && meta.versions[version].dist;
    if (!dist || !dist.tarball) throw new Error('no published tarball for ' + entry.npm);
    const tgzPath = join(dir, 'package.tgz');
    await download(dist.tarball, tgzPath);
    sh('tar', ['xf', tgzPath, '-C', dir]);
    const report = lintPackage(join(dir, 'package'));
    const integrity = dist.integrity;
    return {
      name: report.target.name,
      version: report.target.version,
      integrity,
      catalogDownloads: entry.downloads || 0,
      catalogStars: entry.stars || 0,
      catalogCategory: entry.category,
      summary: report.summary,
      findings: report.findings,
      declaredDsh: report.dsh.declared,
    };
  } catch (error) {
    return { name: entry.npm, version: null, error: String(error.message).split('\n')[0].slice(0, 160) };
  }
}

const results = [];
for (let i = 0; i < selected.length; i += CONCURRENCY) {
  results.push(...await Promise.all(selected.slice(i, i + CONCURRENCY).map(one)));
  process.stderr.write('  ' + Math.min(i + CONCURRENCY, selected.length) + '/' + selected.length + '\r');
}
process.stderr.write('\n');

const ok = results.filter((r) => r.version);
const skipped = results.filter((r) => r.error);
const byRule = new Map();
for (const r of ok) for (const f of r.findings) byRule.set(f.rule + ' ' + f.level, (byRule.get(f.rule + ' ' + f.level) || 0) + 1);

const withW1 = ok.filter((r) => r.findings.some((f) => f.rule === 'W1'));
const withCompat = ok.filter((r) => r.declaredDsh.length > 0);
const withIcon = ok.filter((r) => !r.findings.some((f) => f.rule === 'I2' && /icon/.test(f.message)));
const withErrors = ok.filter((r) => r.summary.error > 0);
const clientPkgs = new Map();
for (const r of withW1) for (const f of r.findings.filter((x) => x.rule === 'W1')) {
  for (const m of f.message.matchAll(/@deepseek-ai\/dsh-client[a-z0-9-]*/g)) clientPkgs.set(m[0], (clientPkgs.get(m[0]) || 0) + 1);
}
const pct = (n) => (ok.length === 0 ? '0%' : ((n / ok.length) * 100).toFixed(0) + '%');
const pinned = ok.filter((r) => r.integrity).length;

const provenance = {
  generatedAt: new Date().toISOString(),
  tool: { name: TOOL.name, version: TOOL.version, commit },
  catalog: { package: catalogMeta.name, version: catalogMeta.version, sha: catalogMeta.catalogSha, snapshot: catalog.updated, entries: catalog.count },
  selection: { rule: 'catalog entries with an npm package, first-party @deepseek-ai/* excluded, ranked by monthly downloads', top: TOP, linted: ok.length, skipped: skipped.length, pinnedByIntegrity: pinned },
  dshReference: 'rules and the event-type catalog derive from an installed DSH 0.2.0-rc.2 (plugin-development reference + official packages)',
  reproducibility: 'npm pack <name>@<version> resolves to the dist.integrity pinned in packages.json; re-run scripts/build-report.mjs to regenerate',
};

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'raw.json'), JSON.stringify({ provenance, results }, null, 2));
writeFileSync(join(OUT, 'packages.json'), JSON.stringify(ok.map((r) => ({ name: r.name, version: r.version, integrity: r.integrity })), null, 2));

const L = [];
const p = (s) => L.push(s === undefined ? '' : s);
p('# DSH plugin ecosystem: coupling and declaration report');
p();
p('> **Status: draft.** This report names published packages. Project policy (ADR D-001) is to notify each named maintainer before public release. Treat this file as an unpublished draft until that has happened.');
p();
p('## What was measured');
p();
p('Every package below was downloaded from npm exactly as a user receives it, unpacked, and checked by ' + code('dsh-plugin-lint') + ' against rules derived from the DSH plugin-development reference. Nothing was executed.');
p();
p('| | |');
p('| --- | --- |');
p('| packages linted | **' + ok.length + '**' + (skipped.length ? ' (' + skipped.length + ' skipped: pack or extract failed)' : '') + ' |');
p('| artifacts pinned by integrity | ' + pinned + '/' + ok.length + ' |');
p('| selection | top ' + TOP + ' catalog entries published to npm, first-party excluded, by monthly downloads |');
p('| catalog snapshot | ' + code(provenance.catalog.version) + ' (' + provenance.catalog.snapshot + ', ' + provenance.catalog.entries + ' entries, sha ' + code(String(provenance.catalog.sha).slice(0, 12)) + ') |');
p('| tool | ' + code(TOOL.name + '@' + TOOL.version) + ' at ' + code(String(commit).slice(0, 8)) + ' |');
p('| generated | ' + provenance.generatedAt + ' |');
p('| reference | ' + provenance.dshReference + ' |');
p();
p('## Headline');
p();
p('| Finding | Packages | Share |');
p('| --- | --- | --- |');
p('| couple to a Harness Client package (W1) | ' + withW1.length + ' | **' + pct(withW1.length) + '** |');
p('| declare a DSH compatibility range (I1) | ' + withCompat.length + ' | ' + pct(withCompat.length) + ' |');
p('| declare no compatibility range | ' + (ok.length - withCompat.length) + ' | **' + pct(ok.length - withCompat.length) + '** |');
p('| declare a display icon | ' + withIcon.length + ' | ' + pct(withIcon.length) + ' |');
p('| trigger at least one error-level rule | ' + withErrors.length + ' | ' + pct(withErrors.length) + ' |');
p();
p('## Findings by rule');
p();
p('| Rule | Level | Findings | Packages |');
p('| --- | --- | --- | --- |');
for (const [key, n] of [...byRule.entries()].sort()) {
  const [rule, level] = key.split(' ');
  p('| ' + rule + ' | ' + level + ' | ' + n + ' | ' + ok.filter((r) => r.findings.some((f) => f.rule === rule && f.level === level)).length + ' |');
}
p();
if (clientPkgs.size) {
  p('### Which Harness Client packages the ecosystem loads');
  p();
  p('| Package | Plugins |');
  p('| --- | --- |');
  for (const [name, n] of [...clientPkgs.entries()].sort((a, b) => b[1] - a[1])) p('| ' + code(name) + ' | ' + n + ' |');
  p();
}
if (withCompat.length) {
  p('### Declared DSH versions');
  p();
  const versions = new Map();
  for (const r of withCompat) for (const v of r.declaredDsh) versions.set(v, (versions.get(v) || 0) + 1);
  p('| Declared version | Plugins |');
  p('| --- | --- |');
  for (const [v, n] of [...versions.entries()].sort((a, b) => b[1] - a[1])) p('| ' + code(v) + ' | ' + n + ' |');
  p();
}
if (withErrors.length) {
  p('### Error-level findings (facts only)');
  p();
  p('| Package | Rule | Location | Finding |');
  p('| --- | --- | --- | --- |');
  for (const r of withErrors) for (const f of r.findings.filter((x) => x.level === 'error')) {
    p('| ' + code(r.name + '@' + r.version) + ' | ' + f.rule + ' | ' + code(f.file + ':' + f.line) + ' | ' + f.message.replace(/\|/g, '\\|') + ' |');
  }
  p();
}
if (skipped.length) {
  p('### Skipped');
  p();
  for (const s of skipped) p('- ' + code(s.name) + ' - ' + s.error);
  p();
}
p('## Limitations');
p();
p('- Static analysis of files on disk. It reports what it detected and makes no security judgement.');
p('- Most packages publish bundled output, so a location points at the bundle, not at the original source.');
p('- W1 is a coupling indicator, not a defect: the official first-party client bundles load the same packages, which is why that rule exempts them.');
p('- Rule provenance is the DSH plugin-development reference as shipped in 0.2.0-rc.2; the installed Harness remains the authority.');
p();
p('## Reproduce');
p();
p(code('bash'));
p('node scripts/build-report.mjs --top ' + TOP);
p(code(''));
p();
p(code('packages.json') + ' pins every artifact by ' + code('dist.integrity') + ', so the same tarballs can be fetched byte-for-byte.');
p();
writeFileSync(join(OUT, 'REPORT.md'), L.join('\n'));

console.log('report written to ' + OUT);
console.log('  linted ' + ok.length + ', skipped ' + skipped.length + ', pinned ' + pinned);
console.log('  W1 coupling: ' + withW1.length + '/' + ok.length + ' (' + pct(withW1.length) + ')');
console.log('  compatibility declared: ' + withCompat.length + '/' + ok.length + ' (' + pct(withCompat.length) + ')');
console.log('  packages with errors: ' + withErrors.length);
rmSync(work, { recursive: true, force: true });
