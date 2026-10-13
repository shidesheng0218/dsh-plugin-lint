#!/usr/bin/env node
/**
 * Host-half compatibility probe.
 *
 *   node scripts/probe-boot.mjs <npm-package> [package ...] [--keep]
 *
 * Method (verified 2026-10-13 against an installed DSH 0.2.0-rc.2):
 *
 *   1. Create a throwaway DSH_HOME and initialise a headless profile in it from
 *      the shipped template, so a probe never touches a real profile.
 *   2. Install the plugin with the dsh CLI (\`plugin add\`), which runs pnpm and
 *      selects the bundle.
 *   3. Boot the profile headless. A throwaway home has no credentials, so a
 *      successful composition always ends at MISSING_CREDENTIAL: reaching that
 *      message proves every entry mounted.
 *   4. Parse stderr. Failing to mount is a WARNING, not an error, and the process
 *      still exits 0 — the exit code alone never detects breakage.
 *
 * Status: active | inactive | install-failed | template-failed | boot-failed.
 *
 * Boundary: this exercises the HOST half only. A client half (\`dsh.client\`) is
 * loaded by the web app in a browser and never runs here; use the linter's static
 * rules, or a browser smoke test, for that.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ELECTRON = process.env.DSH_ELECTRON || '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
const CLI = process.env.DSH_CLI || '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js';
const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const packages = argv.filter((a) => !a.startsWith('--'));
if (packages.length === 0) {
  console.error('usage: node scripts/probe-boot.mjs <npm-package> [...] [--keep]');
  process.exit(2);
}

function dsh(home, args) {
  return execFileSync(ELECTRON, ['--expose-internals', CLI, ...args], {
    env: { ...process.env, DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180000,
  });
}

/** Inactive entries are listed under a "did not activate" warning, one per line. */
function parseInactive(text) {
  const out = [];
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /did not activate/.test(l));
  if (start < 0) return out;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    const m = /^(\S.*?)\s+\((\S+)\):\s*(.*)$/.exec(line);
    if (m) {
      out.push({ name: m[1], id: m[2], reason: m[3].trim() });
      continue;
    }
    if (out.length > 0 && /^\s+at /.test(line)) {
      const last = out[out.length - 1];
      last.detail = (last.detail ? last.detail + ' ' : '') + line.trim();
      continue;
    }
    if (out.length > 0) break;
  }
  return out;
}

/** The first line of output that is neither the credential sentinel nor a stack frame. */
function summaryLine(text) {
  return text.split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/MISSING_CREDENTIAL/.test(l) && !/^\s*at /.test(l))
    .slice(0, 4)
    .join(' | ')
    .slice(0, 400);
}

const capture = (fn) => {
  try { return { out: fn(), failed: false }; } catch (error) {
    return { out: String(error.stdout || '') + String(error.stderr || ''), failed: true };
  }
};

const results = [];
for (const name of packages) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-probe-'));
  const result = { package: name, status: 'unknown', install: 'ok', entries: [], ms: 0, note: '' };
  const started = Date.now();

  // 1. Materialise the profile. `headless` ships with dsh, so it cannot be a
  //    custom profile target; booting it in a throwaway DSH_HOME lays it down there.
  capture(() => dsh(home, ['--profile', 'headless', 'probe']));
  if (!readdirSync(home).includes('profiles')) {
    result.install = 'template-failed';
    results.push(result);
    console.log('template-failed ' + name);
    if (!keep) rmSync(home, { recursive: true, force: true });
    continue;
  }

  // 2. install
  const installed = capture(() => dsh(home, ['plugin', '--profile', 'headless', 'add', name]));
  if (installed.failed) {
    result.install = 'failed';
    result.status = 'install-failed';
    result.note = summaryLine(installed.out);
    results.push(result);
    console.log('install-failed  ' + name + '  ' + result.note.slice(0, 120));
    if (!keep) rmSync(home, { recursive: true, force: true });
    continue;
  }

  // 3. boot
  const booted = capture(() => dsh(home, ['--profile', 'headless', 'probe']));
  result.ms = Date.now() - started;
  result.entries = parseInactive(booted.out);
  result.note = summaryLine(booted.out);
  if (!/MISSING_CREDENTIAL/.test(booted.out)) result.status = 'boot-failed';
  else if (result.entries.length === 0) result.status = 'active';
  else result.status = 'inactive';
  results.push(result);
  if (!keep) rmSync(home, { recursive: true, force: true });

  console.log(result.status.padEnd(15) + name + '  (' + result.ms + ' ms)');
  for (const e of result.entries) console.log('                ' + e.id + ': ' + e.reason);
  if (result.status !== 'active' && result.note) console.log('                ' + result.note);
}

console.log('\n' + JSON.stringify(results, null, 2));
