import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintPackage, toBadge } from '../src/index.js';
import { maskSource } from '../src/mask.js';

/** Build a throwaway package on disk and lint it. */
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-plugin-lint-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  const report = lintPackage(dir);
  rmSync(dir, { recursive: true, force: true });
  return report;
}

const base = (extra = {}) => ({
  name: 'demo-plugin',
  version: '1.0.0',
  type: 'module',
  main: 'index.js',
  ...extra,
});
const rules = (report) => report.findings.map((f) => f.rule);

test('E1 fires on a session event type outside the catalog', () => {
  const report = fixture({
    'package.json': base(),
    'index.js': 'export function apply(ctx) { ctx.session.append("demo/custom", { a: 1 }); }',
  });
  const hit = report.findings.find((f) => f.rule === 'E1');
  assert.ok(hit, 'expected E1');
  assert.equal(hit.level, 'error');
  assert.match(hit.evidence, /demo\/custom/);
});

test('E1 stays quiet for a catalogued event type', () => {
  const report = fixture({
    'package.json': base(),
    'index.js': 'export function apply(ctx) { ctx.session.append("tool/call", payload); }',
  });
  assert.equal(rules(report).includes('E1'), false);
});

test('E1 ignores an append that only appears in a comment', () => {
  const report = fixture({
    'package.json': base(),
    'index.js': '// ctx.session.append("demo/from-comment", {})\nexport function apply() {}',
  });
  assert.equal(rules(report).includes('E1'), false);
});

