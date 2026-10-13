#!/usr/bin/env node
/**
 * Turn matrix cells into a site and an aggregate index.
 *
 *   node scripts/matrix/site.mjs [--cells matrix/cells] [--out site] [--index matrix/index/latest.json]
 *
 * The aggregate is published as plain JSON on purpose: the ecosystem already
 * distributes its catalog that way (dsh-plugin-catalog ships plugins.json on npm
 * and the marketplace consumes it), so a panel or a market can read this without
 * depending on our HTML.
 *
 * Trust is carried per cell and never averaged: verified, self-reported, stale.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const cellsDir = argOf('--cells', join(ROOT, 'matrix/cells'));
const outDir = argOf('--out', join(ROOT, 'site'));
const indexPath = argOf('--index', join(ROOT, 'matrix/index/latest.json'));
const STALE_DAYS = Number(argOf('--stale-days', '30'));

function readCells() {
  const cells = [];
  if (!existsSync(cellsDir)) return cells;
  for (const plugin of readdirSync(cellsDir)) {
    const dir = join(cellsDir, plugin);
    let stat;
    try { stat = statSync(dir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      try { cells.push(JSON.parse(readFileSync(join(dir, file), 'utf8'))); } catch { /* skip malformed */ }
    }
  }
  return cells;
}

const cells = readCells();
if (cells.length === 0) {
  console.error('no cells under ' + cellsDir + ' — run scripts/matrix/run.mjs first');
  process.exit(2);
}

const dshVersions = [...new Set(cells.map((c) => c.dsh.version))].sort();
const plugins = [...new Set(cells.map((c) => c.plugin.name))].sort();
const ageDays = (iso) => (Date.now() - Date.parse(iso)) / 86400000;
const trustOf = (cell) => {
  if (cell.run.trust !== 'verified') return cell.run.trust;
  return ageDays(cell.run.at) > STALE_DAYS ? 'stale' : 'verified';
};

const index = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  dshVersions,
  plugins: plugins.map((name) => {
    const own = cells.filter((c) => c.plugin.name === name);
    const latest = own.slice().sort((a, b) => Date.parse(b.run.at) - Date.parse(a.run.at))[0];
    return {
      name,
      version: latest.plugin.version,
      integrity: latest.plugin.integrity,
      cells: own.map((c) => ({
        dsh: c.dsh.version,
        status: c.result.status,
        trust: trustOf(c),
        at: c.run.at,
        toolsAdded: c.result.tools?.added ?? [],
        systemPromptChars: c.result.systemPrompt?.chars,
        clientHalf: c.result.clientHalf,
        reproduce: c.reproduce.command,
      })),
    };
  }),
};

// A cell states facts about a named plugin, so the same policy as the M2 report
// applies: publish after notifying, never as a verdict.
const BADGE = {
  active: '#1a7f37',
  'inactive-error': '#cf222e',
  'rejected-by-host': '#cf222e',
  'awaiting-service': '#bf8700',
  'install-failed': '#8250df',
  'boot-failed': '#cf222e',
  'template-failed': '#57606a',
};
const LABEL = { 'awaiting-service': 'awaiting service' };
const rows = plugins.map((name) => {
  const own = cells.filter((c) => c.plugin.name === name);
  const tds = dshVersions.map((v) => {
    const cell = own.find((c) => c.dsh.version === v);
    if (!cell) return '<td class="none">—</td>';
    const color = BADGE[cell.result.status] || '#57606a';
    const added = cell.result.tools?.added ?? [];
    const tools = added.length ? '<div class="tools">+' + added.length + ' tools</div>' : '';
    const title = cell.result.rejection
      || (cell.result.entries ?? []).map((e) => e.id + ': ' + e.reason).join(' | ')
      || cell.result.status;
    const services = (cell.result.awaitedServices ?? []);
    const service = services.length ? '<div class="meta">needs ' + services.join(', ') + '</div>' : '';
    return '<td><span class="pill" style="background:' + color + '" title="' + title.replace(/"/g, '&quot;') + '">'
      + (LABEL[cell.result.status] || cell.result.status) + '</span>' + tools + service + '<div class="meta">' + trustOf(cell) + '</div></td>';
  }).join('');
  const v = own[0].plugin.version;
  return '<tr><th>' + name + '<div class="ver">' + v + '</div></th>' + tds + '</tr>';
}).join('\n');

const tally = {};
for (const c of cells) tally[c.result.status] = (tally[c.result.status] || 0) + 1;

const html = [
  '<!doctype html>',
  '<html lang="en"><head><meta charset="utf-8">',
  '<title>DSH plugin compatibility matrix</title>',
  '<style>',
  'body{font:14px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;margin:2rem;color:#1f2328}',
  'h1{font-size:1.4rem;margin:0 0 .25rem}',
  '.sub{color:#57606a;margin-bottom:1.5rem}',
  'table{border-collapse:collapse}',
  'th,td{border:1px solid #d0d7de;padding:.5rem .75rem;text-align:left;vertical-align:top}',
  'th{background:#f6f8fa;font-weight:600}',
  '.ver{color:#57606a;font-weight:400;font-size:.8rem}',
  '.pill{display:inline-block;color:#fff;border-radius:999px;padding:.1rem .5rem;font-size:.75rem}',
  '.tools{color:#1a7f37;font-size:.75rem;margin-top:.25rem}',
  '.meta{color:#8c959f;font-size:.7rem;margin-top:.2rem}',
  '.none{color:#d0d7de;text-align:center}',
  '.note{margin-top:1.5rem;color:#57606a;font-size:.8rem;max-width:60rem}',
  '</style></head><body>',
  '<h1>DSH plugin compatibility matrix</h1>',
  '<div class="sub">' + cells.length + ' cells · ' + plugins.length + ' plugins · ' + dshVersions.length + ' DSH versions · generated ' + index.generatedAt + '</div>',
  '<table><thead><tr><th>Plugin</th>' + dshVersions.map((v) => '<th>' + v + '</th>').join('') + '</tr></thead>',
  '<tbody>' + rows + '</tbody></table>',
  '<div class="note"><strong>Read "awaiting service" as untested, not as broken.</strong> These probes compose the <em>headless</em> profile, which does not provide web-surface services (webServer, connection) that the web app supplies. A plugin waiting for one of those was never given the chance to mount, so the cell names the service instead of judging the plugin.</div>',
  '<div class="note"><strong>Scope.</strong> Every cell boots a throwaway profile with this plugin installed and reads what the host reports. '
    + 'It covers the <strong>host half only</strong>: a client half is loaded by the web app in a browser and is not exercised here. '
    + 'A failure to mount is a warning in the host, not an error, so these results come from parsing the host output rather than from exit codes. '
    + 'Cells state detected facts about named packages; they are not a verdict and not a security judgement.</div>',
  '<div class="note"><strong>Statuses:</strong> ' + Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, n]) => k + ' ' + n).join(' · ') + '</div>',
  '</body></html>',
].join('\n');

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'index.html'), html);
mkdirSync(dirname(indexPath), { recursive: true });
writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
console.log('site written to ' + join(outDir, 'index.html'));
console.log('index written to ' + indexPath);
console.log('cells: ' + cells.length + ' | plugins: ' + plugins.length + ' | versions: ' + dshVersions.join(', '));
for (const [status, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log('  ' + String(n).padStart(3) + '  ' + status);
