import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { fingerprint } from './baseline.js';

const COLOR = {
  error: '\u001b[31m',
  warn: '\u001b[33m',
  info: '\u001b[36m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  reset: '\u001b[0m',
};

const LABEL = { error: 'error', warn: 'warn ', info: 'info ' };

/**
 * An SVG badge for a README. The badge carries the verdict, not just the brand:
 * "0 error · 1 warn · compatible with 2 DSH versions". A reader should learn
 * something from the badge alone.
 */
export function toBadge(report) {
  const s = report.summary;
  const declared = (report.dsh && report.dsh.declared) || [];
  const versionText = declared.length > 0 ? ' · ' + declared.length + ' DSH' : '';
  const label = s.error + ' error · ' + s.warn + ' warn' + versionText;
  const color = s.error > 0 ? '#cf222e' : s.warn > 0 ? '#bf8700' : '#1a7f37';
  const left = 'dsh-plugin-lint';
  const width = 90 + label.length * 6.2;
  const leftWidth = 96;
  const rightWidth = width - leftWidth;
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + Math.round(width) + '" height="20" role="img" aria-label="' + left + ': ' + label + '">',
    '  <title>' + left + ': ' + label + '</title>',
    '  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>',
    '  <clipPath id="r"><rect width="' + Math.round(width) + '" height="20" rx="3" fill="#fff"/></clipPath>',
    '  <g clip-path="url(#r)">',
    '    <rect width="' + leftWidth + '" height="20" fill="#555"/>',
    '    <rect x="' + leftWidth + '" width="' + Math.round(rightWidth) + '" height="20" fill="' + color + '"/>',
    '    <rect width="' + Math.round(width) + '" height="20" fill="url(#s)"/>',
    '  </g>',
    '  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">',
    '    <text aria-hidden="true" x="' + (leftWidth * 5) + '" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="' + (leftWidth * 10 - 100) + '">' + left + '</text>',
    '    <text x="' + (leftWidth * 5) + '" y="140" transform="scale(.1)" fill="#fff" textLength="' + (leftWidth * 10 - 100) + '">' + left + '</text>',
    '    <text aria-hidden="true" x="' + ((leftWidth + rightWidth / 2) * 10) + '" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="' + (rightWidth * 10 - 100) + '">' + label + '</text>',
    '    <text x="' + ((leftWidth + rightWidth / 2) * 10) + '" y="140" transform="scale(.1)" fill="#fff" textLength="' + (rightWidth * 10 - 100) + '">' + label + '</text>',
    '  </g>',
    '</svg>',
  ].join('\n');
}

export function formatText(report, options = {}) {
  const paint = (level, text) => (options.color ? COLOR[level] + text + COLOR.reset : text);
  const dim = (text) => (options.color ? COLOR.dim + text + COLOR.reset : text);
  const lines = [];
  const t = report.target;
  lines.push((options.color ? COLOR.bold : '') + t.name + '@' + t.version
    + (options.color ? COLOR.reset : '') + dim('  ' + report.checks + ' checks'));
  lines.push('');

  if (report.findings.length === 0) {
    lines.push('  ' + paint('info', 'clean') + '  no findings');
  }
  for (const f of report.findings) {
    const where = f.file ? f.file + (f.line ? ':' + f.line : '') : '';
    lines.push('  ' + paint(f.level, f.rule + ' ' + LABEL[f.level]) + '  ' + f.title);
    if (where) lines.push('         ' + dim(where));
    if (f.message) lines.push('         ' + f.message);
    if (f.evidence) lines.push('         ' + dim('evidence: ' + f.evidence));
    if (f.hint) lines.push('         ' + dim('why: ' + f.hint));
    lines.push('         ' + dim('doc: ' + f.doc));
    lines.push('');
  }

  const s = report.summary;
  lines.push('  ' + s.error + ' error · ' + s.warn + ' warn · ' + s.info + ' info');
  return lines.join('\n');
}

function uriFor(report, file) {
  const absolute = join(report.target.path, file || 'package.json');
  let cwd = process.cwd();
  let target = absolute;
  try { cwd = realpathSync(cwd); } catch { /* keep the logical path */ }
  try { target = realpathSync(absolute); } catch { /* the finding may point at a virtual path */ }
  const rel = relative(cwd, target).replace(/\\/g, '/');
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : target.replace(/\\/g, '/');
}

function ruleHelpUri(id) {
  return 'https://github.com/shidesheng0218/dsh-plugin-lint/blob/main/docs/rules/' + id + '.md';
}

export function toSarif(reports) {
  const list = Array.isArray(reports) ? reports : [reports];
  const ruleIndex = new Map();
  const rules = [];
  const results = [];
  for (const report of list) {
    for (const f of report.findings) {
      if (!ruleIndex.has(f.rule)) {
        ruleIndex.set(f.rule, rules.length);
        rules.push({
          id: f.rule,
          name: f.rule,
          shortDescription: { text: f.title },
          helpUri: ruleHelpUri(f.rule),
          properties: { doc: f.doc, level: f.level },
        });
      }
      results.push({
        ruleId: f.rule,
        ruleIndex: ruleIndex.get(f.rule),
        level: f.level === 'error' ? 'error' : f.level === 'warn' ? 'warning' : 'note',
        message: { text: f.message + (f.hint ? ' — ' + f.hint : '') },
        partialFingerprints: { 'dshPluginLint/v1': fingerprint(f) },
        locations: [{
          physicalLocation: {
            artifactLocation: { uri: uriFor(report, f.file), uriBaseId: '%SRCROOT%' },
            region: { startLine: f.line || 1 },
          },
        }],
      });
    }
  }
  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [{
      tool: { driver: { name: 'dsh-plugin-lint', informationUri: 'https://github.com/shidesheng0218/dsh-plugin-lint', rules } },
      results,
    }],
  };
}

function escapeData(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeProperty(value) {
  return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

export function toGithub(reports) {
  const lines = [];
  for (const report of reports) {
    for (const f of report.findings) {
      const level = f.level === 'error' ? 'error' : f.level === 'warn' ? 'warning' : 'notice';
      const properties = ['file=' + escapeProperty(uriFor(report, f.file))];
      if (f.line) properties.push('line=' + f.line);
      properties.push('title=' + escapeProperty(f.rule + ' ' + f.title));
      lines.push('::' + level + ' ' + properties.join(',') + '::' + escapeData(f.message + (f.hint ? ' — ' + f.hint : '')));
    }
  }
  return lines.join('\n');
}

function xml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function toJunit(reports) {
  const suites = reports.map((report) => {
    const failures = report.findings.filter((finding) => finding.level !== 'info').length;
    const cases = report.findings.map((finding) => {
      const name = finding.rule + ' ' + (finding.file || 'package.json') + (finding.line ? ':' + finding.line : '');
      const body = finding.level === 'info'
        ? ''
        : '<failure type="' + xml(finding.rule) + '" message="' + xml(finding.message) + '">' + xml(finding.evidence || '') + '</failure>';
      return '<testcase classname="' + xml(report.target.name) + '" name="' + xml(name) + '">' + body + '</testcase>';
    }).join('');
    return '<testsuite name="' + xml(report.target.name) + '" tests="' + report.findings.length + '" failures="' + failures + '">' + cases + '</testsuite>';
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>' + suites + '</testsuites>';
}