test('E2 fires when the client factory id differs from the package name', () => {
  const report = fixture({
    'package.json': base({ exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web' } } }),
    'index.js': 'export function apply() {}',
    'client.js': 'window.__ModuleLoader__.load({ id: "other-name", factory: (r) => ({}) });',
  });
  const hit = report.findings.find((f) => f.rule === 'E2');
  assert.ok(hit, 'expected E2');
  assert.match(hit.evidence, /other-name/);
});

test('E2 stays quiet when the factory id equals the package name', () => {
  const report = fixture({
    'package.json': base({ exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web' } } }),
    'index.js': 'export function apply() {}',
    'client.js': 'window.__ModuleLoader__.load({ id: "demo-plugin", factory: (r) => ({}) });',
  });
  assert.equal(rules(report).includes('E2'), false);
});

test('E2 accepts a factory id that matches a row name in the plugin patch', () => {
  const report = fixture({
    'package.json': base({ exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web' }, bundle: { patch: './cordis.patch.yml' } } }),
    'index.js': 'export function apply() {}',
    'client.js': 'window.__ModuleLoader__.load({ id: "demo-plugin/sub", factory: (r) => ({}) });',
    'cordis.patch.yml': ['- insert:', '    - id: demo-sub', '      name: "demo-plugin/sub"', ''].join('\n'),
  });
  assert.equal(rules(report).includes('E2'), false);
});

test('E3 fires when the bundle patch is missing', () => {
  const report = fixture({
    'package.json': base({ dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    'index.js': 'export function apply() {}',
  });
  assert.ok(report.findings.some((f) => f.rule === 'E3' && f.level === 'error'));
});

test('E4 fires when dsh.client is declared without a client entry', () => {
  const report = fixture({
    'package.json': base({ dsh: { client: { platform: 'web' } } }),
    'index.js': 'export function apply() {}',
  });
  assert.ok(report.findings.some((f) => f.rule === 'E4' && f.level === 'error'));
});

test('E5 fires when files[] omits an artifact the manifest needs', () => {
  const report = fixture({
    'package.json': base({ files: ['index.js'], dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    'index.js': 'export function apply() {}',
    'cordis.patch.yml': '- insert: []',
  });
  const hit = report.findings.find((f) => f.rule === 'E5');
  assert.ok(hit, 'expected E5');
  assert.match(hit.message, /cordis\.patch\.yml/);
});

test('E5 accepts a directory entry that covers the host entry', () => {
  const report = fixture({
    'package.json': base({ main: 'lib/index.js', files: ['lib', 'cordis.patch.yml'], dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    'lib/index.js': 'export function apply() {}',
    'cordis.patch.yml': '- insert: []',
  });
  assert.equal(rules(report).includes('E5'), false);
});

test('E5 still flags a root artifact when files[] only lists a subdirectory', () => {
  const report = fixture({
    'package.json': base({ main: 'lib/index.js', files: ['lib'], dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    'lib/index.js': 'export function apply() {}',
    'cordis.patch.yml': '- insert: []',
  });
  const hits = report.findings.filter((f) => f.rule === 'E5');
  assert.equal(hits.length, 1);
  assert.match(hits[0].message, /bundle patch/);
});

test('W1 warns for a third-party plugin that loads a Harness client package', () => {
  const report = fixture({
    'package.json': base({ exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web' } } }),
    'index.js': 'export function apply() {}',
    'client.js': 'window.__ModuleLoader__.load({ id: "demo-plugin", factory: (r) => { const p = r("@deepseek-ai/dsh-client-ui-primitives"); return p; } });',
  });
  assert.ok(report.findings.some((f) => f.rule === 'W1' && f.level === 'warn'));
});

test('W1 exempts first-party packages', () => {
  const report = fixture({
    'package.json': base({ name: '@deepseek-ai/dsh-demo', exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web' } } }),
    'index.js': 'export function apply() {}',
    'client.js': 'window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-demo", factory: (r) => r("@deepseek-ai/dsh-client-ui-primitives") });',
  });
  assert.equal(rules(report).includes('W1'), false);
});

test('W2 warns only when the listener body rescans the log', () => {
  const rescans = fixture({
    'package.json': base(),
    'index.js': 'export function apply(ctx) { ctx.on("session/event", (session) => { for (const e of session.events) use(e); }); }',
  });
  assert.ok(rescans.findings.some((f) => f.rule === 'W2'));

  const incremental = fixture({
    'package.json': base(),
    'index.js': 'export function apply(ctx) { ctx.on("session/event", (session, event) => { buffer.push(event); }); }',
  });
  assert.equal(rules(incremental).includes('W2'), false);
});

test('W2 ignores an unrelated .events read elsewhere in the file', () => {
  const report = fixture({
    'package.json': base(),
    'index.js': 'export function apply(ctx) { const source = { events: [] }; use(source.events); ctx.on("session/event", (s, e) => { push(e); }); }',
  });
  assert.equal(rules(report).includes('W2'), false);
});

test('I1 and I2 report missing compatibility and display metadata', () => {
  const report = fixture({ 'package.json': base(), 'index.js': 'export function apply() {}' });
  assert.ok(report.findings.some((f) => f.rule === 'I1' && f.level === 'info'));
  assert.ok(report.findings.some((f) => f.rule === 'I2' && f.level === 'info'));
});

test('I1 flags a declared range that omits the running DSH version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-plugin-lint-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify(base({ dsh: { compatibility: { dshReleases: { '0.1.0': 'compatible' } } } })));
  writeFileSync(join(dir, 'index.js'), 'export function apply() {}');
  const report = lintPackage(dir, { dshVersion: '0.2.0-rc.2' });
  rmSync(dir, { recursive: true, force: true });
  assert.ok(report.findings.some((f) => f.rule === 'I1' && /0\.2\.0-rc\.2/.test(f.message)));
});

test('I3 reports locale metadata that the manifest does not publish', () => {
  const report = fixture({
    'package.json': base({ files: ['index.js'] }),
    'index.js': 'export function apply() {}',
    'locale/en.json': { meta: { title: 'Demo' } },
  });
  assert.ok(report.findings.some((f) => f.rule === 'I3'));
});

test('every report carries the checks it ran and its limits', () => {
  const report = fixture({ 'package.json': base(), 'index.js': 'export function apply() {}' });
  assert.equal(report.schemaVersion, 1);
  assert.ok(report.checks >= 11);
  assert.ok(report.limits.length >= 3);
  assert.deepEqual(Object.keys(report.summary).sort(), ['error', 'info', 'warn']);
});

test('the CLI lints every package inside a container directory', () => {
  // Measured failure that motivated this: CI pointed the tool at a folder of two
  // plugins and the run refused the whole folder.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lint-container-'));
  for (const name of ['alpha', 'beta']) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'package.json'), JSON.stringify(base({ name })));
    writeFileSync(join(dir, name, 'index.js'), 'export function apply() {}');
  }
  const cli = fileURLToPath(new URL('../bin/dsh-plugin-lint.mjs', import.meta.url));
  const out = execFileSync(process.execPath, [cli, dir, '--quiet', '--no-color'], { encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  assert.match(out, /alpha:/);
  assert.match(out, /beta:/);
});

test('the CLI refuses a directory that holds no package', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lint-empty-'));
  const cli = fileURLToPath(new URL('../bin/dsh-plugin-lint.mjs', import.meta.url));
  let code = 0;
  try {
    execFileSync(process.execPath, [cli, dir, '--quiet'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    code = error.status;
  }
  rmSync(dir, { recursive: true, force: true });
  assert.equal(code, 2);
});

test('maskSource blanks comments but keeps string literals and line numbers', () => {
  const src = 'const a = 1; // "quoted" in a comment\nconst b = "value";';
  const { masked, strings, lineStarts } = maskSource(src);
  assert.equal(masked.includes('quoted'), false, 'comment text must be blanked');
  assert.equal(strings.length, 1, 'a quoted word inside a comment is not a string literal');
  assert.equal(strings[0].value, 'value');
  assert.equal(strings[0].line, 2);
  assert.equal(lineStarts.length, 2);
});

// ---------------------------------------------------------------- badge

test('a badge carries the verdict and the declared DSH versions', () => {
  const report = lintPackage('panel');
  const svg = toBadge(report);
  assert.match(svg, /dsh-plugin-lint/);
  assert.match(svg, /0 error · 0 warn · 2 DSH/);
  assert.match(svg, /<svg/);
  assert.match(svg, /#1a7f37/, 'a clean run is green');
});

test('a badge turns red on errors', () => {
  const report = fixture({
    'package.json': base(),
    'index.js': 'export function apply(ctx) { ctx.session.append("demo/custom", {}); }',
  });
  const svg = toBadge(report);
  assert.match(svg, /1 error/, 'the count is in the badge');
  assert.match(svg, /#cf222e/, 'an error is red');
});
