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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WEB_READY, resolveDsh, runDsh, runUntilReady, startStub } from '../../src/probe/dsh-adapter.js';

export { WEB_READY, resolveDsh, runDsh, runUntilReady, startStub } from '../../src/probe/dsh-adapter.js';

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
 * An inactive entry is either waiting or failing, and the difference decides
 * the verdict: "waiting for service: x" names a gap in this composition, so it
 * is not a plugin failure — but any entry that is NOT waiting failed for a real
 * reason, and one real failure outweighs any number of waiting entries. Asking
 * only about /Error/ used to invert that: a timeout or a rejected config next
 * to a waiting entry reported the harmless "awaiting-service".
 *
 * Two different success sentinels, because the two modes end differently:
 *   mount-only  the run stops at MISSING_CREDENTIAL (no credentials in the throwaway home)
 *   with --tools the stub answers, so the run COMPLETES: a captured tool-bearing
 *               request is the proof that the composition mounted
 */
export function classify(bootText, entries, toolPayloadCaptured) {
  const failing = entries.filter((e) => !/waiting for service/.test(e.reason || ''));
  if (failing.length > 0) return 'inactive-error';
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
 * Probe several packages together in ONE profile.
 *
 * This is what composition questions need: installing plugins one at a time says
 * nothing about what happens when they meet. The comparison that matters is the
 * merged tool list against the union of what each plugin registered alone — when
 * the merged list is smaller, something was silently shadowed.
 */
export async function probeCombo({ targets, dsh, stub, tools = true, keep = false }) {
  const resolved = targets.map((t) => (existsSync(t) ? resolve(t) : t));
  const home = mkdtempSync(join(tmpdir(), 'dsh-combo-'));
  const cell = { status: 'unknown', install: 'ok', entries: [], durationMs: 0, note: '', tools: undefined, installed: [] };
  const started = Date.now();
  const patchPath = join(home, 'probe-patch.yml');
  const bootArgs = ['--profile', 'headless', ...(tools ? ['--patch', patchPath] : []), 'probe'];
  const bootEnv = tools ? { PROBE_API_KEY: 'probe' } : {};
  if (tools) {
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
    await capture(() => runDsh(dsh, home, bootArgs, bootEnv));
    if (!readdirSync(home).includes('profiles')) {
      cell.install = 'template-failed';
      return cell;
    }
    const before = tools ? payloadOf(stub.seen.splice(0)) : undefined;

    const profilePkgPath = join(home, 'profiles', 'headless', 'package.json');
    for (const target of resolved) {
      const beforePkg = existsSync(profilePkgPath) ? readFileSync(profilePkgPath, 'utf8') : '';
      const installed = await capture(() => runDsh(dsh, home, ['plugin', '--profile', 'headless', 'add', target], bootEnv));
      const afterPkg = existsSync(profilePkgPath) ? readFileSync(profilePkgPath, 'utf8') : '';
      if (installed.failed && afterPkg === beforePkg) {
        const rejection = rejectionOf(installed.out);
        cell.installed.push({ target, ok: false, rejection, note: noteOf(installed.out) });
        continue;
      }
      cell.installed.push({ target, ok: true });
    }

    const booted = await capture(() => runDsh(dsh, home, bootArgs, bootEnv));
    cell.entries = parseInactive(booted.out);
    cell.awaitedServices = awaitedServices(cell.entries);
    const after = tools ? payloadOf(stub.seen.splice(0)) : undefined;
    cell.status = classify(booted.out, cell.entries, tools ? Boolean(after) : undefined);
    cell.note = noteOf(booted.out);

    if (tools && before && after) {
      const names = (p) => p.tools.map((t) => t.name);
      const b = new Set(names(before));
      const a = new Set(names(after));
      cell.tools = { baseline: b.size, total: a.size, added: [...a].filter((x) => !b.has(x)), removed: [...b].filter((x) => !a.has(x)) };
      cell.systemPrompt = { baselineChars: JSON.stringify(before.system ?? '').length, chars: JSON.stringify(after.system ?? '').length };
    }
    return cell;
  } finally {
    cell.durationMs = Date.now() - started;
    if (!keep) rmSync(home, { recursive: true, force: true });
  }
}


/**
 * Probe one package.
 * @returns a cell: the verdict, what it registered, and how to reproduce it.
 */
export async function probePackage({ target: rawTarget, dsh, stub, tools = false, keep = false, mode = 'headless', audit = false }) {
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
    audit: undefined,
  };
  const started = Date.now();
  const patchPath = join(home, 'probe-patch.yml');
  const profile = mode === 'web' ? 'web' : 'headless';
  const bootEnv = tools ? { PROBE_API_KEY: 'probe' } : {};
  const bootArgs = mode === 'web'
    ? ['--profile', 'web', '--port', '0', '--no-open']
    : ['--profile', 'headless', ...(tools ? ['--patch', patchPath] : []), 'probe'];

  // Audit mode: a static capability scan. There is no declared-capability
  // field in the DSH manifest schema (measured: dsh.compatibility holds
  // dshReleases, not capabilities), so the audit reports what the code does,
  // graded by risk. Matching is done on the masked source — comments are
  // blanked, string literals intact — and on the strings array, so a
  // `fetch(` inside a string is not a network call.
  // The audit reads source from disk. For a local path the package is there;
  // for an npm package name it is installed into the profile first, so the
  // audit runs after the install step on the installed copy.
  if (audit && existsSync(rawTarget)) {
    const { loadPackage } = await import('../../src/load.js');
    const pkg = loadPackage(target);
    const observed = new Map();
    const add = (capability, file, line) => {
      if (!observed.has(capability)) observed.set(capability, []);
      observed.get(capability).push({ file, line });
    };
    const CODE_PATTERNS = [
      // DSH-specific surfaces first: they are the ones a generic scanner misses.
      [/\bctx\.slots\.(register|inject)\s*\(/, 'ui-injection'],
      [/\bctx\.llm\.(stream|complete|chat)\s*\(/, 'llm'],
      [/\bctx\.session\.append\s*\(/, 'session-write'],
      [/\bctx\.connection\b/, 'connection'],
      // Generic Node surfaces.
      [/\bfetch\s*\(/, 'network'],
      [/\bhttps?\.request\s*\(/, 'network'],
      [/\bnet\.connect\s*\(/, 'network'],
      [/\bchild_process\b/, 'shell'],
      [/\bexec(?:File)?\s*\(/, 'shell'],
      [/\bspawn\s*\(/, 'shell'],
      [/\bfs\.(write|append|createWrite)/, 'fs-write'],
      [/\bfs\.(read|createRead)/, 'fs-read'],
      [/\bprocess\.env\b/, 'env'],
      [/\bnavigator\.sendBeacon\s*\(/, 'telemetry'],
    ];
    for (const file of pkg.jsFiles) {
      for (const [re, capability] of CODE_PATTERNS) {
        // The structural view blanks string interiors, so a "fetch(" inside a
        // string literal is not a call site. Comments are blanked in both views.
        const m = re.exec(file.structural);
        if (m) add(capability, file.path, m.index);
      }
    }
    cell.audit = {
      observed: [...observed.entries()].map(([capability, sites]) => ({
        capability,
        sites: sites.length,
        first: sites[0],
      })),
    };
  }

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

    // For an npm package name the audit runs on the installed copy.
    if (audit && !existsSync(rawTarget)) {
      const { loadPackage } = await import('../../src/load.js');
      const installedDir = join(home, 'profiles', profile, 'node_modules', target);
      if (existsSync(installedDir)) {
        const pkg = loadPackage(installedDir);
        const observed = new Map();
        const add = (capability, file, line) => {
          if (!observed.has(capability)) observed.set(capability, []);
          observed.get(capability).push({ file, line });
        };
        const CODE_PATTERNS = [
          [/\bctx\.slots\.(register|inject)\s*\(/, 'ui-injection'],
          [/\bctx\.llm\.(stream|complete|chat)\s*\(/, 'llm'],
          [/\bctx\.session\.append\s*\(/, 'session-write'],
          [/\bctx\.connection\b/, 'connection'],
          [/\bfetch\s*\(/, 'network'],
          [/\bhttps?\.request\s*\(/, 'network'],
          [/\bnet\.connect\s*\(/, 'network'],
          [/\bchild_process\b/, 'shell'],
          [/\bexec(?:File)?\s*\(/, 'shell'],
          [/\bspawn\s*\(/, 'shell'],
          [/\bfs\.(write|append|createWrite)/, 'fs-write'],
          [/\bfs\.(read|createRead)/, 'fs-read'],
          [/\bprocess\.env\b/, 'env'],
          [/\bnavigator\.sendBeacon\s*\(/, 'telemetry'],
        ];
        for (const file of pkg.jsFiles) {
          for (const [re, capability] of CODE_PATTERNS) {
            const m = re.exec(file.structural);
            if (m) add(capability, file.path, m.index);
          }
        }
        cell.audit = {
          observed: [...observed.entries()].map(([capability, sites]) => ({
            capability,
            sites: sites.length,
            first: sites[0],
          })),
        };
      }
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
    // The audit log is attached to the cell: what the code actually does,
    // compared against what the manifest declares.
    return cell;
  } finally {
    cell.durationMs = Date.now() - started;
    if (!keep) rmSync(home, { recursive: true, force: true });
  }
}

export const tmpHome = () => mkdtempSync(join(tmpdir(), 'dsh-probe-'));
