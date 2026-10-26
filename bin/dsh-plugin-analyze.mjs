#!/usr/bin/env node
/**
 * dsh-plugin-analyze — experimental static analysis for DeepSeek Harness plugins.
 *
 *   conflicts <dir> <dir> [dir ...]   composition clashes between plugins
 *   performance <dir>                 bundle size, complexity, DOM and network indicators
 *   security <dir>                    heuristic security review
 *   full <dir>                        lintPackage + analyzePerformance + analyzeSecurityDeep
 *
 * The analyses are static heuristics, not runtime measurements and not a
 * security verdict; the reports carry their own limits. --json keeps stdout
 * machine-readable: human text is suppressed and errors go to stderr.
 */

import { loadPackage } from '../src/load.js';
import { lintPackage } from '../src/index.js';
import { detectConflicts } from '../src/composition.js';
import { analyzePerformance } from '../src/performance.js';
import { analyzeSecurityDeep } from '../src/security.js';

const USAGE = [
  'dsh-plugin-analyze — experimental static analysis for DeepSeek Harness plugins',
  '',
  'Usage',
  '  dsh-plugin-analyze conflicts <dir> <dir> [dir ...]  [--json] [--exit-code]',
  '  dsh-plugin-analyze performance <dir>                [--json] [--exit-code]',
  '  dsh-plugin-analyze security <dir>                   [--json] [--exit-code]',
  '  dsh-plugin-analyze full <dir>                       [--json] [--exit-code]',
  '',
  'Commands',
  '  conflicts     UI slot, tool name, route, config-key and waterfall clashes',
  '  performance   bundle size, code complexity, DOM and network indicators',
  '  security      heuristic security review; findings cite file and line',
  '  full          conformance lint + performance + security for one plugin',
  '',
  'Options',
  '  --json        print only the JSON report on stdout (errors go to stderr)',
  '  --exit-code   gate the exit status (see below); without it a completed run exits 0',
  '  -h, --help    show this message',
  '',
  'Exit codes',
  '  0  the analysis completed (with --exit-code: the gate did not trip)',
  '  1  --exit-code gate tripped: conflicts found (conflicts), warnings present',
  '     (security), a lint error or a security warning is present (full);',
  '     performance and info-level findings never gate',
  '  2  usage error, missing directory, or a directory without package.json',
  '',
  'These analyses are experimental static heuristics, not a verdict.',
].join('\n');

const CONFLICT_SECTIONS = [
  ['slots', 'UI SLOT COLLISIONS', 'Slot'],
  ['toolNames', 'TOOL NAME COLLISIONS', 'Tool'],
  ['routes', 'ROUTE CONFLICTS', 'Route'],
  ['configKeys', 'CONFIG KEY CONFLICTS', 'Key'],
  ['eventListeners', 'WATERFALL LISTENER ISSUES', 'Event'],
];

const RULE = '-'.repeat(70);
const BANNER = '='.repeat(70);

function fail(message) {
  console.error('dsh-plugin-analyze: ' + message);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { json: false, exitCode: false, help: false, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--exit-code') options.exitCode = true;
    else if (arg === '--') { options.positional.push(...argv.slice(i + 1)); break; }
    else if (arg.startsWith('-') && arg !== '-') fail('unknown option: ' + arg + '\nRun with --help for usage.');
    else options.positional.push(arg);
  }
  return options;
}

function loadTarget(dir) {
  try {
    return loadPackage(dir);
  } catch (error) {
    fail('cannot load ' + JSON.stringify(dir) + ': ' + error.message);
  }
}

function targetOf(pkg, dir) {
  return {
    name: pkg.manifest.name || dir,
    version: pkg.manifest.version,
    path: dir,
  };
}

function analyzeConflicts(dirs) {
  const packages = dirs.map((dir) => {
    const pkg = loadTarget(dir);
    return {
      name: pkg.manifest.name || dir,
      dir,
      manifest: pkg.manifest,
      jsFiles: pkg.jsFiles,
      entries: pkg.entries,
    };
  });
  const conflicts = detectConflicts(packages);
  return {
    targets: packages.map((pkg) => ({ name: pkg.name, path: pkg.dir })),
    ...conflicts,
  };
}

function analyzePerformanceTarget(dir) {
  const pkg = loadTarget(dir);
  return {
    target: targetOf(pkg, dir),
    ...analyzePerformance(pkg),
  };
}

function analyzeSecurityTarget(dir) {
  const pkg = loadTarget(dir);
  return {
    target: targetOf(pkg, dir),
    ...analyzeSecurityDeep(pkg),
  };
}

function analyzeFullTarget(dir) {
  const pkg = loadTarget(dir);
  const lint = lintPackage(dir);
  return {
    target: targetOf(pkg, dir),
    lint,
    performance: analyzePerformance(pkg),
    security: analyzeSecurityDeep(pkg),
    experimental: true,
  };
}

function riskIcon(risk) {
  return risk === 'high' ? '🔴' : risk === 'medium' ? '🟡' : '🟢';
}

