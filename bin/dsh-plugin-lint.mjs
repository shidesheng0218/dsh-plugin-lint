#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { lintPackage, formatText, toSarif, toBadge, RULES } from '../src/index.js';
import { toGithub, toJunit } from '../src/core/report.js';
import { formatProfileScan, scanProfile } from '../src/core/profile-scan.js';
import { changedFiles, packageRoots } from '../src/core/changed.js';
import { extractTarballTo, packDirectory, packFromNpm } from '../src/core/pack.js';
import {
  applyBaseline,
  createBaseline,
  pruneBaseline,
  readBaseline,
  writeBaseline,
} from '../src/core/baseline.js';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/**
 * A directory without its own package.json is treated as a container: every
 * immediate subdirectory that is a package gets linted. Monorepos and fixture
 * folders are the reason — measured: CI pointed the tool at a folder of two
 * plugins and it refused the whole run.
 */
function expandTargets(dir) {
  if (existsSync(join(dir, 'package.json'))) return [dir];
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { entries = []; }
  const packages = entries
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'package.json')))
    .map((e) => join(dir, e.name));
  if (packages.length === 0) fail('not a package directory (no package.json): ' + dir);
  return packages;
}

const USAGE = [
  'dsh-plugin-lint — conformance checks for DeepSeek Harness plugins',
  '',
  'Usage',
  '  dsh-plugin-lint [dir ...] [options]',
  '',
  'A directory without its own package.json is treated as a container, and every',
  'immediate subdirectory that is a package is linted.',
  '',
  'Options',
  '  --format <fmt>         text | json | json-envelope | sarif | github | junit | badge',
  '  --json                 legacy JSON report (object for one package, array for several)',
  '  --sarif                SARIF 2.1.0 report on stdout',
  '  --badge                SVG badge on stdout',
  '  --github               GitHub Actions annotations',
  '  --junit                JUnit XML report',
  '  -o, --output-file <f>  write the formatted output to a file',
  '  --dsh-version <ver>    target DSH runtime for I1 and the E6 peer check',
  '  --phase <phase>        publish (default) | author (pre-build source tree)',
  '  --profile <dir>        offline admission scan of an installed DSH profile',
  '  --changed [ref]        lint only packages touched since ref (default HEAD)',
  '  --pack [pm]            pack the package and lint the real tarball (auto|npm|pnpm|yarn|bun)',
  '  --from-npm <spec>      pack a published package from npm and lint the tarball',
  '  --staged               lint only packages with staged changes',
  '  --fail-on <level>      error | warn | info: exit 1 when a finding at or above the level remains',
  '  --max-warnings <n>     exit 1 when more than n warnings remain',
  '  --exit-code            alias for --fail-on error',
  '  --baseline <file>      suppress findings recorded in a baseline file',
  '  --write-baseline [f]   write a fresh baseline (default .dsh-plugin-lint-baseline.json)',
  '  --prune                with --baseline: drop entries that no longer occur',
  '  --init [dir]           write a starter workflow, baseline, and agent skill',
  '  --force                with --init: overwrite existing files',
  '  --rules                list every rule with its level',
  '  --explain <rule>       show one rule',
  '  --version              print the package version',
  '  --no-color             disable ANSI colour',
  '  --quiet                print only the summary line',
  '  -h, --help             show this message',
  '',
  'Exit codes: 0 ok · 1 findings at the selected gate · 2 run failed',
].join('\n');

const FORMATS = new Set(['text', 'json', 'json-envelope', 'sarif', 'github', 'junit', 'badge']);
const LEVELS = ['error', 'warn', 'info'];

