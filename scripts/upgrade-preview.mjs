#!/usr/bin/env node
/**
 * Upgrade preview: should this profile upgrade to a newer DSH?
 *
 *   node scripts/upgrade-preview.mjs <profile-dir> --to <version> [--index matrix/index/latest.json]
 *   node scripts/upgrade-preview.mjs <profile-dir>                 # to the newest version the index knows
 *
 * Reads the profile's installed bundles, joins them against the aggregate
 * matrix index, and reports what changes on the target DSH version. Read-only:
 * nothing is installed, nothing is written outside stdout.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const VALUE_FLAGS = ['--to', '--index'];
const positional = argv.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(argv[i - 1]));

if (positional.length === 0) {
  console.error('usage: node scripts/upgrade-preview.mjs <profile-dir> [--to <version>] [--index <path>]');
  process.exit(2);
}

const profileDir = positional[0];
const indexPath = argOf('--index', join(ROOT, 'matrix/index/latest.json'));

const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined);

const manifest = readJson(join(profileDir, 'package.json'));
if (!manifest) {
  console.error('not a profile directory (no package.json): ' + profileDir);
  process.exit(2);
}
const bundles = (manifest.dsh?.profile?.bundles ?? []).filter((n) => typeof n === 'string' && n !== '');

const index = readJson(indexPath);
if (!index) {
  console.error('no matrix index at ' + indexPath + ' — run scripts/matrix/site.mjs first');
  process.exit(2);
}

const versions = index.dshVersions ?? [];
const target = argOf('--to', versions[versions.length - 1]);
if (!target) {
  console.error('the index names no DSH versions');
  process.exit(2);
}
if (!versions.includes(target)) {
  console.error('the index has no cells for DSH ' + target + ' (it knows: ' + versions.join(', ') + ')');
  process.exit(2);
}

// The running version is not in the profile manifest; assume the oldest the
// index covers, which is the conservative reading (an upgrade is from an
// older version to a newer one).
const current = versions[0];

// Same ranking as the site generator: one cell per composition, and only the
// most favourable verdict is shown — "awaiting webServer" in headless and
// "active" in web are both true, and only together do they mean anything.
const RANK = { active: 0, 'awaiting-service': 1, 'rejected-by-host': 2, 'inactive-error': 3, 'boot-failed': 4, 'install-failed': 5 };
const best = (cells, version) => {
  const own = cells.filter((c) => c.dsh === version);
  return own.slice().sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9))[0];
};
const BAD = new Set(['rejected-by-host', 'inactive-error', 'boot-failed']);

const byName = new Map((index.plugins ?? []).map((p) => [p.name, p]));
const rows = [];
for (const name of bundles) {
  const known = byName.get(name);
  const row = {
    name,
    firstParty: name.startsWith('@deepseek-ai/'),
    known: known !== undefined,
    from: known ? best(known.cells, current) : undefined,
    to: known ? best(known.cells, target) : undefined,
  };
  row.change = !row.known ? 'unknown'
    : !row.from && !row.to ? 'unknown'
    : !row.to ? 'unknown'
    : row.to.status === row.from?.status ? 'same'
    : BAD.has(row.to.status) && !BAD.has(row.from?.status ?? '') ? 'worse'
    : !BAD.has(row.to.status) && BAD.has(row.from?.status ?? '') ? 'better'
    : 'changed';
  rows.push(row);
}

const community = rows.filter((r) => !r.firstParty);
const worse = community.filter((r) => r.change === 'worse');
const better = community.filter((r) => r.change === 'better');
const same = community.filter((r) => r.change === 'same');
const unknown = community.filter((r) => r.change === 'unknown');

const statusOf = (cell) => (cell ? cell.status : 'no data');
console.log('Upgrade preview: ' + current + ' -> ' + target);
console.log('Profile ' + profileDir + ' · ' + rows.length + ' installed (' + community.length + ' community, ' + (rows.length - community.length) + ' first-party) · matrix generated ' + (index.generatedAt || 'unknown'));
console.log('');
if (community.length === 0) {
  console.log('  No community plugins installed — nothing the matrix can say anything about.');
} else {
  console.log('  ' + worse.length + ' worse · ' + better.length + ' better · ' + same.length + ' unchanged · ' + unknown.length + ' not covered by the matrix');
  console.log('');
  for (const row of community) {
    const mark = row.change === 'worse' ? '✗' : row.change === 'better' ? '✓' : row.change === 'same' ? '=' : '?';
    console.log('  ' + mark + '  ' + row.name);
    console.log('      ' + current + ': ' + statusOf(row.from) + '   ->   ' + target + ': ' + statusOf(row.to));
  }
}
if (worse.length > 0) {
  console.log('');
  console.log(worse.length + ' plugin' + (worse.length === 1 ? '' : 's') + ' would get a worse verdict on ' + target + '. The cells state detected facts; verify before deciding.');
}
process.exit(0);
