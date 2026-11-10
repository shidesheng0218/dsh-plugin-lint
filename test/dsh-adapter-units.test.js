import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  execFileRunner,
  resolveDsh,
  runDsh,
  startStub,
} from '../src/probe/dsh-adapter.js';

test('execFileRunner returns stdout for a real process', async () => {
  const out = await execFileRunner(process.execPath, ['-e', 'process.stdout.write("hello")']);
  assert.equal(out.stdout, 'hello');
});

test('runDsh keeps the desktop electron flag and the isolated home', async () => {
  let received;
  const runner = async (command, args, options) => {
    received = { command, args, options };
    return { stdout: 'ok', stderr: 'warn' };
  };
  const dsh = { kind: 'desktop', node: 'electron', cli: '/app/bin.js', extraArgs: ['--expose-internals'] };
  const out = await runDsh(dsh, '/tmp/home', ['--version'], {}, { runner });
  assert.equal(out, 'okwarn');
  assert.equal(received.options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(received.options.env.DSH_HOME, '/tmp/home');
  assert.deepEqual(received.args, ['--expose-internals', '/app/bin.js', '--version']);
});

test('resolveDsh installs the harness once into a shared container directory', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-adapter-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dshDir = join(root, 'dsh');
  mkdirSync(dshDir, { recursive: true });
  let boots = 0;
  const environment = {
    isolation: 'docker',
    dshDir,
    async boot({ args, writableDsh }) {
      boots += 1;
      assert.equal(writableDsh, true);
      assert.match(args.join(' '), /@deepseek-ai\/dsh@0\.2\.0-rc\.2/);
      const cli = join(dshDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      mkdirSync(join(dshDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true });
      writeFileSync(cli, '');
      return { out: '' };
    },
  };
  const first = await resolveDsh('0.2.0-rc.2', dshDir, { environment });
  assert.equal(first.containerCli, '/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js');
  assert.equal(existsSync(join(dshDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')), true);
  const second = await resolveDsh('0.2.0-rc.2', dshDir, { environment });
  assert.equal(boots, 1, 'an existing install is reused');
  assert.equal(second.containerCli, first.containerCli);
});

test('startStub answers both JSON and streaming requests and records them', async (t) => {
  const stub = await startStub();
  t.after(() => stub.server.close());
  const base = 'http://127.0.0.1:' + stub.port;

  const plain = await fetch(base, { method: 'POST', body: JSON.stringify({ model: 'demo', messages: [] }) });
  const plainBody = await plain.json();
  assert.equal(plainBody.type, 'message');
  assert.equal(plainBody.model, 'demo');

  const stream = await fetch(base, { method: 'POST', body: JSON.stringify({ stream: true, model: 'demo' }) });
  const text = await stream.text();
  assert.match(text, /event: message_start/);
  assert.match(text, /event: message_stop/);

  assert.equal(stub.seen.length, 2);
  assert.equal(stub.seen[0].model, 'demo');
});