function parseArgs(argv) {
  const options = {
    dirs: [], format: 'text', outputFile: undefined, dshVersion: undefined, phase: 'publish',
    failOn: undefined, maxWarnings: undefined, baselinePath: undefined, writeBaseline: false,
    prune: false, init: undefined, force: false, profile: undefined, changed: false, changedRef: undefined, staged: false, pack: undefined, npmSpecs: [], color: process.stdout.isTTY === true, quiet: false,
    help: false, version: false, rules: false, explain: undefined, envelope: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') options.help = true;
    else if (a === '--version') options.version = true;
    else if (a === '--rules') options.rules = true;
    else if (a === '--explain') { options.explain = argv[++i]; if (!options.explain) fail('--explain needs a rule id'); }
    else if (a === '--format') {
      options.format = argv[++i];
      if (!FORMATS.has(options.format)) fail('--format must be one of: ' + [...FORMATS].join(', '));
      if (options.format === 'json-envelope') { options.format = 'json'; options.envelope = true; }
    }
    else if (a === '--json') { options.format = 'json'; options.envelope = false; }
    else if (a === '--json-envelope') { options.format = 'json'; options.envelope = true; }
    else if (a === '--sarif') options.format = 'sarif';
    else if (a === '--badge') options.format = 'badge';
    else if (a === '--github') options.format = 'github';
    else if (a === '--junit') options.format = 'junit';
    else if (a === '--output-file' || a === '-o') { options.outputFile = argv[++i]; if (!options.outputFile) fail(a + ' needs a path'); }
    else if (a === '--dsh-version') { options.dshVersion = argv[++i]; if (!options.dshVersion) fail('--dsh-version needs a value'); }
    else if (a === '--phase') {
      options.phase = argv[++i];
      if (!['author', 'publish'].includes(options.phase)) fail('--phase must be author or publish');
    }
    else if (a === '--fail-on') {
      options.failOn = argv[++i];
      if (!LEVELS.includes(options.failOn)) fail('--fail-on must be error, warn, or info');
    }
    else if (a === '--max-warnings') {
      options.maxWarnings = Number(argv[++i]);
      if (!Number.isInteger(options.maxWarnings) || options.maxWarnings < 0) fail('--max-warnings needs a non-negative integer');
    }
    else if (a === '--exit-code') options.failOn = 'error';
    else if (a === '--baseline') { options.baselinePath = argv[++i]; if (!options.baselinePath) fail('--baseline needs a path'); }
    else if (a === '--write-baseline') {
      options.writeBaseline = true;
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) { options.baselinePath = next; i += 1; }
    }
    else if (a === '--prune') options.prune = true;
    else if (a === '--init') {
      options.init = true;
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) { options.initDir = next; i += 1; }
    }
    else if (a === '--force') options.force = true;
    else if (a === '--changed') {
      options.changed = true;
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) { options.changedRef = next; i += 1; }
    }
    else if (a === '--staged') { options.changed = true; options.staged = true; }
    else if (a === '--pack') {
      const next = argv[i + 1];
      if (next && ['auto', 'npm', 'pnpm', 'yarn', 'bun'].includes(next)) { options.pack = next; i += 1; }
      else options.pack = 'auto';
    }
    else if (a === '--from-npm') { const spec = argv[++i]; if (!spec) fail('--from-npm needs a package spec'); options.npmSpecs.push(spec); }
    else if (a === '--profile') { options.profile = argv[++i]; if (!options.profile) fail('--profile needs a directory'); }
    else if (a === '--no-color') options.color = false;
    else if (a === '--quiet') options.quiet = true;
    else if (a.startsWith('-')) fail('unknown option: ' + a);
    else options.dirs.push(a);
  }
  if (options.dirs.length === 0 && options.npmSpecs.length === 0) options.dirs.push('.');
  if (process.env.NO_COLOR !== undefined) options.color = false;
  return options;
}

function fail(message) {
  console.error('dsh-plugin-lint: ' + message);
  process.exit(2);
}

function listRules() {
  return RULES.map((rule) => rule.id.padEnd(3) + ' ' + rule.level.padEnd(5) + ' ' + rule.title).join('\n');
}

function explainRule(id) {
  const rule = RULES.find((entry) => entry.id === id);
  if (!rule) fail('unknown rule: ' + id + ' (try --rules)');
  return [
    rule.id + ' (' + rule.level + ') — ' + rule.title,
    'doc: ' + rule.doc,
    'docs: https://github.com/shidesheng0218/dsh-plugin-lint/blob/main/docs/rules/' + rule.id + '.md',
  ].join('\n');
}