function printConflicts(report) {
  console.log('\n🔍 Composition conflicts across ' + report.targets.length + ' plugin(s)');
  console.log('   ' + report.targets.map((target) => target.name).join(', ') + '\n');
  console.log(BANNER);
  console.log('COMPOSITION CONFLICT REPORT');
  console.log(BANNER + '\n');
  console.log('Summary: ' + report.summary.total + ' conflict(s) found');
  console.log('  🔴 High risk:   ' + report.summary.high);
  console.log('  🟡 Medium risk: ' + report.summary.medium);
  console.log('  🟢 Low risk:    ' + report.summary.low + '\n');
  if (report.summary.total === 0) {
    console.log('✅ No conflicts detected. (A static scan resolves literal names only.)\n');
    return;
  }
  for (const [key, heading, label] of CONFLICT_SECTIONS) {
    const entries = report[key] || [];
    if (entries.length === 0) continue;
    console.log('\n' + RULE);
    console.log(heading + ' (' + entries.length + ')');
    console.log(RULE);
    for (const conflict of entries) {
      console.log('\n' + riskIcon(conflict.risk) + ' ' + label + ': ' + conflict.resource + ' (' + conflict.risk + ' risk)');
      console.log('  Plugins: ' + conflict.plugins.join(', '));
      console.log('  Resolution: ' + conflict.resolution);
      for (const claim of conflict.details || []) {
        const where = claim.file ? ' (' + claim.file + ':' + claim.line + ')' : '';
        console.log('    - ' + claim.plugin + where);
      }
    }
  }
  console.log('\n' + BANNER + '\n');
}

function printPerformance(target, metrics) {
  console.log('\n⚡ Performance analysis: ' + target.name + '\n');
  console.log(BANNER);
  console.log('PERFORMANCE REPORT: ' + target.name);
  console.log(BANNER + '\n');

  const scoreIcon = metrics.score >= 90 ? '🟢'
    : metrics.score >= 75 ? '🟡'
      : metrics.score >= 60 ? '🟠' : '🔴';
  console.log(scoreIcon + ' Overall Score: ' + metrics.score + '/100 (' + metrics.rating + ')\n');

  console.log(RULE);
  console.log('BUNDLE SIZE');
  console.log(RULE);
  console.log('  Total: ' + metrics.bundleSize.totalMB + ' MB (' + metrics.bundleSize.fileCount + ' files)');
  console.log('  JavaScript: ' + metrics.bundleSize.jsMB + ' MB');
  if (metrics.bundleSize.largest.length > 0) {
    console.log('\n  Largest files:');
    for (const file of metrics.bundleSize.largest) {
      console.log('    - ' + file.path + ': ' + file.kb + ' KB');
    }
  }

  console.log('\n' + RULE);
  console.log('CODE COMPLEXITY');
  console.log(RULE);
  console.log('  Total lines: ' + metrics.complexity.totalLines);
  console.log('  Avg lines/file: ' + metrics.complexity.avgLinesPerFile);
  console.log('  Total functions: ' + metrics.complexity.totalFunctions);
  console.log('  Deep nesting (4+ levels): ' + metrics.complexity.deepNesting + ' file(s)');
  console.log('  Long functions (large bodies): ' + metrics.complexity.longFunctions);
  console.log('  Maintainability: ' + metrics.complexity.maintainability);
  if (metrics.complexity.complexFiles.length > 0) {
    console.log('\n  Most complex files:');
    for (const file of metrics.complexity.complexFiles) {
      console.log('    - ' + file.path + ': complexity ' + file.complexity + ', ' + file.lines + ' lines');
    }
  }

  if (metrics.domImpact.hasClient) {
    console.log('\n' + RULE);
    console.log('DOM IMPACT');
    console.log(RULE);
    if (metrics.domImpact.analyzed) {
      console.log('  ' + riskIcon(metrics.domImpact.risk) + ' Risk level: ' + metrics.domImpact.risk);
      console.log('  DOM mutations: ' + metrics.domImpact.domMutations);
      console.log('  Direct body access: ' + metrics.domImpact.directBodyAccess);
      console.log('  Heavy selectors: ' + metrics.domImpact.heavySelectors);
    } else {
      console.log('  ⚠️  Client entry declared but not analyzed');
    }
  }

  console.log('\n' + RULE);
  console.log('NETWORK ACTIVITY');
  console.log(RULE);
  console.log('  ' + riskIcon(metrics.networkCalls.risk) + ' Risk level: ' + metrics.networkCalls.risk);
  console.log('  Total network calls: ' + metrics.networkCalls.total);
  console.log('  External domains: ' + metrics.networkCalls.externalDomains.length);
  if (metrics.networkCalls.externalDomains.length > 0) {
    console.log('\n  Domains contacted:');
    for (const domain of metrics.networkCalls.externalDomains) {
      console.log('    - ' + domain);
    }
  }

  if (metrics.heavyDependencies.length > 0) {
    console.log('\n' + RULE);
    console.log('PERFORMANCE-HEAVY PATTERNS');
    console.log(RULE);
    for (const issue of metrics.heavyDependencies) {
      console.log('  ' + riskIcon(issue.severity) + ' ' + issue.type + ' in ' + issue.file);
    }
  }

  if (metrics.recommendations.length > 0) {
    console.log('\n' + RULE);
    console.log('RECOMMENDATIONS');
    console.log(RULE);
    for (const rec of metrics.recommendations) {
      console.log('\n  ' + riskIcon(rec.impact) + ' ' + rec.issue);
      console.log('     → ' + rec.suggestion);
    }
  }
  console.log('\n');
}

