import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function probeFixture(t, {
  loadedVersion = '1.2.3',
  install = 'success',
  bootText = 'MISSING_CREDENTIAL',
  sourceFiles = {},
  isolation = 'host-unsafe',
} = {}) {
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-probe-integration-'));
  const source = mkdtempSync(join(tmpdir(), 'dsh-probe-source-'));
  t.after(() => {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  });
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'demo', version: '1.2.3', main: 'index.js' }));
  writeFileSync(join(source, 'index.js'), 'export function apply() {}');
  for (const [rel, content] of Object.entries(sourceFiles)) {
    const path = join(source, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  const artifact = {
    name: 'demo',
    requestedVersion: 'latest',
    resolvedVersion: '1.2.3',
    integrity: 'sha512-fixture',
    installTarget: 'demo@1.2.3',
    local: true,
    path: source,
  };
  const environment = {
    isolation,
    workDir,
    profileDir: workDir,
    dshDir: join(workDir, 'dsh'),
    calls: { install: 0, boot: 0, destroy: 0 },
    async materialize(input) {
      return { ...input, hostPath: source, installTarget: source };
    },
    async install() {
      environment.calls.install += 1;
      if (install !== 'missing') {
        const manifest = join(workDir, 'profiles', 'headless', 'node_modules', 'demo', 'package.json');
        mkdirSync(dirname(manifest), { recursive: true });
        writeFileSync(manifest, JSON.stringify({ name: 'demo', version: loadedVersion }));
        const webManifest = join(workDir, 'profiles', 'web', 'node_modules', 'demo', 'package.json');
        mkdirSync(dirname(webManifest), { recursive: true });
        writeFileSync(webManifest, JSON.stringify({ name: 'demo', version: loadedVersion }));
      }
      if (install === 'warning') throw Object.assign(new Error('peer warning'), { stdout: 'peer dependency warning' });
      return { out: '' };
    },
    async boot({ composition = 'headless' } = {}) {
      environment.calls.boot += 1;
      mkdirSync(join(workDir, 'profiles', composition), { recursive: true });
      return { out: typeof bootText === 'function' ? bootText(composition) : bootText };
    },
    async destroy() {
      environment.calls.destroy += 1;
    },
  };
  const dsh = isolation === 'docker' && loadedVersion === 'desktop'
    ? { kind: 'desktop', version: 'desktop', node: 'desktop', cli: 'unused', extraArgs: [] }
    : { kind: 'npm', version: '0.2.0', node: process.execPath, cli: 'unused', extraArgs: [] };
  return { artifact, dsh, environment };
}