function initFiles(options) {
  const dir = resolve(options.initDir || options.dirs[0] || '.');
  const workflow = join(dir, '.github', 'workflows', 'dsh-plugin-lint.yml');
  const baseline = join(dir, '.dsh-plugin-lint-baseline.json');
  const skill = join(dir, '.claude', 'skills', 'dsh-plugin-lint', 'SKILL.md');
  for (const path of [workflow, baseline, skill]) {
    if (existsSync(path) && !options.force) fail(path + ' already exists (use --force to overwrite)');
  }
  mkdirSync(dirname(workflow), { recursive: true });
  writeFileSync(workflow, [
    'name: dsh-plugin-lint',
    'on:',
    '  pull_request:',
    '  push:',
    '    branches: [main]',
    'permissions:',
    '  contents: read',
    '  pull-requests: write   # the sticky comment',
    'jobs:',
    '  lint:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: shidesheng0218/dsh-plugin-lint@main',
    '        with:',
    '          path: .',
    '          fail-on: error',
    '          baseline: .dsh-plugin-lint-baseline.json',
    '          comment: true',
    '',
  ].join('\n'));
  writeBaseline(baseline, createBaseline([]));
  mkdirSync(dirname(skill), { recursive: true });
  writeFileSync(skill, [
    '---',
    'name: dsh-plugin-lint',
    'description: Verify a DeepSeek Harness plugin before committing or publishing. Use when editing package.json, cordis.patch.yml, client.js, or locale files.',
    '---',
    '',
    '# DSH plugin conformance',
    '',
    'After changing a manifest or plugin code, run:',
    '',
    '```bash',
    'npx @shidesheng0218/dsh-plugin-lint . --fail-on warn',
    '```',
    '',
    '- Before the build (TypeScript tree): add `--phase author`.',
    '- Before publishing: `--pack` lints the tarball npm would publish; `--from-npm <spec>` lints a published one.',
    '- With a host version: `--dsh-version <version>` makes E6 test the host\'s real peer gate.',
    '- Explain a finding with `--explain <rule>`; the long form is `docs/rules/<rule>.md`.',
    '',
    'Do not silence E6 by dropping or widening a peer range unless the target host actually accepts it. The baseline is for known findings, not for hiding new ones: `--write-baseline` records, `--prune` drops stale entries.',
    '',
  ].join('\n'));
  console.log('created ' + workflow);
  console.log('created ' + baseline + ' (run with --write-baseline to record existing findings)');
  console.log('created ' + skill);
}

const options = parseArgs(process.argv.slice(2));
if (options.help) { console.log(USAGE); process.exit(0); }
if (options.version) { console.log(VERSION); process.exit(0); }
if (options.rules) { console.log(listRules()); process.exit(0); }
if (options.explain) { console.log(explainRule(options.explain)); process.exit(0); }
if (options.writeBaseline && options.prune) fail('--write-baseline and --prune are different operations');
if (options.prune && !options.baselinePath) fail('--prune needs --baseline');
if (options.init) { initFiles(options); process.exit(0); }

if (options.changed && options.profile) fail('--changed cannot be combined with --profile');

if (options.changed) {
  let files;
  try {
    files = changedFiles({ cwd: process.cwd(), ref: options.changedRef, staged: options.staged });
  } catch (error) {
    fail('git diff failed: ' + error.message);
  }
  const roots = packageRoots(files, process.cwd());
  if (roots.length === 0) fail('no package.json found for the changed files');
  options.dirs = roots;
}

if (options.profile) {
  if (!['text', 'json'].includes(options.format)) fail('--profile supports --format text or json');
  let scan;
  try {
    scan = scanProfile(resolve(options.profile), { dshVersion: options.dshVersion });
  } catch (error) {
    fail(error.message);
  }
  const output = options.format === 'json' ? JSON.stringify(scan, null, 2) : formatProfileScan(scan);
  if (options.outputFile) {
    mkdirSync(dirname(resolve(options.outputFile)), { recursive: true });
    writeFileSync(options.outputFile, output + '\n');
    console.error('dsh-plugin-lint: wrote ' + options.outputFile);
  } else {
    console.log(output);
  }
  if (options.failOn && scan.summary.willReject > 0) process.exit(1);
  process.exit(0);
}

if ((options.pack || options.npmSpecs.length || options.dirs.some((dir) => dir.endsWith('.tgz'))) && options.phase === 'author') {
  fail('--pack, --from-npm, and .tgz inputs describe a published artifact; use --phase publish');
}

const cleanups = [];
process.on('exit', () => {
  for (const cleanup of cleanups) {
    try { cleanup(); } catch { /* best effort */ }
  }
});

