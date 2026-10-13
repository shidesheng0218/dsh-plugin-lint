#!/usr/bin/env node
/**
 * Host-half compatibility and capability probe.
 *
 *   node scripts/probe-boot.mjs <npm-package|local-path> [...] [--tools] [--keep]
 *
 * Method (verified 2026-10-13 against an installed DSH 0.2.0-rc.2):
 *
 *   1. Create a throwaway DSH_HOME and lay the shipped \`headless\` profile down in
 *      it, so a probe never touches a real profile.
 *   2. Boot it once for a baseline. With \`--tools\`, a stub provider stands in for
 *      the model: the harness sends its real request, and the payload carries the
 *      model-visible tool list, the system prompt, and \`dsh_plugin_packages\`.
 *   3. Install the plugin through the dsh CLI and boot again.
 *   4. Report the mount status plus, with \`--tools\`, exactly what the plugin added.
 *
 * Mount failures are WARNINGS and the process still exits 0, so the exit code is
 * never the signal — stderr is.
 *
 * Status: active | inactive | install-failed | template-failed | boot-failed.
 *
 * Boundary: the HOST half only. A client half (\`dsh.client\`) is loaded by the web
 * app in a browser and never runs here; use the linter's static rules for that.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const ELECTRON = process.env.DSH_ELECTRON || '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
const CLI = process.env.DSH_CLI || '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js';
const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const withTools = argv.includes('--tools');
const packages = argv.filter((a) => !a.startsWith('--'));
if (packages.length === 0) {
  console.error('usage: node scripts/probe-boot.mjs <npm-package|path> [...] [--tools] [--keep]');
  process.exit(2);
}

/** A minimal Anthropic-Messages endpoint that records what the harness sends. */
function startStub() {
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
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
  });
}

/**
 * Run the CLI. This is deliberately ASYNC: the stub provider lives in this
 * process, so a synchronous child would block the event loop and the child would
 * wait forever for a response that can never arrive (measured: a 6-minute retry
 * storm instead of a 7-second probe).
 */
async function dsh(home, args, env) {
  const { stdout, stderr } = await execFileAsync(ELECTRON, ['--expose-internals', CLI, ...args], {
    env: { ...process.env, DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1', ...env },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 180000,
  });
  return stdout + stderr;
}

const capture = async (fn) => {
  try { return { out: await fn(), failed: false }; } catch (error) {
    return { out: String(error.stdout || '') + String(error.stderr || ''), failed: true };
  }
};

/** Inactive entries are listed under a "did not activate" warning, one per line. */
function parseInactive(text) {
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

const payloadOf = (seen) => seen.filter((b) => Array.isArray(b.tools)).pop();

async function probe(name, stub) {
  // A local directory must be absolute: the install runs with the profile as cwd.
  const target = existsSync(name) ? resolve(name) : name;
  const home = mkdtempSync(join(tmpdir(), 'dsh-probe-'));
  const result = { package: name, status: 'unknown', install: 'ok', entries: [], ms: 0, note: '' };
  const started = Date.now();
  const patchPath = join(home, 'probe-patch.yml');
  const bootArgs = (extra = []) => ['--profile', 'headless', ...(withTools ? ['--patch', patchPath] : []), ...extra];
  const bootEnv = withTools ? { PROBE_API_KEY: 'probe' } : {};

  if (withTools) {
    writeFileSync(patchPath, [
      '- id: llm-deepseek',
      '  name: "@deepseek-ai/dsh-llm-deepseek-api-key"',
      '  config:',
      '    baseURL: http://127.0.0.1:' + stub.port,
      '    apiKeyEnv: PROBE_API_KEY',
      '',
    ].join('\n'));
  }

  // 1. lay the profile down, and capture the baseline the plugin will be measured against
  await capture(() => dsh(home, bootArgs(['probe']), bootEnv));
  if (!readdirSync(home).includes('profiles')) {
    result.install = 'template-failed';
    if (!keep) rmSync(home, { recursive: true, force: true });
    return result;
  }
  const before = withTools ? payloadOf(stub.seen.splice(0)) : undefined;

  // 2. install
  const installed = await capture(() => dsh(home, ['plugin', '--profile', 'headless', 'add', target], bootEnv));
  if (installed.failed) {
    result.install = 'failed';
    result.status = 'install-failed';
    result.note = installed.out.split('\n').map((l) => l.trim())
      .filter((l) => l && !/^at /.test(l)).slice(-2).join(' | ').slice(0, 300);
    if (!keep) rmSync(home, { recursive: true, force: true });
    return result;
  }

  // 3. boot again and read what changed
  const booted = await capture(() => dsh(home, bootArgs(['probe']), bootEnv));
  result.ms = Date.now() - started;
  result.entries = parseInactive(booted.out);
  result.note = booted.out.split('\n').map((l) => l.trim())
    .filter((l) => l && !/MISSING_CREDENTIAL/.test(l) && !/^\s*at /.test(l)).slice(0, 3).join(' | ').slice(0, 300);
  if (!/MISSING_CREDENTIAL/.test(booted.out) && !withTools) result.status = 'boot-failed';
  else if (result.entries.length === 0) result.status = 'active';
  else result.status = 'inactive';

  if (withTools) {
    const after = payloadOf(stub.seen.splice(0));
    if (before && after) {
      const toolNames = (p) => p.tools.map((t) => t.name);
      const b = new Set(toolNames(before));
      const a = new Set(toolNames(after));
      result.tools = { baseline: b.size, total: a.size, added: [...a].filter((x) => !b.has(x)), removed: [...b].filter((x) => !a.has(x)) };
      result.systemPrompt = { baselineChars: JSON.stringify(before.system ?? '').length, chars: JSON.stringify(after.system ?? '').length };
      const pkgs = (p) => new Set((p.dsh_plugin_packages?.packages ?? []).map((x) => x.name + '@' + x.version));
      const pb = pkgs(before);
      result.packagesAdded = [...pkgs(after)].filter((x) => !pb.has(x));
    } else {
      result.tools = { error: 'the harness sent no tool-bearing request; the run may not have reached the model' };
    }
  }
  if (!keep) rmSync(home, { recursive: true, force: true });
  return result;
}

const stub = withTools ? await startStub() : undefined;
const results = [];
for (const name of packages) {
  const result = await probe(name, stub);
  results.push(result);
  console.log(result.status.padEnd(15) + name + '  (' + result.ms + ' ms)');
  for (const e of result.entries) console.log('                ' + e.id + ': ' + e.reason);
  if (result.tools && !result.tools.error) {
    console.log('                tools ' + result.tools.baseline + ' -> ' + result.tools.total
      + (result.tools.added.length ? '  +' + result.tools.added.length + ': ' + result.tools.added.join(', ') : '  (none)'));
    console.log('                system prompt ' + result.systemPrompt.baselineChars + ' -> ' + result.systemPrompt.chars + ' chars');
  }
  if (result.status === 'install-failed' && result.note) console.log('                ' + result.note.slice(0, 200));
}
if (stub) stub.server.close();
console.log('\n' + JSON.stringify(results, null, 2));
