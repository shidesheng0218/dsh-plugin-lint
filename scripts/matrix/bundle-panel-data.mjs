#!/usr/bin/env node
/**
 * Snapshot the aggregate matrix index into the panel package.
 *
 *   node scripts/matrix/bundle-panel-data.mjs
 *
 * The panel ships a snapshot so its page works offline and can only show
 * verdicts we actually published. Re-run this whenever the matrix changes.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const from = join(ROOT, 'matrix/index/latest.json');
const to = join(ROOT, 'panel/data/matrix-index.json');
if (!existsSync(from)) {
  console.error('no aggregate index at ' + from + ' — run scripts/matrix/site.mjs first');
  process.exit(2);
}
mkdirSync(dirname(to), { recursive: true });
const index = JSON.parse(readFileSync(from, 'utf8'));
index.snapshot = { bundledAt: new Date().toISOString(), source: 'matrix/index/latest.json' };
writeFileSync(to, JSON.stringify(index, null, 2) + '\n');

// The aggregate is what ships in the npm package: counts per version, never a
// package name. The full index stays local — it names packages.
const aggregate = {
  schemaVersion: 1,
  generatedAt: index.generatedAt,
  dshVersions: index.dshVersions,
  plugins: index.plugins.length,
  versions: {},
};
for (const plugin of index.plugins) {
  for (const cell of plugin.cells ?? []) {
    if (!aggregate.versions[cell.dsh]) aggregate.versions[cell.dsh] = {};
    const tally = aggregate.versions[cell.dsh];
    tally[cell.status] = (tally[cell.status] || 0) + 1;
  }
}
writeFileSync(to.replace('matrix-index.json', 'aggregate.json'), JSON.stringify(aggregate, null, 2) + '\n');

copyFileSync(from, to + '.tmp');
console.log('bundled ' + index.plugins.length + ' plugins x ' + index.dshVersions.length + ' DSH versions into ' + to);
console.log('aggregate (no package names) written to ' + to.replace('matrix-index.json', 'aggregate.json'));
