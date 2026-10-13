#!/usr/bin/env node
/**
 * Re-verify self-reported cells.
 *
 *   node scripts/matrix/verify.mjs [--sample 0.2] [--seed 1] [--concurrency 2] [--all]
 *
 * Authors can submit a cell from their own CI. Those arrive as run.trust
 * 'self-reported' and are never presented as ours. This samples them, re-runs
 * the probe, and either promotes the cell to 'verified' or marks it 'disputed'
 * with the mismatch recorded — a disagreement is published, not hidden.
 *
 * Writes matrix/index/verification.json.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probePackage, resolveDsh, startStub } from '../lib/probe.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const cellsDir = argOf('--cells', join(ROOT, 'matrix/cells'));
const cacheRoot = argOf('--cache', join(ROOT, '.matrix-cache'));
const sample = Number(argOf('--sample', '0.2'));
const seed = Number(argOf('--seed', '1'));
const concurrency = Number(argOf('--concurrency', '2'));
const all = argv.includes('--all');

/** Deterministic sampling, so a report can be reproduced from its seed. */
function sampled(items) {
  if (all) return items;
  let state = seed;
  const next = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  return items.filter(() => next() < sample);
}

const cells = [];
for (const dir of existsSync(cellsDir) ? readdirSync(cellsDir) : []) {
  const abs = join(cellsDir, dir);
  if (!statSync(abs).isDirectory()) continue;
  for (const file of readdirSync(abs)) {
    if (!file.endsWith('.json')) continue;
    const path = join(abs, file);
    const cell = JSON.parse(readFileSync(path, 'utf8'));
    if (cell.run.trust !== 'verified') cells.push({ path, cell });
  }
}

if (cells.length === 0) {
  console.log('no self-reported cells to verify');
  mkdirSync(join(ROOT, 'matrix/index'), { recursive: true });
  writeFileSync(join(ROOT, 'matrix/index/verification.json'), JSON.stringify({ schemaVersion: 1, at: new Date().toISOString(), checked: 0, promoted: 0, disputed: 0, cells: [] }, null, 2) + '\n');
  process.exit(0);
}

const selected = sampled(cells);
console.log('self-reported cells: ' + cells.length + ' | sampled: ' + selected.length + ' (seed ' + seed + ')');

const dshCache = new Map();
const dshFor = async (version, kind) => {
  const key = kind === 'desktop' ? 'desktop' : version;
  if (!dshCache.has(key)) dshCache.set(key, await resolveDsh(kind === 'desktop' ? undefined : version, cacheRoot));
  return dshCache.get(key);
};

const report = { schemaVersion: 1, at: new Date().toISOString(), seed, checked: 0, promoted: 0, disputed: 0, cells: [] };
const queue = [...selected];
const worker = async () => {
  while (queue.length > 0) {
    const { path, cell } = queue.shift();
    const dsh = await dshFor(cell.dsh.version, cell.dsh.source);
    const mode = cell.result.composition || 'headless';
    const stub = mode === 'web' ? undefined : await startStub();
    let fresh;
    try {
      fresh = await probePackage({ target: cell.plugin.name, dsh, stub, tools: mode !== 'web', mode });
    } finally {
      if (stub) stub.server.close();
    }
    const same = fresh.status === cell.result.status;
    const entry = {
      plugin: cell.plugin.name,
      dsh: cell.dsh.version,
      composition: mode,
      reported: cell.result.status,
      observed: fresh.status,
      verdict: same ? 'confirmed' : 'disputed',
    };
    report.cells.push(entry);
    report.checked += 1;
    if (same) {
      report.promoted += 1;
      cell.run.trust = 'verified';
      cell.run.verifiedAt = new Date().toISOString();
      cell.run.verifiedBy = 'scripts/matrix/verify.mjs';
      if (fresh.tools) cell.result.tools = fresh.tools;
    } else {
      report.disputed += 1;
      cell.run.trust = 'disputed';
      cell.run.disputedAt = new Date().toISOString();
      cell.run.dispute = { reported: cell.result.status, observed: fresh.status };
    }
    writeFileSync(path, JSON.stringify(cell, null, 2) + '\n');
    console.log('  ' + (same ? 'confirmed' : 'DISPUTED ').padEnd(10) + cell.plugin.name + ' x ' + cell.dsh.version + ' [' + mode + ']  reported ' + cell.result.status + ', observed ' + fresh.status);
  }
};
await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));

mkdirSync(join(ROOT, 'matrix/index'), { recursive: true });
writeFileSync(join(ROOT, 'matrix/index/verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log('\nchecked ' + report.checked + ' | confirmed ' + report.promoted + ' | disputed ' + report.disputed);
console.log('report written to matrix/index/verification.json');
