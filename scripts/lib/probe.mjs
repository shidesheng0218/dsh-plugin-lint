/**
 * Probe core: one throwaway environment, one plugin, one verdict.
 *
 * Shared by scripts/probe-boot.mjs (single package) and scripts/matrix/run.mjs
 * (a grid of plugin versions x DSH versions), so both can never drift apart.
 *
 * Two DSH sources:
 *   desktop  the installed DeepSeek Harness app (Electron reads the asar)
 *   npm      @deepseek-ai/dsh@<version> installed into a cache directory and run
 *            by plain node, which is what lets the matrix run on Linux CI
 *
 * Verified facts this file depends on (see docs/10 and docs/11):
 *   - a failing entry is a WARNING and the process still exits 0, so stderr is
 *     the signal and the exit code never is;
 *   - with no credentials in a throwaway home, reaching MISSING_CREDENTIAL means
 *     every entry mounted;
 *   - the stub provider must be served while the child runs, so children are
 *     started ASYNCHRONOUSLY (a synchronous child deadlocks the stub).
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DESKTOP_ELECTRON = process.env.DSH_ELECTRON || '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
const DESKTOP_CLI = process.env.DSH_CLI || '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js';

/** Resolve which DSH to probe. version undefined means the installed desktop app. */
export async function resolveDsh(version, cacheRoot) {
  if (!version || version === 'desktop') {
    return { id: 'desktop', kind: 'desktop', version: 'desktop', node: DESKTOP_ELECTRON, cli: DESKTOP_CLI, extraArgs: ['--expose-internals'] };
  }
  const dir = join(cacheRoot, 'dsh', version);
  const cli = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!existsSync(cli)) {
    mkdirSync(dir, { recursive: true });
    await execFileAsync('npm', ['install', '--prefix', dir, '--no-audit', '--no-fund', '--silent', '@deepseek-ai/dsh@' + version], { timeout: 600000, maxBuffer: 16 * 1024 * 1024 });
  }
  if (!existsSync(cli)) throw new Error('dsh ' + version + ' installed but ' + cli + ' is missing');
  return { id: 'npm:' + version, kind: 'npm', version, node: process.execPath, cli, extraArgs: [] };
}

/** A minimal Anthropic-Messages endpoint that records what the harness sends. */
export function startStub() {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
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
  return new Promise((resolve_) => {
    server.listen(0, '127.0.0.1', () => resolve_({ server, seen, port: server.address().port }));
  });
}

/** Run the CLI asynchronously; the stub lives in this process and must stay responsive. */
export async function runDsh(dsh, home, args, env = {}) {
  const { stdout, stderr } = await execFileAsync(dsh.node, [...dsh.extraArgs, dsh.cli, ...args], {
    env: { ...process.env, DSH_HOME: home, ...(dsh.kind === 'desktop' ? { ELECTRON_RUN_AS_NODE: '1' } : {}), ...env },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 180000,
  });
  return stdout + stderr;
}

/**
 * Run a long-lived profile until it reports readiness, then stop it.
 *
 * The web profile serves until killed, so readiness is a sentinel line rather
 * than an exit: "dsh web: http://127.0.0.1:<port>/?token=…". We stop as soon as
 * it appears (plus a short grace period) because a mounted plugin may start doing
 * work of its own — measured: dsh-pet began downloading a 116 MB Electron.
 */
