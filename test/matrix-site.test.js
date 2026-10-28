import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from '../src/matrix/index.js';
import { createCell } from '../src/matrix/cell.js';
import { escapeHtml, renderSite } from '../src/matrix/site.js';
import { cellInput } from './matrix-helpers.js';

test('site keeps headless and web as separate observations for one DSH', () => {
  const waiting = cellInput({ composition: 'headless' });
  waiting.observation.result.status = 'awaiting-service';
  const cells = [createCell(waiting), createCell(cellInput({ composition: 'web' }))];
  const index = buildIndex(cells, { generatedAt: '2026-10-02T00:00:00.000Z', source: { runId: 'run-1' } });
  const html = renderSite(index);
  assert.match(html, /headless/);
  assert.match(html, /web/);
  assert.match(html, /awaiting-service/);
  assert.match(html, /active/);
  assert.doesNotMatch(html, /most favourable|best composition/i);
});

test('site escapes plugin metadata, notes, source, and statuses', () => {
  const cell = createCell(cellInput({ artifact: { ...cellInput().artifact, name: '<script>alert(1)</script>' } }));
  cell.evidence.note = '<script>alert(2)</script>';
  const index = buildIndex([cell], { generatedAt: '2026-10-02T00:00:00.000Z', source: { runId: '<script>alert(3)</script>' } });
  const html = renderSite(index);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  assert.match(html, /&lt;script&gt;alert\(3\)&lt;\/script&gt;/);
  assert.equal(escapeHtml('<&>"\''), '&lt;&amp;&gt;&quot;&#39;');
});
