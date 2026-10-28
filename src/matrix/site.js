const COLORS = {
  active: '#1a7f37',
  'inactive-error': '#cf222e',
  'rejected-by-host': '#cf222e',
  'awaiting-service': '#bf8700',
  'install-failed': '#8250df',
  'boot-failed': '#cf222e',
  'template-failed': '#57606a',
};

export function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderCell(cell) {
  const status = escapeHtml(cell.status);
  const note = cell.note || cell.title;
  const title = escapeHtml(note || cell.status);
  const color = COLORS[cell.status] || '#57606a';
  const tools = cell.toolsAdded?.length ? `<div class="tools">+${cell.toolsAdded.length} tools</div>` : '';
  const services = cell.awaitedServices?.length ? `<div class="meta">needs ${escapeHtml(cell.awaitedServices.join(', '))}</div>` : '';
  const detail = note ? `<div class="note">${escapeHtml(note)}</div>` : '';
  return `<div class="observation"><span class="pill" style="background:${color}" title="${title}">${status}</span>${tools}${services}<div class="meta">${escapeHtml(cell.composition)} · ${escapeHtml(cell.trust)}</div>${detail}</div>`;
}

export function renderSite(index) {
  const dshVersions = index.dshVersions || [];
  const plugins = index.plugins || [];
  const cells = plugins.flatMap((plugin) => plugin.versions.flatMap((version) => version.cells));
  const tally = {};
  for (const cell of cells) tally[cell.status] = (tally[cell.status] || 0) + 1;
  const rows = plugins.map((plugin) => plugin.versions.map((version) => {
    const columns = dshVersions.map((dsh) => {
      const observations = version.cells.filter((cell) => cell.dsh === dsh)
        .sort((a, b) => a.composition.localeCompare(b.composition) || a.at.localeCompare(b.at));
      return `<td>${observations.length ? observations.map(renderCell).join('') : '<span class="none">—</span>'}</td>`;
    }).join('');
    return `<tr><th>${escapeHtml(plugin.name)}<div class="ver">${escapeHtml(version.version)}</div></th>${columns}</tr>`;
  }).join('\n')).join('\n');
  const source = index.source?.runId || index.sourceRunId || 'unknown';
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<title>DSH plugin compatibility matrix</title>',
    '<style>',
    'body{font:14px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;margin:2rem;color:#1f2328}',
    'h1{font-size:1.4rem;margin:0 0 .25rem}.sub{color:#57606a;margin-bottom:1.5rem}',
    'table{border-collapse:collapse}th,td{border:1px solid #d0d7de;padding:.5rem .75rem;text-align:left;vertical-align:top}',
    'th{background:#f6f8fa;font-weight:600}.ver{color:#57606a;font-weight:400;font-size:.8rem}',
    '.observation{margin-bottom:.65rem}.pill{display:inline-block;color:#fff;border-radius:999px;padding:.1rem .5rem;font-size:.75rem}',
    '.tools{color:#1a7f37;font-size:.75rem;margin-top:.25rem}.meta{color:#8c959f;font-size:.7rem;margin-top:.2rem}',
    '.note{margin-top:1rem;color:#57606a;font-size:.78rem;max-width:60rem}.none{color:#d0d7de;text-align:center}',
    '</style></head><body>',
    '<h1>DSH plugin compatibility matrix</h1>',
    `<div class="sub">${cells.length} cells · ${plugins.length} plugins · ${dshVersions.length} DSH versions · generated ${escapeHtml(index.generatedAt)} · source ${escapeHtml(source)}</div>`,
    `<table><thead><tr><th>Plugin</th>${dshVersions.map((version) => `<th>${escapeHtml(version)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`,
    '<div class="note"><strong>Read "awaiting service" as untested, not as broken.</strong> Each composition is shown separately; no best result is selected across headless and web. Host-half probes do not prove browser client-half behavior or security.</div>',
    `<div class="note"><strong>Statuses:</strong> ${Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([status, count]) => `${escapeHtml(status)} ${count}`).join(' · ')}</div>`,
    '</body></html>',
  ].join('\n');
}