function printLint(lint) {
  console.log(BANNER);
  console.log('CONFORMANCE REPORT: ' + (lint.target?.name || 'unknown'));
  console.log(BANNER + '\n');
  console.log('  ' + lint.summary.error + ' error(s) · ' + lint.summary.warn + ' warn(s) · ' + lint.summary.info + ' note(s)');
  if (lint.findings.length === 0) {
    console.log('  No findings.\n');
    return;
  }
  for (const finding of lint.findings) {
    console.log('  [' + finding.level + '] ' + finding.rule + ' ' + finding.file + ':' + finding.line + ' — ' + finding.message);
  }
  console.log('');
}

function printSecurity(target, result) {
  console.log('\n🔐 Security analysis: ' + target.name + '\n');
  console.log(BANNER);
  console.log('SECURITY REPORT: ' + target.name);
  console.log(BANNER + '\n');
  console.log('Risk level: ' + result.riskLevel + '  (' + result.summary.warn + ' warning(s), ' + result.summary.info + ' note(s))\n');
  if (result.findings.length === 0) {
    console.log('  No findings.\n');
    return;
  }
  for (const [category, findings] of Object.entries(result.byCategory || {})) {
    console.log('  ' + category + ':');
    for (const finding of findings) {
      console.log('    [' + finding.rule + ' ' + finding.level + '] ' + finding.title);
      console.log('      ' + finding.file + ':' + finding.line + '  ' + finding.message);
      if (finding.evidence) console.log('      evidence: ' + finding.evidence);
    }
    console.log('');
  }
  console.log('  These are heuristic findings, not a security verdict. Each cites the file and line so it can be checked by hand.\n');
}

function printFull(report) {
  printLint(report.lint);
  console.log(BANNER + '\n');
  printPerformance(report.target, report.performance);
  printSecurity(report.target, report.security);
  console.log('These analyses are experimental static heuristics; the plugin is read, not run.\n');
  console.log('💡 To check composition conflicts with other plugins, run:');
  console.log('   dsh-plugin-analyze conflicts ' + report.target.path + ' <other-plugin-dir>\n');
}

function gateExitCode(command, report, enabled) {
  if (!enabled) return 0;
  if (command === 'conflicts') return report.summary.total > 0 ? 1 : 0;
  if (command === 'performance') return 0;
  // Info findings are an inventory (for example "this plugin calls example.com"),
  // not a problem to gate CI on; only warnings and errors fail the run.
  const securityWarn = () => (report.findings || []).some((f) => f.level === 'warn' || f.level === 'error');
  if (command === 'security') return securityWarn() ? 1 : 0;
  if (command === 'full') {
    const lintErrors = report.lint?.summary?.error ?? 0;
    const fullSecurityWarn = (report.security?.findings || []).some((f) => f.level === 'warn' || f.level === 'error');
    return lintErrors > 0 || fullSecurityWarn ? 1 : 0;
  }
  return 0;
}

const COMMANDS = {
  conflicts: 'conflicts',
  performance: 'performance',
  perf: 'performance',
  security: 'security',
  sec: 'security',
  full: 'full',
  all: 'full',
};

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(USAGE);
  process.exit(0);
}

const [rawCommand, ...targets] = options.positional;
if (rawCommand === undefined) fail('missing command\n\n' + USAGE);
const command = COMMANDS[rawCommand];
if (command === undefined) fail('unknown command: ' + rawCommand + '\nCommands: conflicts, performance, security, full');

if (command === 'conflicts') {
  if (targets.length < 2) fail('conflicts needs at least two plugin directories (got ' + targets.length + ')');
} else if (targets.length !== 1) {
  fail(command + ' needs exactly one plugin directory (got ' + targets.length + ')');
}

let report;
try {
  if (command === 'conflicts') report = analyzeConflicts(targets);
  else if (command === 'performance') report = analyzePerformanceTarget(targets[0]);
  else if (command === 'security') report = analyzeSecurityTarget(targets[0]);
  else report = analyzeFullTarget(targets[0]);
} catch (error) {
  fail('analysis failed: ' + error.message);
}

if (options.json) {
  console.log(JSON.stringify(report, null, 2));
} else if (command === 'conflicts') {
  printConflicts(report);
} else if (command === 'performance') {
  printPerformance(report.target, report);
} else if (command === 'security') {
  printSecurity(report.target, report);
} else {
  printFull(report);
}

process.exit(gateExitCode(command, report, options.exitCode));
