import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPackage } from '../core/load.js';
import { lineOfIndex } from '../core/mask.js';
import { sha256 } from '../shared/hash.js';
import { ToolError } from '../shared/errors.js';
import { downloadArtifact } from './artifact-resolver.js';
import { classify } from './classify.js';
import { readInstalledArtifact } from './installed-artifact.js';
import { WEB_READY, resolveDsh, startStub } from './dsh-adapter.js';

export async function capture(fn) {
  try {
    const result = await fn();
    const out = typeof result === 'string'
      ? result
      : result?.out !== undefined
        ? String(result.out)
        : String(result?.stdout || '') + String(result?.stderr || '');
    return { out, failed: false };
  } catch (error) {
    return { out: String(error.stdout || '') + String(error.stderr || ''), failed: true, error };
  }
}

export const redact = (value) => String(value).replace(/token=[^\s&"']+/gi, 'token=<redacted>');

export function parseInactive(text) {
  const out = [];
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /did not activate/.test(line));
  if (start < 0) return out;
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = /^(\S.*?)\s+\((\S+)\):\s*(.*)$/.exec(lines[index]);
    if (match) {
      out.push({ name: match[1], id: match[2], reason: match[3].trim() });
      continue;
    }
    if (out.length > 0 && /^\s+at /.test(lines[index])) {
      const last = out[out.length - 1];
      last.detail = (last.detail ? last.detail + ' ' : '') + lines[index].trim();
      continue;
    }
    if (out.length > 0) break;
  }
  return out;
}

export function awaitedServices(entries) {
  const services = [];
  for (const entry of entries) {
    // The host prints "waiting for service: x" for one and "waiting for
    // services: x, y" for several; both must reach the cell.
    const match = /waiting for services?:\s*([^)]+)/.exec(entry.reason || '');
    if (!match) continue;
    for (const name of match[1].split(',')) {
      const service = name.trim();
      if (service) services.push(service);
    }
  }
  return [...new Set(services)];
}

export function rejectionOf(installText) {
  const match = /installation rejected:\s*([^\n]+)/.exec(installText);
  return match ? match[1].trim().slice(0, 400) : undefined;
}

export function noteOf(text) {
  return redact(text).split('\n').map((line) => line.trim())
    .filter((line) => line && !/MISSING_CREDENTIAL/.test(line) && !/^at /.test(line))
    .slice(0, 3).join(' | ').slice(0, 300);
}

export const payloadOf = (seen) => seen.filter((body) => Array.isArray(body.tools)).pop();

async function prepareDsh(dsh, environment) {
  if (dsh.kind === 'desktop') {
    if (environment.isolation === 'docker') {
      throw new ToolError('ISOLATION_UNSUPPORTED', 'Desktop DSH is not supported by the Docker backend.');
    }
    return dsh;
  }
  if (!dsh.cli || (environment.isolation === 'docker' && !dsh.containerCli)) {
    return resolveDsh(dsh.version, environment.dshDir, { environment });
  }
  return dsh;
}

function scanCapabilities(dir) {
  const pkg = loadPackage(dir);
  const observed = new Map();
  const patterns = [
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
    for (const [pattern, capability] of patterns) {
      const match = pattern.exec(file.structural);
      if (!match) continue;
      if (!observed.has(capability)) observed.set(capability, []);
      observed.get(capability).push({ file: file.path, line: lineOfIndex(file.lineStarts, match.index) });
    }
  }
  return { observed: [...observed.entries()].map(([capability, sites]) => ({ capability, sites: sites.length, first: sites[0] })) };
}

function toolDiff(before, after) {
  const names = (payload) => payload.tools.map((tool) => tool.name);
  const baseline = new Set(names(before));
  const current = new Set(names(after));
  return {
    tools: { baseline: baseline.size, total: current.size, added: [...current].filter((name) => !baseline.has(name)), removed: [...baseline].filter((name) => !current.has(name)) },
    systemPrompt: { baselineChars: JSON.stringify(before.system ?? '').length, chars: JSON.stringify(after.system ?? '').length },
    packagesAdded: [...new Set((after.dsh_plugin_packages?.packages ?? []).map((pkg) => pkg.name + '@' + pkg.version))]
      .filter((name) => !new Set((before.dsh_plugin_packages?.packages ?? []).map((pkg) => pkg.name + '@' + pkg.version)).has(name)),
  };
}

function publicError(error) {
  return {
    code: error?.code || 'PROBE_FAILED',
    message: error instanceof ToolError ? error.message : 'The probe could not complete because of an internal or host failure.',
  };
}

