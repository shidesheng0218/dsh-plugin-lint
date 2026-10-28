import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DESKTOP_ELECTRON = process.env.DSH_ELECTRON || '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
const DESKTOP_CLI = process.env.DSH_CLI || '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js';
const AMBIENT_KEYS = ['PATH', 'HOME', 'NO_COLOR', 'LANG', 'LC_ALL', 'LC_CTYPE'];
const EXPLICIT_KEYS = new Set([...AMBIENT_KEYS, 'DSH_HOME', 'ELECTRON_RUN_AS_NODE', 'PROBE_API_KEY']);

export function safeEnv(overrides = {}) {
  const env = {};
  for (const key of AMBIENT_KEYS) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (EXPLICIT_KEYS.has(key) && value !== undefined) env[key] = String(value);
  }
  return env;
}

export function execFileRunner(command, args, options = {}) {
  return execFileAsync(command, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
}

export async function resolveDsh(version, cacheRoot, { runner = execFileRunner } = {}) {
  if (!version || version === 'desktop') {
    return { id: 'desktop', kind: 'desktop', version: 'desktop', node: DESKTOP_ELECTRON, cli: DESKTOP_CLI, extraArgs: ['--expose-internals'] };
  }
  const dir = join(cacheRoot, 'dsh', version);
  const cli = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!existsSync(cli)) {
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    await runner('npm', [
      'install', '--prefix', dir, '--no-audit', '--no-fund', '--silent',
      '--cache', join(dir, 'npm-cache'), '--registry=https://registry.npmjs.org/',
      '@deepseek-ai/dsh@' + version,
    ], { env: safeEnv({ HOME: home }), timeout: 600000, maxBuffer: 16 * 1024 * 1024 });
  }
  if (!existsSync(cli)) throw new Error('dsh ' + version + ' installed but ' + cli + ' is missing');
  return { id: 'npm:' + version, kind: 'npm', version, node: process.execPath, cli, extraArgs: [] };
}

export function startStub() {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* keep null */ }
      if (body) seen.push(body);
      if (!body || !body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'msg_probe', type: 'message', role: 'assistant', model: body?.model || 'probe',
          content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }));
        return;
      }
      const sse = (event, data) => res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      sse('message_start', { type: 'message_start', message: { id: 'msg_probe', type: 'message', role: 'assistant', model: body.model || 'probe', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } });
      sse('content_block_stop', { type: 'content_block_stop', index: 0 });
      sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
      sse('message_stop', { type: 'message_stop' });
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
  });
}

export async function runDsh(dsh, home, args, env = {}, { runner = execFileRunner, timeoutMs = 180000 } = {}) {
  const { stdout, stderr } = await runner(dsh.node, [...dsh.extraArgs, dsh.cli, ...args], {
    env: safeEnv({ DSH_HOME: home, ...(dsh.kind === 'desktop' ? { ELECTRON_RUN_AS_NODE: '1' } : {}), ...env }),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return String(stdout || '') + String(stderr || '');
}

export function runUntilReady(dsh, home, args, env, readyRe, options = {}) {
  const timeoutMs = options.timeoutMs ?? 90000;
  const graceMs = options.graceMs ?? 2500;
  const spawnImpl = options.spawnImpl || spawn;
  return new Promise((resolve) => {
    const child = spawnImpl(dsh.node, [...dsh.extraArgs, dsh.cli, ...args], {
      env: safeEnv({ DSH_HOME: home, ...(dsh.kind === 'desktop' ? { ELECTRON_RUN_AS_NODE: '1' } : {}), ...env }),
      detached: process.platform !== 'win32',
    });
    let out = '';
    let finished = false;
    const signal = (name) => {
      if (child.pid && process.platform !== 'win32') {
        try { process.kill(-child.pid, name); return; } catch { /* fall back to the direct child */ }
      }
      child.kill(name);
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      signal('SIGTERM');
      setTimeout(() => signal('SIGKILL'), 1500).unref();
      resolve(out);
    };
    const feed = (chunk) => {
      out += chunk;
      if (readyRe.test(out)) setTimeout(finish, graceMs).unref();
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('exit', () => { if (!finished) { finished = true; resolve(out); } });
    setTimeout(finish, timeoutMs).unref();
  });
}

export const WEB_READY = /dsh web:\s*https?:\/\//;
