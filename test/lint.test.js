import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintPackage, RULES, toBadge } from '../src/index.js';
import { maskSource } from '../src/mask.js';

/** Build a throwaway package on disk and lint it. */
function fixture(files, options) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-plugin-lint-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  const report = lintPackage(dir, options);
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

test('E3 stays quiet for a configuration-only bundle', () => {
  const report = fixture({
    'package.json': base({ main: undefined, dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    'cordis.patch.yml': '- insert: []',
  });
  assert.equal(rules(report).includes('E3'), false, 'a configuration-only bundle needs no host entry');
});

test('E3 does not fire on the official configuration-only MCP template', () => {
  const dir = fileURLToPath(new URL('../reference/official-skill/templates/mcp', import.meta.url));
  const report = lintPackage(dir);
  assert.equal(report.findings.some((f) => f.rule === 'E3'), false);
});

test('E4 fires when client.js exists but exports["./client"] is not declared', () => {
  const report = fixture({
    'package.json': base({ exports: { '.': './index.js' }, dsh: { client: { platform: 'web' } } }),
    'index.js': 'export function apply() {}',
    'client.js': 'window.__ModuleLoader__.load({ id: "demo-plugin", factory: () => ({}) });',
  });
  assert.ok(report.findings.some((f) => f.rule === 'E4' && f.level === 'error'));
});

test('E4 stays quiet when exports["./client"] resolves', () => {
  const report = fixture({
    'package.json': base({ exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web' } } }),
    'index.js': 'export function apply() {}',
    'client.js': 'window.__ModuleLoader__.load({ id: "demo-plugin", factory: () => ({}) });',
  });
  assert.equal(rules(report).includes('E4'), false);
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

test('E1 ignores FormData and unrelated receivers but accepts a direct session receiver', () => {
  const unrelated = fixture({
    'package.json': base(),
    'index.js': 'form.append("custom/event", value); other.append("other/event", value); foo.session.append("other/event", value);',
  });
  assert.equal(rules(unrelated).includes('E1'), false);
  const direct = fixture({
    'package.json': base(),
    'index.js': 'session.append("custom/event", value);',
  });
  assert.equal(rules(direct).includes('E1'), true);
});

test('E5 includes main automatically but rejects a client omitted by empty files', () => {
  const report = fixture({
    'package.json': base({ files: [], exports: { '.': './index.js', './client': './client.js' } }),
    'index.js': 'export function apply() {}',
    'client.js': 'window.__ModuleLoader__.load({ id: "demo-plugin", factory: () => ({}) });',
  });
  const hits = report.findings.filter((finding) => finding.rule === 'E5');
  assert.equal(hits.length, 1);
  assert.match(hits[0].message, /client entry/);
});

test('E5 does not invent a host entry for a config-only package', () => {
  const report = fixture({
    'package.json': base({ main: undefined, files: ['cordis.patch.yml'], dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    'cordis.patch.yml': '- insert: []',
  });
  assert.equal(rules(report).includes('E5'), false);
});

test('a throwing rule is a sanitized RULE_FAILED tool error with its cause', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-plugin-lint-rule-error-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify(base()));
  writeFileSync(join(dir, 'index.js'), 'export function apply() {}');
  const index = RULES.length;
  RULES.push({ id: 'ZX', level: 'info', title: 'broken test rule', doc: '', check() { throw new Error('root-cause'); } });
  try {
    assert.throws(() => lintPackage(dir), (error) => {
      assert.equal(error.code, 'RULE_FAILED');
      assert.equal(error.rule, 'ZX');
      assert.equal(error.cause.message, 'root-cause');
      assert.equal(error.message.includes('root-cause'), false);
      return true;
    });
  } finally {
    RULES.splice(index, 1);
    rmSync(dir, { recursive: true, force: true });
  }
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

test('lintPackage preserves the synchronous lint JSON v1 contract', () => {
  const report = fixture({ 'package.json': base(), 'index.js': 'export function apply() {}' });
  assert.equal(report instanceof Promise, false);
  assert.equal(report.schemaVersion, 1);
  for (const field of ['target', 'dsh', 'checks', 'summary', 'findings', 'limits']) {
    assert.equal(Object.hasOwn(report, field), true, `missing lint v1 field: ${field}`);
  }
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

test('E1 ignores an append call in a comment after a postfix division', () => {
  const report = fixture({
    'package.json': base(),
    'index.js': 'let b = 2;\nconst y = b++ / 2; // session.append("fake/type", data)\nexport { y };',
  });
  assert.equal(rules(report).includes('E1'), false);
});

test('E1 ignores a session.append call that is only text inside a string', () => {
  const report = fixture({
    'package.json': base(),
    'index.js': 'export const doc = "use session.append(" + "fake/type" + ") to log";',
  });
  assert.equal(rules(report).includes('E1'), false);
});

test('E1 ignores a dynamic first argument and its payload string', () => {
  const report = fixture({
    'package.json': base(),
    'index.js': 'export function apply(session, type) { session.append(type, { mime: "image/png" }); }',
  });
  assert.equal(rules(report).includes('E1'), false);
});

test('E1 checks agent.session and this.session receivers', () => {
  const viaAgent = fixture({
    'package.json': base(),
    'index.js': 'export function apply(agent) { agent.session.append("demo/custom", {}); }',
  });
  assert.equal(rules(viaAgent).includes('E1'), true);
  const viaThis = fixture({
    'package.json': base(),
    'index.js': 'export class P { run() { this.session.append("demo/custom", {}); } }',
  });
  assert.equal(rules(viaThis).includes('E1'), true);
});

test('E2 accepts the <package>/client id the loader normalises', () => {
  const report = fixture({
    'package.json': base({ exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web' } } }),
    'index.js': 'export function apply() {}',
    'client.js': 'window.__ModuleLoader__.load({ id: "demo-plugin/client", factory: () => ({}) });',
  });
  assert.equal(rules(report).includes('E2'), false);
});

test('E2 rejects a patch row that belongs to another package', () => {
  const report = fixture({
    'package.json': base({ exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web' }, bundle: { patch: './cordis.patch.yml' } } }),
    'index.js': 'export function apply() {}',
    'client.js': 'window.__ModuleLoader__.load({ id: "@scope/other", factory: () => ({}) });',
    'cordis.patch.yml': ['- insert:', '    - id: other', '      name: "@scope/other"', ''].join('\n'),
  });
  assert.equal(rules(report).includes('E2'), true);
});

test('E3 follows exports["."] precedence over a stale main', () => {
  const report = fixture({
    'package.json': base({ main: 'missing.js', exports: { '.': './index.js' } }),
    'index.js': 'export function apply() {}',
  });
  assert.equal(report.findings.some((f) => f.rule === 'E3' && f.level === 'error'), false);
});

test('E3 checks exports["."] when main exists but exports is broken', () => {
  const report = fixture({
    'package.json': base({ main: 'index.js', exports: { '.': './missing.js' } }),
    'index.js': 'export function apply() {}',
  });
  const hit = report.findings.find((f) => f.rule === 'E3' && f.level === 'error');
  assert.ok(hit, 'expected an error for the broken exports entry');
  assert.match(hit.message, /missing\.js/);
});

test('E4 rejects an import-only client export the host cannot resolve', () => {
  const report = fixture({
    'package.json': base({ exports: { '.': './index.js', './client': { import: './client.js' } }, dsh: { client: { platform: 'web' } } }),
    'index.js': 'export function apply() {}',
    'client.js': 'window.__ModuleLoader__.load({ id: "demo-plugin", factory: () => ({}) });',
  });
  assert.ok(report.findings.some((f) => f.rule === 'E4' && f.level === 'error'));
});

test('E4 accepts a string-default client export', () => {
  const report = fixture({
    'package.json': base({ exports: { '.': './index.js', './client': { default: './client.js', import: './client.js' } }, dsh: { client: { platform: 'web' } } }),
    'index.js': 'export function apply() {}',
    'client.js': 'window.__ModuleLoader__.load({ id: "demo-plugin", factory: () => ({}) });',
  });
  assert.equal(rules(report).includes('E4'), false);
});

test('E6 reports a DSH peer range that excludes the target runtime', () => {
  const report = fixture({
    'package.json': base({ peerDependencies: { '@deepseek-ai/dsh': '>=0.3.0' } }),
    'index.js': 'export function apply() {}',
  }, { dshVersion: '0.2.2-rc.1' });
  const hit = report.findings.find((finding) => finding.rule === 'E6');
  assert.ok(hit, 'expected E6');
  assert.equal(hit.level, 'error');
  assert.match(hit.message, /does not accept DSH 0\.2\.2-rc\.1/);
});

test('E6 accepts a prerelease target inside the range, like the host', () => {
  const report = fixture({
    'package.json': base({ peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0' } }),
    'index.js': 'export function apply() {}',
  }, { dshVersion: '0.2.2-alpha.3' });
  assert.equal(report.findings.some((finding) => finding.rule === 'E6'), false);
});

test('E6 stays quiet without a target version or without DSH peers', () => {
  const noTarget = fixture({
    'package.json': base({ peerDependencies: { '@deepseek-ai/dsh': '>=9.9.9' } }),
    'index.js': 'export function apply() {}',
  });
  assert.equal(noTarget.findings.some((finding) => finding.rule === 'E6'), false);
  const noPeers = fixture({
    'package.json': base({ dependencies: { '@deepseek-ai/dsh': '>=9.9.9' } }),
    'index.js': 'export function apply() {}',
  }, { dshVersion: '0.2.2-rc.1' });
  assert.equal(noPeers.findings.some((finding) => finding.rule === 'E6'), false);
});

test('E6 reports an undecidable range as info, never as an error', () => {
  const report = fixture({
    'package.json': base({ peerDependencies: { '@deepseek-ai/dsh': 'latest' } }),
    'index.js': 'export function apply() {}',
  }, { dshVersion: '0.2.2-rc.1' });
  const hit = report.findings.find((finding) => finding.rule === 'E6');
  assert.ok(hit);
  assert.equal(hit.level, 'info');
});

test('E6 treats workspace:^ as the runtime version, like the host', () => {
  const report = fixture({
    'package.json': base({ peerDependencies: { '@deepseek-ai/dsh': 'workspace:^' } }),
    'index.js': 'export function apply() {}',
  }, { dshVersion: '0.2.2-rc.1' });
  assert.equal(report.findings.some((finding) => finding.rule === 'E6'), false);
});

const tsLayout = () => ({
  'package.json': base({
    main: 'lib/index.js',
    exports: { '.': './lib/index.js', './client': './lib/client.js' },
    files: ['lib'],
    scripts: { prepack: 'tsc' },
    dsh: { client: { platform: 'web' } },
  }),
  'src/index.ts': 'export function apply(ctx) { ctx.session.append("demo/custom", {}); }',
  'src/client.tsx': 'export const view = 1;',
});

test('publish phase treats unbuilt TypeScript outputs as errors', () => {
  const report = fixture(tsLayout());
  assert.ok(report.findings.some((finding) => finding.rule === 'E3' && finding.level === 'error'));
  assert.ok(report.findings.some((finding) => finding.rule === 'E4' && finding.level === 'error'));
});

test('author phase collects TypeScript and does not accuse an unbuilt tree', () => {
  const report = fixture(tsLayout(), { phase: 'author' });
  assert.equal(report.findings.some((finding) => finding.rule === 'E3' && finding.level === 'error'), false);
  assert.equal(report.findings.some((finding) => finding.rule === 'E4' && finding.level === 'error'), false);
  assert.ok(report.findings.some((finding) => finding.rule === 'E3' && finding.level === 'info'));
  assert.ok(report.findings.some((finding) => finding.rule === 'E1' && finding.file === 'src/index.ts'), 'TS files are analysed in author phase');
});
