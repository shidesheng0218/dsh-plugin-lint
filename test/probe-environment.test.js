import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProbeEnvironment } from '../src/probe/environment.js';
import { WEB_READY, resolveDsh, runDsh, runUntilReady, safeEnv } from '../src/probe/dsh-adapter.js';

function fakeRunner(handler = async () => ({ stdout: '', stderr: '' })) {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    return handler(command, args, options);
  };
  runner.calls = calls;
  return runner;
}

const dsh = { kind: 'npm', node: 'node', cli: '/dsh/bin.js', extraArgs: [] };

test('safeEnv drops ambient credentials and keeps only explicit probe values', () => {
  const oldToken = process.env.NPM_TOKEN;
  const oldProbe = process.env.PROBE_API_KEY;
  process.env.NPM_TOKEN = 'must-not-leak';
  process.env.PROBE_API_KEY = 'ambient-too';
  try {
    const env = safeEnv({ DSH_HOME: '/tmp/profile', PROBE_API_KEY: 'probe', CUSTOM_VALUE: 'not-allowed' });
    assert.equal(env.NPM_TOKEN, undefined);
    assert.equal(env.DSH_HOME, '/tmp/profile');
    assert.equal(env.PROBE_API_KEY, 'probe');
    assert.equal(env.CUSTOM_VALUE, undefined);
    assert.equal(safeEnv().PROBE_API_KEY, undefined, 'the stub key must be explicit, not ambient');
  } finally {
    if (oldToken === undefined) delete process.env.NPM_TOKEN;
    else process.env.NPM_TOKEN = oldToken;
    if (oldProbe === undefined) delete process.env.PROBE_API_KEY;
    else process.env.PROBE_API_KEY = oldProbe;
  }
});

test('runDsh passes a whitelisted environment to the child', async () => {
  const runner = fakeRunner(async () => ({ stdout: 'ok', stderr: '' }));
  const output = await runDsh(dsh, '/tmp/profile', ['--version'], { PROBE_API_KEY: 'probe', NPM_TOKEN: 'no' }, { runner });
  assert.equal(output, 'ok');
  const options = runner.calls[0].options;
  assert.equal(options.env.DSH_HOME, '/tmp/profile');
  assert.equal(options.env.PROBE_API_KEY, 'probe');
  assert.equal(options.env.NPM_TOKEN, undefined);
});

test('runUntilReady does not expand the ambient environment', async () => {
  let received;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => queueMicrotask(() => child.emit('exit', 0));
  const spawnImpl = (command, args, options) => {
    received = { command, args, options };
    queueMicrotask(() => child.stdout.emit('data', 'dsh web: http://127.0.0.1:1234/?token=local'));
    return child;
  };
  const output = await runUntilReady(dsh, '/tmp/profile', [], { PROBE_API_KEY: 'probe' }, WEB_READY, { spawnImpl, graceMs: 1, timeoutMs: 100 });
  assert.match(output, /dsh web:/);
  assert.equal(received.options.env.DSH_HOME, '/tmp/profile');
  assert.equal(received.options.env.PROBE_API_KEY, 'probe');
  assert.equal(received.options.env.NPM_TOKEN, undefined);
});

test('resolveDsh installs with an isolated home and no inherited token', async (t) => {
  const cacheRoot = mkdtempSync(join(tmpdir(), 'dsh-resolver-env-'));
  t.after(() => rmSync(cacheRoot, { recursive: true, force: true }));
  const runner = fakeRunner(async (command, args) => {
    if (command === 'npm') {
      const prefix = args[args.indexOf('--prefix') + 1];
      mkdirSync(join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true });
      writeFileSync(join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '');
    }
    return { stdout: '', stderr: '' };
  });
  await resolveDsh('1.2.3', cacheRoot, { runner });
  const options = runner.calls[0].options;
  assert.equal(options.env.HOME.startsWith(cacheRoot), true);
  assert.equal(options.env.NPM_TOKEN, undefined);
});

test('auto fails closed when Docker is unavailable', async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-no-docker-'));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  const unavailableRunner = async () => { throw new Error('spawn docker ENOENT'); };
  unavailableRunner.executed = [];
  await assert.rejects(
    createProbeEnvironment({ backend: 'auto', workDir, runner: unavailableRunner }),
    (error) => error.code === 'ISOLATION_UNAVAILABLE',
  );
  assert.equal(unavailableRunner.executed.length, 0, 'no environment or plugin command is started');
});

test('docker hardens every run, separates network phases, and force-cleans containers', async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-docker-env-'));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  const runner = fakeRunner(async (command, args) => ({ stdout: args[0] === 'version' ? '27.0.0' : '', stderr: '' }));
  const environment = await createProbeEnvironment({ backend: 'docker', workDir, runner });
  await environment.install({ dsh, target: 'demo@1.2.3', profile: 'headless', env: { PROBE_API_KEY: 'probe', NPM_TOKEN: 'no' } });
  await environment.boot({ dsh, args: ['--profile', 'headless', 'probe'] });
  const runs = runner.calls.filter((call) => call.args[0] === 'run');
  assert.equal(runs.length, 2);
  for (const call of runs) {
    const args = call.args;
    for (const expected of ['--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=1000:1000', '--pids-limit=128', '--memory=512m', '--cpus=1']) {
      assert.equal(args.includes(expected), true, `missing Docker hardening: ${expected}`);
    }
    assert.equal(args.some((arg) => arg.startsWith('--volume=') && arg.endsWith(':/source:ro')), true);
    assert.equal(args.some((arg) => arg.startsWith('--volume=') && arg.endsWith(':/profile:rw')), true);
    assert.equal(call.options.env.NPM_TOKEN, undefined);
  }
  assert.equal(runs[0].args.includes('--network=bridge'), true);
  assert.equal(runs[1].args.includes('--network=none'), true);
  assert.equal(runs[0].args.includes('--env=NPM_TOKEN=no'), false);
  await environment.destroy();
  const removals = runner.calls.filter((call) => call.args[0] === 'rm');
  assert.equal(removals.length >= 2, true);
  assert.equal(removals.every((call) => call.args[1] === '-f'), true);
  assert.equal(existsSync(environment.workDir), false);
});

test('materialize copies local input into the read-only source mount', async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-materialize-env-'));
  const source = mkdtempSync(join(tmpdir(), 'dsh-materialize-source-'));
  t.after(() => {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  });
  writeFileSync(join(source, 'package.json'), '{"name":"demo","version":"1.2.3"}');
  const runner = fakeRunner(async () => ({ stdout: '27.0.0', stderr: '' }));
  const environment = await createProbeEnvironment({ backend: 'docker', workDir, runner });
  const artifact = await environment.materialize({ name: 'demo', local: true, path: source });
  assert.equal(artifact.installTarget, '/source/demo');
  assert.equal(existsSync(artifact.hostPath), true);
  await environment.destroy();
});

test('unsafe host requires an explicit backend and carries a warning', async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-host-env-'));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  const environment = await createProbeEnvironment({ backend: 'host-unsafe', workDir });
  assert.equal(environment.isolation, 'host-unsafe');
  assert.match(environment.warning, /unsafe/i);
  await environment.destroy();
});
