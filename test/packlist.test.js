import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildPacklist, globToRegExp, hasPackedFile } from '../src/core/packlist.js';

const base = (extra = {}) => ({ name: 'demo-plugin', version: '1.0.0', type: 'module', main: 'index.js', ...extra });

function packageFixture(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-packlist-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  return { dir, manifest };
}

test('empty files still includes main and intrinsic files, but not client', (t) => {
  const { dir, manifest } = packageFixture(t, {
    'package.json': base({ files: [], exports: { '.': './index.js', './client': './client.js' } }),
    'index.js': 'export function apply() {}',
    'client.js': 'window.__ModuleLoader__.load({ id: "demo-plugin", factory: () => ({}) });',
    'README.md': '# demo',
  });
  const packlist = buildPacklist(dir, manifest);
  assert.equal(hasPackedFile(packlist, 'index.js'), true);
  assert.equal(hasPackedFile(packlist, 'package.json'), true);
  assert.equal(hasPackedFile(packlist, 'README.md'), true);
  assert.equal(hasPackedFile(packlist, 'client.js'), false);
});

test('missing files uses the package directory while common secrets and locks stay out', (t) => {
  const { dir, manifest } = packageFixture(t, {
    'package.json': base(),
    'index.js': '',
    'client.js': '',
    'locale/en.json': '{}',
    '.npmrc': 'token=secret',
    'package-lock.json': '{}',
  });
  const packlist = buildPacklist(dir, manifest);
  assert.equal(hasPackedFile(packlist, 'client.js'), true);
  assert.equal(hasPackedFile(packlist, 'locale/en.json'), true);
  assert.equal(hasPackedFile(packlist, '.npmrc'), false);
  assert.equal(hasPackedFile(packlist, 'package-lock.json'), false);
});

test('main is included even when files only lists another directory', (t) => {
  const { dir, manifest } = packageFixture(t, {
    'package.json': base({ main: 'lib/index.js', files: ['lib'] }),
    'lib/index.js': '',
    'client.js': '',
  });
  const packlist = buildPacklist(dir, manifest);
  assert.equal(hasPackedFile(packlist, 'lib/index.js'), true);
  assert.equal(hasPackedFile(packlist, 'client.js'), false);
});

test('glob and negated files rules do not suffer sequential replacement', (t) => {
  const { dir, manifest } = packageFixture(t, {
    'package.json': base({ files: ['**/*', '!client.js'] }),
    'index.js': '',
    'client.js': '',
    'lib/nested.js': '',
  });
  const packlist = buildPacklist(dir, manifest);
  assert.equal(hasPackedFile(packlist, 'index.js'), true);
  assert.equal(hasPackedFile(packlist, 'lib/nested.js'), true);
  assert.equal(hasPackedFile(packlist, 'client.js'), false);
  assert.equal(globToRegExp('**/*').test('lib/nested.js'), true);
  assert.equal(globToRegExp('*.js').test('lib/nested.js'), false);
});

test('a files array disables the root npmignore, matching npm-packlist', (t) => {
  const { dir, manifest } = packageFixture(t, {
    'package.json': base({ files: ['**/*'] }),
    '.npmignore': 'client.js\nlocale/\n',
    'index.js': '',
    'client.js': '',
    'locale/en.json': '{}',
  });
  const packlist = buildPacklist(dir, manifest);
  assert.equal(hasPackedFile(packlist, 'index.js'), true);
  // npm-packlist sets the root .npmignore to null when package.json has files.
  assert.equal(hasPackedFile(packlist, 'client.js'), true);
  assert.equal(hasPackedFile(packlist, 'locale/en.json'), true);
});

test('without files, the root npmignore excludes files and directories', (t) => {
  const { dir, manifest } = packageFixture(t, {
    'package.json': base(),
    '.npmignore': 'client.js\nlocale/\n',
    'index.js': '',
    'client.js': '',
    'locale/en.json': '{}',
  });
  const packlist = buildPacklist(dir, manifest);
  assert.equal(hasPackedFile(packlist, 'index.js'), true);
  assert.equal(hasPackedFile(packlist, 'client.js'), false);
  assert.equal(hasPackedFile(packlist, 'locale/en.json'), false);
});

test('without npmignore, npm falls back to gitignore', (t) => {
  const { dir, manifest } = packageFixture(t, {
    'package.json': base(),
    '.gitignore': 'client.js\n',
    'index.js': '',
    'client.js': '',
  });
  const packlist = buildPacklist(dir, manifest);
  assert.equal(hasPackedFile(packlist, 'index.js'), true);
  assert.equal(hasPackedFile(packlist, 'client.js'), false);
});

test('a nested npmignore still applies when files is present', (t) => {
  const { dir, manifest } = packageFixture(t, {
    'package.json': base({ files: ['**/*'] }),
    'index.js': '',
    'lib/keep.js': '',
    'lib/drop.js': '',
    'lib/.npmignore': 'drop.js\n',
  });
  const packlist = buildPacklist(dir, manifest);
  assert.equal(hasPackedFile(packlist, 'lib/keep.js'), true);
  assert.equal(hasPackedFile(packlist, 'lib/drop.js'), false);
});

const differentialArtifacts = ['index.js', 'lib/index.js', 'client.js', 'cordis.patch.yml', 'icon.png', 'locale/en.json'];

function actualNpmPack(dir) {
  const stdout = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: dir, encoding: 'utf8' });
  const result = JSON.parse(stdout);
  return new Set(result[0].files.map((file) => file.path));
}

test('representative artifacts match real npm pack dry-run output', async (t) => {
  const fixtures = [
    {
      'package.json': base({ files: [], exports: { '.': './index.js', './client': './client.js' } }),
      'index.js': '', 'client.js': '', 'cordis.patch.yml': '', 'icon.png': '', 'locale/en.json': '{}',
    },
    {
      'package.json': base({ main: 'lib/index.js', files: ['lib'] }),
      'lib/index.js': '', 'client.js': '', 'cordis.patch.yml': '', 'icon.png': '', 'locale/en.json': '{}',
    },
    {
      'package.json': base({ files: ['**/*', '!client.js'] }),
      'index.js': '', 'client.js': '', 'cordis.patch.yml': '', 'icon.png': '', 'locale/en.json': '{}',
    },
    {
      'package.json': base(),
      '.npmignore': 'client.js\nlocale/\n',
      'index.js': '', 'client.js': '', 'cordis.patch.yml': '', 'icon.png': '', 'locale/en.json': '{}',
    },
    {
      'package.json': base({ files: ['**/*'] }),
      '.npmignore': 'client.js\nlocale/\n',
      'index.js': '', 'client.js': '', 'cordis.patch.yml': '', 'icon.png': '', 'locale/en.json': '{}',
    },
    {
      'package.json': base(),
      '.gitignore': 'client.js\n',
      'index.js': '', 'client.js': '', 'cordis.patch.yml': '', 'icon.png': '', 'locale/en.json': '{}',
    },
  ];
  for (const files of fixtures) {
    const { dir, manifest } = packageFixture(t, files);
    const packlist = buildPacklist(dir, manifest);
    const actual = actualNpmPack(dir);
    for (const rel of differentialArtifacts) {
      assert.equal(hasPackedFile(packlist, rel), actual.has(rel), `${manifest.files ? JSON.stringify(manifest.files) : 'default'}: ${rel}`);
    }
  }
});
