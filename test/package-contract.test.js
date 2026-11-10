import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROBE_VERSION } from '../src/shared/version.js';

const root = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
const panel = JSON.parse(readFileSync(fileURLToPath(new URL('../panel/package.json', import.meta.url)), 'utf8'));
const ci = readFileSync(fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url)), 'utf8');
const publishLint = readFileSync(fileURLToPath(new URL('../.github/workflows/publish-lint.yml', import.meta.url)), 'utf8');
const publishPanel = readFileSync(fileURLToPath(new URL('../.github/workflows/publish-panel.yml', import.meta.url)), 'utf8');

const CORE_EXPORTS = [
  'DOC', 'EVENT_TYPES', 'RULES', 'filesCover', 'formatText',
  'lintPackage', 'loadPackage', 'maskSource', 'toBadge', 'toSarif',
].sort();

test('release versions are the planned 0.4.0 / 0.2.0 pair', () => {
  assert.equal(root.version, '0.4.0');
  assert.equal(panel.version, '0.2.0');
  assert.equal(PROBE_VERSION, root.version, 'PROBE_VERSION identifies the published implementation');
});

test('the root entry keeps exactly the ten stable exports', async () => {
  const module = await import('../src/index.js');
  assert.deepEqual(Object.keys(module).sort(), CORE_EXPORTS);
});

test('the experimental subpath exposes the analysis API', async () => {
  const module = await import('../src/experimental/index.js');
  for (const name of ['detectConflicts', 'analyzePerformance', 'analyzeSecurityDeep']) {
    assert.equal(typeof module[name], 'function', 'missing ' + name);
  }
  assert.ok(Array.isArray(module.SECURITY_RULES));
  assert.ok(Array.isArray(module.SECURITY_LIMITS));
});

test('the published root package keeps its dependency-free, flat shape', () => {
  assert.equal(root.dependencies, undefined);
  assert.equal(root.workspaces, undefined);
  for (const entry of ['bin/', 'src/', 'scripts/probe-boot.mjs', 'scripts/lib/', 'README.md', 'LICENSE', 'NOTICE']) {
    assert.equal(root.files.includes(entry), true, 'files omission: ' + entry);
  }
  assert.equal(root.exports['./experimental'], './src/experimental/index.js');
});

test('the panel package ships its host half and only aggregate data', () => {
  for (const entry of ['index.js', 'client.js', 'host/', 'shared/', 'data/aggregate.json', 'cordis.patch.yml']) {
    assert.equal(panel.files.includes(entry), true, 'panel files omission: ' + entry);
  }
  assert.equal(panel.files.includes('data/matrix-index.json'), false, 'the named snapshot must not ship');
  assert.equal(panel.dependencies, undefined);
});

test('CI exercises both supported Node lines, coverage and the packed artifact', () => {
  assert.match(ci, /node:\s*\['22',\s*'24'\]/);
  assert.match(ci, /node-version: \$\{\{ matrix\.node \}\}/);
  assert.match(ci, /npm run test:coverage/);
  assert.match(ci, /node scripts\/package-smoke\.mjs/);
  assert.match(ci, /e2e-official\.mjs --expect 80/);
  assert.match(ci, /scripts\/probe-boot\.mjs .*--dsh 0\.2\.0-rc\.2/);
});

test('the coverage gate enforces the release thresholds', () => {
  const script = root.scripts['test:coverage'];
  assert.match(script, /--test-coverage-lines=85/);
  assert.match(script, /--test-coverage-branches=80/);
  assert.match(script, /--test-coverage-functions=80/);
});

test('publishing requires a new version and never auto-bumps', () => {
  for (const workflow of [publishLint, publishPanel]) {
    assert.doesNotMatch(workflow, /npm version patch/);
    assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
    assert.match(workflow, /publish=false/);
  }
  assert.match(publishLint, /paths:\n\s+- 'package\.json'/);
  assert.match(publishPanel, /paths:\n\s+- 'panel\/package\.json'/);
  assert.doesNotMatch(publishLint, /- 'src\/\*\*'/);
  assert.match(publishLint, /PROBE_VERSION/);
  assert.match(publishLint, /e2e-official\.mjs --expect 80/);
  assert.match(publishPanel, /node --input-type=module -e/);
});