export function runUntilReady(dsh, home, args, env, readyRe, options = {}) {
  const timeoutMs = options.timeoutMs ?? 90000;
  const graceMs = options.graceMs ?? 2500;
  return new Promise((resolve) => {
    const child = spawn(dsh.node, [...dsh.extraArgs, dsh.cli, ...args], {
      env: { ...process.env, DSH_HOME: home, ...(dsh.kind === 'desktop' ? { ELECTRON_RUN_AS_NODE: '1' } : {}), ...env },
    });
    let out = '';
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1500).unref();
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

/** Readiness sentinel of the web profile. */
export const WEB_READY = /dsh web:\s*https?:\/\//;

export async function capture(fn) {
  try { return { out: await fn(), failed: false }; } catch (error) {
    return { out: String(error.stdout || '') + String(error.stderr || ''), failed: true };
  }
}

/** An ephemeral localhost token from the web readiness line never belongs in a cell. */
const redact = (s) => String(s).replace(/token=[^\s&"']+/gi, 'token=<redacted>');

/** Inactive entries are listed under a "did not activate" warning, one per line. */
export function parseInactive(text) {
  const out = [];
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /did not activate/.test(l));
  if (start < 0) return out;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(\S.*?)\s+\((\S+)\):\s*(.*)$/.exec(lines[i]);
    if (m) { out.push({ name: m[1], id: m[2], reason: m[3].trim() }); continue; }
    if (out.length > 0 && /^\s+at /.test(lines[i])) {
      const last = out[out.length - 1];
      last.detail = (last.detail ? last.detail + ' ' : '') + lines[i].trim();
      continue;
    }
    if (out.length > 0) break;
  }
  return out;
}

/**
 * Map raw probe output to the verdict vocabulary. install-failed is never a
 * plugin verdict.
 *
 * Two different success sentinels, because the two modes end differently:
 *   mount-only  the run stops at MISSING_CREDENTIAL (no credentials in the throwaway home)
 *   with --tools the stub answers, so the run COMPLETES: a captured tool-bearing
 *               request is the proof that the composition mounted
 */
export function classify(bootText, entries, toolPayloadCaptured) {
  if (entries.some((e) => /Error/.test(e.reason))) return 'inactive-error';
  // "awaiting-service" is NOT a failure. Measured on 2026-10-13: every pending
  // plugin in the smoke sample was waiting for a service the headless profile does
  // not provide (webServer, connection, agentPresets), so this verdict says
  // "cannot be tested in this composition", not "broken".
  if (entries.length > 0) return 'awaiting-service';
  if (toolPayloadCaptured === true) return 'active';
  if (toolPayloadCaptured === false) return 'boot-failed';
  return /MISSING_CREDENTIAL/.test(bootText) ? 'active' : 'boot-failed';
}

/** The services a pending entry is waiting for, so a reader can judge the reason. */
export function awaitedServices(entries) {
  const out = [];
  for (const entry of entries) {
    const m = /waiting for service:\s*([^)\s]+)/.exec(entry.reason || '');
    if (m) out.push(m[1]);
  }
  return [...new Set(out)];
}

/**
 * The host refuses some installs itself, with the DSH version named in the
 * reason. That is a stronger verdict than anything this probe can produce, so it
 * gets its own status rather than being filed as an environment failure.
 */
export function rejectionOf(installText) {
  const m = /installation rejected:\s*([^\n]+)/.exec(installText);
  return m ? m[1].trim().slice(0, 400) : undefined;
}

export function noteOf(text) {
  return redact(text).split('\n').map((l) => l.trim())
    .filter((l) => l && !/MISSING_CREDENTIAL/.test(l) && !/^at /.test(l))
    .slice(0, 3).join(' | ').slice(0, 300);
}

const payloadOf = (seen) => seen.filter((b) => Array.isArray(b.tools)).pop();

/**
 * Probe one package.
 * @returns a cell: the verdict, what it registered, and how to reproduce it.
 */
export async function probePackage({ target: rawTarget, dsh, stub, tools = false, keep = false, mode = 'headless' }) {
  const target = existsSync(rawTarget) ? resolve(rawTarget) : rawTarget;
  const home = mkdtempSync(join(tmpdir(), 'dsh-probe-'));
  const cell = {
    status: 'unknown',
    install: 'ok',
    entries: [],
    durationMs: 0,
    note: '',
    composition: mode,
    tools: undefined,
    systemPrompt: undefined,
    packagesAdded: undefined,
  };
  const started = Date.now();
  const patchPath = join(home, 'probe-patch.yml');
  const profile = mode === 'web' ? 'web' : 'headless';
  const bootEnv = tools ? { PROBE_API_KEY: 'probe' } : {};
  const bootArgs = mode === 'web'
    ? ['--profile', 'web', '--port', '0', '--no-open']
    : ['--profile', 'headless', ...(tools ? ['--patch', patchPath] : []), 'probe'];

  if (tools && mode !== 'web') {
    writeFileSync(patchPath, [
      '- id: llm-deepseek',
      '  name: "@deepseek-ai/dsh-llm-deepseek-api-key"',
      '  config:',
      '    baseURL: http://127.0.0.1:' + stub.port,
      '    apiKeyEnv: PROBE_API_KEY',
      '',
    ].join('\n'));
  }

  try {
    // 1. lay the profile down and capture the baseline the plugin is measured against
    const baseline = mode === 'web'
      ? await runUntilReady(dsh, home, bootArgs, bootEnv, WEB_READY, { timeoutMs: 60000, graceMs: 1200 })
      : await capture(() => runDsh(dsh, home, bootArgs, bootEnv)).then((r) => r.out);
    void baseline;
    if (!readdirSync(home).includes('profiles')) {
      cell.install = 'template-failed';
      return cell;
    }
    const before = tools && mode !== 'web' ? payloadOf(stub.seen.splice(0)) : undefined;

    // 2. install. The exit code is NOT the artifact: measured on 2026-10-13, a 200-cell
    //    run recorded 26 install failures whose profile package.json had in fact been
    //    updated and whose plugin was on disk. A non-zero exit is only believed after
    //    the profile has been inspected.
    const profilePkgPath = join(home, 'profiles', profile, 'package.json');
    const beforePkg = existsSync(profilePkgPath) ? readFileSync(profilePkgPath, 'utf8') : '';
    const installed = await capture(() => runDsh(dsh, home, ['plugin', '--profile', profile, 'add', target], bootEnv));
    if (installed.failed) {
      const rejection = rejectionOf(installed.out);
      const afterPkg = existsSync(profilePkgPath) ? readFileSync(profilePkgPath, 'utf8') : '';
      const landed = afterPkg !== beforePkg && afterPkg.length > 0;
      if (rejection && !landed) {
        cell.status = 'rejected-by-host';
        cell.rejection = rejection;
        cell.note = noteOf(installed.out);
        return cell;
      }
      if (!landed) {
        cell.install = 'failed';
        cell.status = 'install-failed';
        cell.note = noteOf(installed.out);
        cell.installOutput = redact(installed.out).slice(-700);
        return cell;
      }
      // The plugin landed, so the non-zero exit was noise (peer-dependency warnings).
      cell.install = 'ok-with-warnings';
      cell.installOutput = noteOf(installed.out);
    }

    // 3. boot again and read what changed
    const booted = mode === 'web'
      ? { out: await runUntilReady(dsh, home, bootArgs, bootEnv, WEB_READY, { timeoutMs: 90000, graceMs: 2500 }), failed: false }
      : await capture(() => runDsh(dsh, home, bootArgs, bootEnv));
    if (mode === 'web') cell.ready = WEB_READY.test(booted.out);
    cell.entries = parseInactive(booted.out);
    cell.awaitedServices = awaitedServices(cell.entries);
    const after = tools && mode !== 'web' ? payloadOf(stub.seen.splice(0)) : undefined;
    cell.status = mode === 'web'
      ? (cell.entries.some((e) => /Error/.test(e.reason)) ? 'inactive-error'
        : cell.entries.length > 0 ? 'awaiting-service'
        : cell.ready ? 'active' : 'boot-failed')
      : classify(booted.out, cell.entries, tools ? Boolean(after) : undefined);
    cell.note = noteOf(booted.out);

    // Web mode has no task to run, so there is no model request to read tools from.
    if (tools && mode !== 'web') {
      if (before && after) {
        const names = (p) => p.tools.map((t) => t.name);
        const b = new Set(names(before));
        const a = new Set(names(after));
        cell.tools = { baseline: b.size, total: a.size, added: [...a].filter((x) => !b.has(x)), removed: [...b].filter((x) => !a.has(x)) };
        cell.systemPrompt = { baselineChars: JSON.stringify(before.system ?? '').length, chars: JSON.stringify(after.system ?? '').length };
        const pkgs = (p) => new Set((p.dsh_plugin_packages?.packages ?? []).map((x) => x.name + '@' + x.version));
        const pb = pkgs(before);
        cell.packagesAdded = [...pkgs(after)].filter((x) => !pb.has(x));
      } else {
        cell.tools = { error: 'the harness sent no tool-bearing request' };
      }
    }
    return cell;
  } finally {
    cell.durationMs = Date.now() - started;
    if (!keep) rmSync(home, { recursive: true, force: true });
  }
}

export const tmpHome = () => mkdtempSync(join(tmpdir(), 'dsh-probe-'));
