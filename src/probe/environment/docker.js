import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { ToolError } from '../../shared/errors.js';
import { safeEnv } from '../dsh-adapter.js';

const IMAGE = 'node:22-bookworm-slim';
// node:22-bookworm-slim ships npm/npx but not pnpm, and `dsh plugin add`
// spawns pnpm from PATH. The shim is written into the writable profile mount
// and prepended to PATH; npx downloads the pinned pnpm on first use.
// pnpm 9 refuses `pnpm add` in a workspace root without -w; DSH invokes it
// without that flag, and the profile is a pnpm workspace. pnpm 11 accepts it.
const PNPM_SPEC = 'pnpm@11';
const PNPM_SHIM = '#!/bin/sh\nexec npx --yes ' + PNPM_SPEC + ' "$@"\n';
const CONTAINER_PATH = '/profile/.probe-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const STUB_SCRIPT = `
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    let body = null;
    try { body = JSON.parse(raw); } catch { body = null; }
    if (body) appendFileSync('/profile/stub-seen.jsonl', JSON.stringify(body) + '\\n');
    if (!body || !body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_probe', type: 'message', role: 'assistant', model: body?.model || 'probe', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
      return;
    }
    const sse = (event, data) => res.write('event: ' + event + '\\ndata: ' + JSON.stringify(data) + '\\n\\n');
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
server.listen(3000, '0.0.0.0', () => console.log('PROBE_STUB_READY'));
`;

export async function preflightDocker({ runner, timeoutMs = 10000 }) {
  await runner('docker', ['version', '--format', '{{.Server.Version}}'], {
    env: safeEnv(),
    timeout: timeoutMs,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
}

export function createDockerEnvironment({ workDir, sourceDir, profileDir, dshDir, timeoutMs, network, runner, materialize }) {
  const containers = new Set();
  const networks = new Set();

  // `dsh plugin add` spawns pnpm, which node:22-bookworm-slim does not ship.
  // The shim lives in the writable profile mount and is first on PATH.
  const probeBin = join(profileDir, '.probe-bin');
  mkdirSync(probeBin, { recursive: true });
  writeFileSync(join(probeBin, 'pnpm'), PNPM_SHIM, { mode: 0o755 });

  function dockerArgs(name, dsh, args, env, requestedNetwork, { writableDsh = false } = {}) {
    const networkName = requestedNetwork === 'registry' || requestedNetwork === 'bridge' ? 'bridge' : (requestedNetwork || 'none');
    const containerEnv = safeEnv({
      HOME: '/profile',
      DSH_HOME: '/profile',
      NO_COLOR: '1',
      PATH: CONTAINER_PATH,
      // The native-addon loader copies .node files into os.tmpdir() and dlopens
      // them there; Docker mounts /tmp noexec, so the copy cannot be mapped.
      // Loading straight from the read-only package tree works.
      NARB_DISABLE_NATIVE_CACHE: '1',
      ...env,
    });
    return [
      'run', '--rm', '--name', name,
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--user=1000:1000',
      '--pids-limit=128',
      '--memory=512m',
      '--cpus=1',
      `--network=${networkName}`,
      `--volume=${sourceDir}:/source:ro`,
      `--volume=${profileDir}:/profile:rw`,
      `--volume=${dshDir}:/dsh:${writableDsh ? 'rw' : 'ro'}`,
      '--tmpfs=/tmp:rw,nosuid,nodev,size=128m',
      '--workdir=/profile',
      ...Object.entries(containerEnv).map(([key, value]) => `--env=${key}=${value}`),
      IMAGE,
      dsh.containerNode || 'node',
      ...(dsh.extraArgs || []),
      dsh.containerCli || dsh.cli,
      ...args,
    ];
  }

  /**
   * Run a container until its output matches `readyRe`, then stop it.
   *
   * `execFile` cannot see the readiness line until the (long-lived) web server
   * exits, so the old code capped every web boot at 15 s: fast boots wasted the
   * whole cap and slower ones were killed and reported boot-failed. Polling
   * `docker logs` lets a ready container stop immediately and a slow one use
   * the full environment timeout. It also keeps the injected `runner` as the
   * only process boundary, so the path is testable without a daemon.
   */
  async function runUntilReady(name, argsForDocker, readyRe, { timeoutMs: limit, graceMs = 2500 } = {}) {
    const started = Date.now();
    let settled;
    const runPromise = runner('docker', argsForDocker, {
      env: safeEnv(),
      timeout: limit,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    }).then((result) => { settled = { result }; })
      .catch((error) => { settled = { error }; });
    let out = '';
    let ready = false;
    while (!settled && Date.now() - started < limit) {
      await delay(150);
      if (settled) break;
      try {
        const logs = await runner('docker', ['logs', name], { env: safeEnv(), timeout: 5000, encoding: 'utf8' });
        out = String(logs.stdout || '') + String(logs.stderr || '');
        if (readyRe.test(out)) { ready = true; break; }
      } catch { /* the container may not have started yet */ }
    }
    if (ready) await delay(graceMs);
    // Stop a running container after readiness or timeout; a natural exit makes
    // this a no-op that fails harmlessly.
    try {
      await runner('docker', ['kill', name], { env: safeEnv(), timeout: 5000, encoding: 'utf8' });
    } catch { /* already exited */ }
    await runPromise;
    const final = settled?.result || settled?.error;
    if (final) out = String(final.stdout || '') + String(final.stderr || '') || out;
    return out;
  }

  async function execute(stage, dsh, args, env, requestedNetwork, { writableDsh = false, readyRe, timeoutMs: commandTimeout, graceMs } = {}) {
    if (dsh.kind === 'desktop') {
      throw new ToolError('ISOLATION_UNSUPPORTED', 'Desktop DSH is not supported by the Docker backend.');
    }
    const name = `dsh-probe-${randomUUID()}`;
    containers.add(name);
    const argsForDocker = dockerArgs(name, dsh, args, env, requestedNetwork, { writableDsh });
    try {
      if (readyRe) {
        const out = await runUntilReady(name, argsForDocker, readyRe, {
          timeoutMs: commandTimeout ?? timeoutMs,
          graceMs,
        });
        return { stage, out, ready: readyRe.test(out) };
      }
      const result = await runner('docker', argsForDocker, {
        env: safeEnv(),
        timeout: commandTimeout ?? timeoutMs,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      });
      return { ...result, stage, out: String(result.stdout || '') + String(result.stderr || '') };
    } catch (error) {
      const out = String(error.stdout || '') + String(error.stderr || '');
      if (readyRe?.test(out)) return { stage, out, ready: true };
      throw error;
    }
  }

  return {
    backend: 'docker',
    isolation: 'docker',
    workDir,
    sourceDir,
    profileDir,
    dshDir,
    materialize,
    async install({ dsh, target, profile = 'headless', env = {} }) {
      const installTarget = typeof target === 'string' ? target : target?.installTarget;
      if (!installTarget) throw new ToolError('ARTIFACT_MISSING', 'No pinned artifact was provided for installation.');
      return execute('install', dsh, ['plugin', '--profile', profile, 'add', installTarget], env, 'registry');
    },
    async boot({ dsh, args, env = {}, network: bootNetwork, writableDsh = false, readyRe, graceMs, timeoutMs: bootTimeout }) {
      return execute('boot', dsh, args, env, bootNetwork || network, { writableDsh, readyRe, graceMs, timeoutMs: bootTimeout });
    },
    async startStub() {
      const networkName = `dsh-probe-net-${randomUUID()}`;
      const stubName = `dsh-probe-stub-${randomUUID()}`;
      writeFileSync(join(sourceDir, 'probe-stub.mjs'), STUB_SCRIPT);
      networks.add(networkName);
      await runner('docker', ['network', 'create', '--internal', networkName], { env: safeEnv(), timeout: 10000, encoding: 'utf8' });
      containers.add(stubName);
      await runner('docker', [
        'run', '-d', '--rm', '--name', stubName,
        '--network', networkName,
        '--network-alias', 'probe-stub',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--user=1000:1000',
        '--pids-limit=64',
        '--memory=256m',
        '--cpus=0.5',
        `--volume=${sourceDir}:/source:ro`,
        `--volume=${profileDir}:/profile:rw`,
        '--tmpfs=/tmp:rw,nosuid,nodev,size=64m',
        '--env=HOME=/profile',
        IMAGE,
        'node', '/source/probe-stub.mjs',
      ], { env: safeEnv(), timeout: 30000, encoding: 'utf8' });
      let ready = false;
      for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
        const result = await runner('docker', ['logs', stubName], { env: safeEnv(), timeout: 5000, encoding: 'utf8' });
        ready = String(result.stdout || '').includes('PROBE_STUB_READY');
        if (!ready) await delay(25);
      }
      if (!ready) throw new ToolError('ISOLATION_UNAVAILABLE', 'The isolated stub did not become ready.');
      const seen = [];
      let offset = 0;
      return {
        baseURL: 'http://probe-stub:3000',
        network: networkName,
        port: 3000,
        seen,
        async sync() {
          const path = join(profileDir, 'stub-seen.jsonl');
          if (!existsSync(path)) return;
          const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
          for (const line of lines.slice(offset)) {
            try { seen.push(JSON.parse(line)); } catch { /* incomplete final record */ }
          }
          offset = lines.length;
        },
      };
    },
    async destroy() {
      const removals = [...containers].map((name) => runner('docker', ['rm', '-f', name], {
        env: safeEnv(),
        timeout: 10000,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      }));
      await Promise.allSettled(removals);
      containers.clear();
      const networkRemovals = [...networks].map((name) => runner('docker', ['network', 'rm', name], {
        env: safeEnv(),
        timeout: 10000,
        encoding: 'utf8',
      }));
      await Promise.allSettled(networkRemovals);
      networks.clear();
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}
