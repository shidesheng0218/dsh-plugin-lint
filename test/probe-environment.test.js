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
  // The slim image has no pnpm; the shim must be in the writable profile mount
  // and first on PATH so `dsh plugin add` can find it.
  assert.equal(existsSync(join(environment.profileDir, '.probe-bin', 'pnpm')), true);
  assert.equal(runs[0].args.some((arg) => arg.startsWith('--env=PATH=/profile/.probe-bin:')), true);
  // Docker mounts /tmp noexec; the native-addon cache must be disabled or the
  // loader cannot dlopen its copied .node file.
  assert.equal(runs[0].args.includes('--env=NARB_DISABLE_NATIVE_CACHE=1'), true);
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

test('resolveDsh installs the harness inside the isolated environment', async (t) => {
  const dshDir = mkdtempSync(join(tmpdir(), 'dsh-isolated-resolver-'));
  t.after(() => rmSync(dshDir, { recursive: true, force: true }));
  const calls = [];
  const environment = {
    isolation: 'docker',
    dshDir,
    async boot(input) {
      calls.push(input);
      const cli = join(dshDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      mkdirSync(join(dshDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true });
      writeFileSync(cli, '');
      return { out: '' };
    },
  };
  const resolved = await resolveDsh('1.2.3', undefined, { environment });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].network, 'registry');
  assert.equal(calls[0].writableDsh, true);
  assert.equal(calls[0].args.includes('@deepseek-ai/dsh@1.2.3'), true);
  assert.equal(resolved.containerCli, '/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js');
});

test('web readiness is returned even when the long-lived server is stopped', async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-web-ready-'));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  const runner = fakeRunner(async (command, args) => {
    if (args[0] === 'version') return { stdout: '27.0.0', stderr: '' };
    if (args[0] === 'run') throw Object.assign(new Error('timeout'), { stdout: 'dsh web: http://127.0.0.1:1234/?token=local', killed: true });
    return { stdout: '', stderr: '' };
  });
  const environment = await createProbeEnvironment({ backend: 'docker', workDir, runner });
  const result = await environment.boot({ dsh, args: [], readyRe: WEB_READY });
  assert.match(result.out, /dsh web:/);
  await environment.destroy();
});

test('the tools stub uses an internal Docker network and replays captured requests', async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-internal-stub-'));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  const runner = fakeRunner(async (command, args) => {
    if (args[0] === 'version') return { stdout: '27.0.0', stderr: '' };
    if (args[0] === 'network' && args[1] === 'create') return { stdout: 'network-id', stderr: '' };
    if (args[0] === 'logs') return { stdout: 'PROBE_STUB_READY', stderr: '' };
    return { stdout: '', stderr: '' };
  });
  const environment = await createProbeEnvironment({ backend: 'docker', workDir, runner });
  const stub = await environment.startStub();
  assert.equal(stub.baseURL, 'http://probe-stub:3000');
  const networkCreate = runner.calls.find((call) => call.args[0] === 'network' && call.args[1] === 'create');
  assert.equal(networkCreate.args.includes('--internal'), true);
  await environment.boot({ dsh, args: [], network: stub.network });
  const boot = runner.calls.filter((call) => call.args[0] === 'run').at(-1);
  assert.equal(boot.args.includes(`--network=${stub.network}`), true);
  writeFileSync(join(environment.profileDir, 'stub-seen.jsonl'), JSON.stringify({ tools: [] }) + '\n');
  await stub.sync();
  assert.equal(stub.seen.length, 1);
  await environment.destroy();
  assert.equal(runner.calls.some((call) => call.args[0] === 'network' && call.args[1] === 'rm'), true);
});

test('docker web boots stop when the ready line appears instead of waiting for the timeout', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-docker-ready-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let finishRun;
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === 'version') return { stdout: '27.0.0', stderr: '' };
    if (args[0] === 'logs') return { stdout: 'dsh web: http://127.0.0.1:5000/', stderr: '' };
    if (args[0] === 'kill') { finishRun?.(); return { stdout: '', stderr: '' }; }
    if (args[0] === 'run') return new Promise((resolve) => { finishRun = () => resolve({ stdout: '', stderr: '' }); });
    return { stdout: '', stderr: '' };
  };
  const environment = await createProbeEnvironment({ backend: 'docker', workDir: root, runner });
  const started = Date.now();
  const result = await environment.boot({ dsh, args: ['--profile', 'web'], readyRe: WEB_READY, graceMs: 1 });
  assert.equal(result.ready, true);
  assert.match(result.out, /dsh web:/);
  assert.equal(calls.some((call) => call.args[0] === 'kill'), true, 'the ready container is stopped');
  assert.ok(Date.now() - started < 5000, 'a ready boot does not wait for the environment timeout');
  await environment.destroy();
});

test('a shared dshDir is reused across environments and survives destroy', async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-shared-work-'));
  const shared = mkdtempSync(join(tmpdir(), 'dsh-shared-cache-'));
  t.after(() => {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  });
  const runner = fakeRunner(async (command, args) => ({ stdout: args[0] === 'version' ? '27.0.0' : '', stderr: '' }));
  const environment = await createProbeEnvironment({ backend: 'docker', workDir, dshDir: shared, runner });
  assert.equal(environment.dshDir, shared);
  await environment.boot({ dsh, args: ['--profile', 'headless', 'probe'] });
  const run = runner.calls.find((call) => call.args[0] === 'run');
  assert.equal(run.args.some((arg) => arg.endsWith(shared + ':/dsh:ro')), true, 'the shared tree is mounted');
  await environment.destroy();
  assert.equal(existsSync(shared), true, 'the shared harness install is not deleted with the cell');
});
