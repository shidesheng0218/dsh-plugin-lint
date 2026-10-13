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
copyFileSync(from, to + '.tmp');
console.log('bundled ' + index.plugins.length + ' plugins x ' + index.dshVersions.length + ' DSH versions into ' + to);
