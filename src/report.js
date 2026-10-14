const COLOR = {
  error: '\u001b[31m',
  warn: '\u001b[33m',
  info: '\u001b[36m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  reset: '\u001b[0m',
};

const LABEL = { error: 'error', warn: 'warn ', info: 'info ' };

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
          helpUri: 'https://github.com/shidesheng0218/dsh-plugin-lint',
          properties: { doc: f.doc, level: f.level },
        });
      }
      results.push({
        ruleId: f.rule,
        ruleIndex: ruleIndex.get(f.rule),
        level: f.level === 'error' ? 'error' : f.level === 'warn' ? 'warning' : 'note',
        message: { text: f.message + (f.hint ? ' — ' + f.hint : '') },
        locations: [{
          physicalLocation: {
            artifactLocation: { uri: report.target.path + '/' + (f.file || 'package.json') },
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
