import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatText, toBadge, toSarif } from '../src/core/report.js';

function report(overrides = {}) {
  return {
    target: { name: 'demo', version: '1.0.0', path: '/tmp/demo' },
    checks: 11,
    findings: [
      {
        rule: 'E1', level: 'error', title: 'bad event', file: 'lib/a.js', line: 3,
        message: 'the message', evidence: 'evidence', hint: 'the hint', doc: 'the doc',
      },
      {
        rule: 'W1', level: 'warn', title: 'coupling', file: 'lib/b.js', line: 0,
        message: '', evidence: 'ev', hint: '', doc: 'the doc',
      },
      {
        rule: 'I1', level: 'info', title: 'metadata', file: undefined, line: undefined,
        message: 'no file', evidence: '', hint: 'h', doc: 'the doc',
      },
    ],
    summary: { error: 1, warn: 1, info: 1 },
    dsh: { declared: ['0.2.0', '0.3.0'], verified: [] },
    ...overrides,
  };
}

test('formatText renders every finding field and the summary', () => {
  const text = formatText(report());
  assert.match(text, /demo@1\.0\.0  11 checks/);
  assert.match(text, /E1 error  bad event/);
  assert.match(text, /lib\/a\.js:3/);
  assert.match(text, /evidence: evidence/);
  assert.match(text, /why: the hint/);
  assert.match(text, /doc: the doc/);
  assert.match(text, /1 error · 1 warn · 1 info/);
});

test('formatText omits the location line when a finding has no file', () => {
  const text = formatText(report());
  const line = text.split('\n').findIndex((entry) => entry.includes('I1 info'));
  assert.equal(text.split('\n')[line + 1].trim(), 'no file');
});

test('formatText paints findings only when color is requested', () => {
  assert.doesNotMatch(formatText(report()), /\u001b\[/);
  assert.match(formatText(report(), { color: true }), /\u001b\[31m/);
  assert.match(formatText(report(), { color: true }), /\u001b\[0m/);
});

test('formatText reports a clean run explicitly', () => {
  const text = formatText(report({ findings: [], summary: { error: 0, warn: 0, info: 0 } }));
  assert.match(text, /clean {2}no findings/);
  assert.match(text, /0 error · 0 warn · 0 info/);
});

test('toSarif maps levels, deduplicates rules and keeps locations', () => {
  const sarif = toSarif([report(), report()]);
  assert.equal(sarif.version, '2.1.0');
  assert.equal(sarif.runs.length, 1);
  const run = sarif.runs[0];
  assert.equal(run.tool.driver.name, 'dsh-plugin-lint');
  assert.deepEqual(run.tool.driver.rules.map((rule) => rule.id), ['E1', 'W1', 'I1']);
  assert.equal(run.results.length, 6, 'two reports contribute six results');
  const error = run.results[0];
  assert.equal(error.level, 'error');
  assert.equal(error.ruleIndex, 0);
  assert.equal(error.locations[0].physicalLocation.artifactLocation.uri, '/tmp/demo/lib/a.js');
  assert.equal(error.locations[0].physicalLocation.region.startLine, 3);
  assert.equal(run.results[1].level, 'warning');
  assert.equal(run.results[2].level, 'note');
  assert.match(error.message.text, /the message — the hint/);
});

test('toSarif accepts a single report and defaults a missing line to 1', () => {
  const single = toSarif({
    ...report(),
    findings: [{ rule: 'I1', level: 'info', title: 't', file: undefined, line: undefined, message: 'm', hint: '', doc: 'd' }],
  });
  assert.equal(single.runs[0].results.length, 1);
  assert.equal(single.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, '/tmp/demo/package.json');
  assert.equal(single.runs[0].results[0].locations[0].physicalLocation.region.startLine, 1);
});

test('toBadge carries the verdict, the colour and the declared version count', () => {
  const red = toBadge(report());
  assert.match(red, /dsh-plugin-lint: 1 error · 1 warn · 2 DSH/);
  assert.match(red, /#cf222e/);
  assert.match(red, /<\/svg>$/);

  const yellow = toBadge(report({ summary: { error: 0, warn: 2, info: 0 }, dsh: { declared: [] } }));
  assert.match(yellow, /#bf8700/);
  assert.doesNotMatch(yellow, /DSH/);

  const green = toBadge(report({ summary: { error: 0, warn: 0, info: 4 }, dsh: undefined }));
  assert.match(green, /#1a7f37/);
});