export async function probePackage({
  artifact: inputArtifact,
  dsh: inputDsh,
  environment,
  stub: inputStub,
  tools = false,
  keep = false,
  composition = 'headless',
  audit = false,
}) {
  const started = Date.now();
  const observation = { outcome: 'completed', install: 'ok', entries: [], durationMs: 0 };
  let stub = inputStub;
  let ownsStub = false;
  try {
    const dsh = await prepareDsh(inputDsh, environment);
    const artifact = inputArtifact.local || inputArtifact.tarballPath ? inputArtifact : await downloadArtifact(inputArtifact);
    const materialized = await environment.materialize(artifact);
    if (tools && composition !== 'web' && !stub) {
      stub = environment.startStub ? await environment.startStub() : await startStub();
      ownsStub = true;
    }
    const profile = composition === 'web' ? 'web' : 'headless';
    const bootEnv = tools && stub ? { PROBE_API_KEY: 'probe' } : {};
    const patchPath = environment.isolation === 'docker' ? '/profile/probe-patch.yml' : join(environment.profileDir, 'probe-patch.yml');
    if (tools && stub) {
      const baseURL = stub.baseURL || `http://127.0.0.1:${stub.port}`;
      writeFileSync(join(environment.profileDir, 'probe-patch.yml'), [
        '- id: llm-deepseek',
        '  name: "@deepseek-ai/dsh-llm-deepseek-api-key"',
        '  config:',
        `    baseURL: ${baseURL}`,
        '    apiKeyEnv: PROBE_API_KEY',
        '',
      ].join('\n'));
    }
    const bootArgs = composition === 'web'
      ? ['--profile', 'web', '--port', '0', '--no-open']
      : ['--profile', 'headless', ...(tools ? ['--patch', patchPath] : []), 'probe'];
    const bootInput = {
      dsh,
      args: bootArgs,
      env: bootEnv,
      composition,
      readyRe: composition === 'web' ? WEB_READY : undefined,
      network: composition !== 'web' && stub?.network ? stub.network : undefined,
    };
    const baseline = await capture(() => environment.boot(bootInput));
    let booted;
    if (!readdirSync(environment.profileDir).includes('profiles')) {
      throw new ToolError('TEMPLATE_FAILED', 'DSH did not create a temporary profile.');
    }
    if (stub?.sync) await stub.sync();
    const before = tools && composition !== 'web' ? payloadOf(stub.seen.splice(0)) : undefined;

    const installed = await capture(() => environment.install({ dsh, target: materialized, profile, env: bootEnv }));
    const rejection = rejectionOf(installed.out);
    const profileDir = join(environment.profileDir, 'profiles', profile);
    let installedArtifact;
    try {
      installedArtifact = readInstalledArtifact(profileDir, artifact.name);
    } catch (error) {
      if (!rejection) throw error;
    }
    if (installedArtifact && installedArtifact.version !== artifact.resolvedVersion) {
      throw new ToolError('VERSION_MISMATCH', 'The installed artifact version differs from the pinned artifact.');
    }
    observation.loadedVersion = installedArtifact?.version;
    if (installed.failed) observation.install = 'ok-with-warnings';
    if (rejection) {
      observation.result = {
        status: 'rejected-by-host',
        composition,
        rejection,
        entries: [],
        awaitedServices: [],
        clientHalf: 'not-covered',
      };
    } else {
      booted = await capture(() => environment.boot(bootInput));
      if (stub?.sync) await stub.sync();
      const entries = parseInactive(booted.out);
      const after = tools && composition !== 'web' ? payloadOf(stub.seen.splice(0)) : undefined;
      const ready = composition === 'web' ? WEB_READY.test(booted.out) : undefined;
      const status = classify(booted.out, entries, composition === 'web' ? ready : (tools ? Boolean(after) : undefined));
      const diff = before && after ? toolDiff(before, after) : undefined;
      const auditResult = audit ? scanCapabilities(artifact.local ? materialized.hostPath : (installedArtifact?.path || materialized.hostPath)) : undefined;
      observation.result = {
        status,
        composition,
        ready,
        awaitedServices: awaitedServices(entries),
        entries,
        tools: diff?.tools || (tools && composition !== 'web' ? { error: 'the harness sent no tool-bearing request' } : undefined),
        systemPrompt: diff?.systemPrompt,
        packagesAdded: diff?.packagesAdded,
        audit: auditResult,
        clientHalf: 'not-covered',
      };
    }
    observation.entries = observation.result.entries;
    observation.audit = observation.result.audit;
    observation.tools = observation.result.tools;
    observation.systemPrompt = observation.result.systemPrompt;
    observation.packagesAdded = observation.result.packagesAdded;
    observation.status = observation.result.status;
    observation.composition = composition;
    observation.note = noteOf(booted?.out || baseline.out);
    observation.outputSha256 = sha256(installed.out + '\n' + (booted?.out || baseline.out));
    observation.reproduce = {
      command: `node scripts/probe-boot.mjs ${artifact.installTarget}${tools ? ' --tools' : ''}${composition === 'web' ? ' --mode web' : ''} --dsh ${dsh.version}${environment.isolation === 'host-unsafe' ? ' --unsafe-host' : ''}`,
    };
    if (installed.failed) observation.installOutput = redact(installed.out).slice(-700);
  } catch (error) {
    observation.outcome = 'error';
    observation.error = publicError(error);
    observation.result = undefined;
  } finally {
    observation.durationMs = Date.now() - started;
    try {
      await environment.destroy();
    } catch (error) {
      // Cleanup failure is an infrastructure note, not a plugin verdict. A
      // completed observation keeps its result; an earlier error keeps its code.
      observation.cleanup = {
        code: 'ISOLATION_CLEANUP_FAILED',
        message: 'The probe environment could not be cleaned up.',
      };
    }
    if (ownsStub && stub?.server) stub.server.close();
    void keep;
  }
  return observation;
}
