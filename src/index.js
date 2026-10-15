import { loadPackage } from './load.js';
import { RULES, EVENT_TYPES, localeMeta, DOC } from './rules.js';

export { RULES, EVENT_TYPES, DOC };
export { maskSource } from './mask.js';
export { loadPackage, filesCover } from './load.js';
export { formatText, toSarif, toBadge } from './report.js';

const LEVEL_ORDER = { error: 0, warn: 1, info: 2 };

/** Statements every report carries, so a clean run is never read as an endorsement. */
const LIMITS = [
  'Static analysis of files on disk: it reports what it detected and makes no security judgement.',
  'Line numbers in bundled or minified artifacts point at the bundle, not at the original source.',
  'A rule cites the upstream document it encodes; the installed Harness remains the authority.',
];

export function lintPackage(dir, options = {}) {
  const pkg = loadPackage(dir);
  const manifestText = pkg.text('package.json') || '';
  const ctx = Object.assign({}, pkg, {
    manifestText,
    byPath: (rel) => pkg.jsFiles.find((f) => f.path === rel),
    localeFiles: () => (pkg.entries.localeDir ? localeMeta(dir, pkg.entries.localeDir) : []),
  });

  const findings = [];
  for (const rule of RULES) {
    const push = (finding) => {
      findings.push(Object.assign({ rule: rule.id, level: rule.level, title: rule.title, doc: rule.doc }, finding));
    };
    try {
      rule.check(ctx, options, push);
    } catch (error) {
      findings.push({
        rule: rule.id,
        level: 'info',
        title: rule.title,
        doc: rule.doc,
        file: 'package.json',
        line: 1,
        message: 'rule did not complete: ' + error.message,
        evidence: '',
        hint: 'This is a bug in dsh-plugin-lint; please report it.',
      });
    }
  }

  findings.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]
    || String(a.file).localeCompare(String(b.file))
    || (a.line || 0) - (b.line || 0)
    || a.rule.localeCompare(b.rule));

  const summary = { error: 0, warn: 0, info: 0 };
  for (const f of findings) summary[f.level] += 1;

  const declared = (pkg.manifest.dsh && pkg.manifest.dsh.compatibility
    && pkg.manifest.dsh.compatibility.dshReleases) || undefined;

  return {
    schemaVersion: 1,
    target: {
      name: pkg.manifest.name,
      version: pkg.manifest.version,
      path: dir,
    },
    dsh: {
      declared: declared ? Object.keys(declared) : [],
      verified: [],
    },
    checks: RULES.length,
    summary,
    findings,
    limits: LIMITS,
  };
}
