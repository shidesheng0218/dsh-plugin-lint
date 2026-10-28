import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WEB_READY, resolveDsh, runDsh, runUntilReady, startStub } from '../../src/probe/dsh-adapter.js';
import { resolveArtifact } from '../../src/probe/artifact-resolver.js';
import { classify } from '../../src/probe/classify.js';
import { createProbeEnvironment } from '../../src/probe/environment.js';
import {
  capture,
  parseInactive,
  awaitedServices,
  rejectionOf,
  noteOf,
  payloadOf,
  probePackage as probePinnedPackage,
} from '../../src/probe/probe.js';

export { WEB_READY, resolveDsh, runDsh, runUntilReady, startStub } from '../../src/probe/dsh-adapter.js';
export { classify } from '../../src/probe/classify.js';
export {
  capture,
  redact,
  parseInactive,
  awaitedServices,
  rejectionOf,
  noteOf,
  payloadOf,
} from '../../src/probe/probe.js';

export async function probeCombo({ targets, dsh, stub, tools = true, keep = false }) {
  const resolved = targets.map((target) => (existsSync(target) ? resolve(target) : target));
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
      const names = (payload) => payload.tools.map((tool) => tool.name);
      const baseline = new Set(names(before));
      const current = new Set(names(after));
      cell.tools = { baseline: baseline.size, total: current.size, added: [...current].filter((name) => !baseline.has(name)), removed: [...baseline].filter((name) => !current.has(name)) };
      cell.systemPrompt = { baselineChars: JSON.stringify(before.system ?? '').length, chars: JSON.stringify(after.system ?? '').length };
    }
    return cell;
  } finally {
    cell.durationMs = Date.now() - started;
    if (!keep) rmSync(home, { recursive: true, force: true });
  }
}

export async function probePackage(options) {
  const artifact = options.artifact || await resolveArtifact(options.target);
  const environment = options.environment || await createProbeEnvironment({
    backend: options.backend || 'auto',
    workDir: options.workDir,
  });
  return probePinnedPackage({
    ...options,
    artifact,
    environment,
    composition: options.composition || options.mode || 'headless',
  });
}

export const tmpHome = () => mkdtempSync(join(tmpdir(), 'dsh-probe-'));