const reports = [];
for (const spec of options.npmSpecs) {
  try {
    const packed = packFromNpm(spec);
    cleanups.push(packed.cleanup);
    const extracted = extractTarballTo(packed.tarball);
    cleanups.push(extracted.cleanup);
    reports.push(lintPackage(extracted.root, { dshVersion: options.dshVersion, phase: 'publish', source: packed.source }));
  } catch (error) {
    fail(error.message);
  }
}
for (const dir of options.dirs) {
  if (dir.endsWith('.tgz')) {
    try {
      const extracted = extractTarballTo(resolve(dir));
      cleanups.push(extracted.cleanup);
      reports.push(lintPackage(extracted.root, { dshVersion: options.dshVersion, phase: 'publish', source: 'tarball:' + dir }));
    } catch (error) {
      fail(error.message);
    }
    continue;
  }
  for (const target of expandTargets(resolve(dir))) {
    try {
      if (options.pack) {
        const packed = packDirectory(target, { manager: options.pack });
        cleanups.push(packed.cleanup);
        const extracted = extractTarballTo(packed.tarball);
        cleanups.push(extracted.cleanup);
        reports.push(lintPackage(extracted.root, { dshVersion: options.dshVersion, phase: 'publish', source: 'pack:' + packed.manager }));
      } else {
        reports.push(lintPackage(target, { dshVersion: options.dshVersion, phase: options.phase }));
      }
    } catch (error) {
      fail(error.message);
    }
  }
}

let active = reports;
let suppressed = 0;
let baseline;
const baselinePath = options.baselinePath || (options.writeBaseline ? '.dsh-plugin-lint-baseline.json' : undefined);
if (options.writeBaseline) {
  baseline = createBaseline(reports);
  writeBaseline(baselinePath, baseline);
  console.error('dsh-plugin-lint: wrote baseline ' + baselinePath + ' (' + baseline.findings.length + ' finding(s))');
} else if (options.prune) {
  baseline = pruneBaseline(readBaseline(baselinePath), reports);
  writeBaseline(baselinePath, baseline);
  console.error('dsh-plugin-lint: pruned baseline ' + baselinePath + ' (' + baseline.findings.length + ' finding(s))');
} else if (baselinePath && existsSync(baselinePath)) {
  const applied = applyBaseline(reports, readBaseline(baselinePath), { path: baselinePath });
  active = applied.reports;
  suppressed = applied.suppressed;
}

function render() {
  if (options.format === 'json') {
    return JSON.stringify(options.envelope
      ? { schemaVersion: 1, reports: active, baseline: baselinePath ? { path: baselinePath, suppressed } : undefined }
      : (active.length === 1 ? active[0] : active), null, 2);
  }
  if (options.format === 'sarif') return JSON.stringify(toSarif(active), null, 2);
  if (options.format === 'github') return toGithub(active);
  if (options.format === 'junit') return toJunit(active);
  if (options.format === 'badge') return active.map((report) => toBadge(report)).join('\n');
  const text = active.map((report) => (options.quiet
    ? report.target.name + ': ' + report.summary.error + ' error · ' + report.summary.warn + ' warn · ' + report.summary.info + ' info'
    : formatText(report, { color: options.color }))).join('\n');
  return suppressed > 0 ? text + '\n  (' + suppressed + ' finding(s) suppressed by baseline)' : text;
}

const output = render();
if (options.outputFile) {
  mkdirSync(dirname(resolve(options.outputFile)), { recursive: true });
  writeFileSync(options.outputFile, output + '\n');
  console.error('dsh-plugin-lint: wrote ' + options.outputFile);
} else if (output.length > 0) {
  console.log(output);
}

const totals = active.reduce((sum, report) => {
  sum.error += report.summary.error;
  sum.warn += report.summary.warn;
  sum.info += report.summary.info;
  return sum;
}, { error: 0, warn: 0, info: 0 });
if (options.failOn === 'error' && totals.error > 0) process.exit(1);
if (options.failOn === 'warn' && (totals.error > 0 || totals.warn > 0)) process.exit(1);
if (options.failOn === 'info' && (totals.error > 0 || totals.warn > 0 || totals.info > 0)) process.exit(1);
if (options.maxWarnings !== undefined && totals.warn > options.maxWarnings) process.exit(1);