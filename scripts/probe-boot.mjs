#!/usr/bin/env node
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { downloadArtifact, resolveArtifact } from '../src/probe/artifact-resolver.js';
import { resolveDsh, startStub } from '../src/probe/dsh-adapter.js';
import { createProbeEnvironment } from '../src/probe/environment.js';
import { probePackage } from '../src/probe/probe.js';

const USAGE = [
  'dsh-plugin-probe — isolated host-half probe for DeepSeek Harness plugins',
  '',
  'Usage',
  '  dsh-plugin-probe <npm-package|path> [...] [options]',
  '',
  'Options',
  '  --dsh <version>       use @deepseek-ai/dsh at an exact npm version (required for the Docker backend)',
  '  --mode <mode>         headless, web, or both (default: headless)',
  '  --cache <dir>         cache root for DSH installs and temporary environments (default: system temp)',
  '  --tools               capture tool inventory through the isolated stub',
  '  --audit               include the static capability inventory',
  '  --keep                accepted for CLI compatibility; isolation is always destroyed',
  '  --unsafe-host         run the desktop DSH without isolation; results remain self-reported',
  '  -h, --help            show this message',
  '',
  'There is no silent host fallback: the Docker backend requires --dsh <version>,',
  'and the desktop DSH can only be probed with --unsafe-host.',
  '',
  'Exit codes: 0 all observations completed · 2 an infrastructure error occurred',
].join('\n');

const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) {
  console.log(USAGE);
  process.exit(0);
}
const argOf = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const keep = argv.includes('--keep');
const withTools = argv.includes('--tools');
const withAudit = argv.includes('--audit');
const backend = argv.includes('--unsafe-host') ? 'host-unsafe' : 'auto';
const dshVersion = argOf('--dsh', undefined);
const modeArg = argOf('--mode', 'headless');
if (!['headless', 'web', 'both'].includes(modeArg)) {
  console.error('dsh-plugin-probe: --mode must be headless, web, or both');
  process.exit(2);
}
const modes = modeArg === 'both' ? ['headless', 'web'] : [modeArg];
const valueFlags = ['--dsh', '--mode', '--cache'];
const packages = argv.filter((arg, index) => !arg.startsWith('--') && !valueFlags.includes(argv[index - 1]));
if (packages.length === 0) {
  console.error(USAGE);
  process.exit(2);
}

const cacheRoot = argOf('--cache', process.env.DSH_PROBE_CACHE || join(tmpdir(), 'dsh-plugin-lint-cache'));
let dsh;
try {
  dsh = dshVersion
    ? { id: 'npm:' + dshVersion, kind: 'npm', version: dshVersion, extraArgs: [] }
    : await resolveDsh(undefined, cacheRoot);
} catch (error) {
  console.error((error.code || 'PROBE_FAILED') + ': ' + (error.message || 'The DSH runtime could not be resolved.'));
  process.exit(2);
}
if (dsh.kind === 'desktop' && backend !== 'host-unsafe') {
  console.error('dsh-plugin-probe: the desktop DSH can only be probed with --unsafe-host '
    + '(no container isolation), or pass --dsh <npm-version> to use the Docker backend.');
  process.exit(2);
}
console.log('probing with ' + dsh.id + ' [' + backend + ']' + (withTools ? ' + isolated stub' : ''));

const results = [];
let failures = 0;
for (const name of packages) {
  try {
    let artifact = await resolveArtifact(name);
    if (!artifact.local) artifact = await downloadArtifact(artifact);
    for (const mode of modes) {
      const environment = await createProbeEnvironment({
        backend,
        workDir: cacheRoot,
        dshDir: dsh.kind === 'npm' && dsh.version !== 'desktop' ? join(cacheRoot, 'dsh', dsh.version) : undefined,
      });
      const stub = withTools && mode !== 'web' && backend === 'host-unsafe' ? await startStub() : undefined;
      try {
        const observation = await probePackage({ artifact, dsh, environment, stub, tools: withTools, keep, composition: mode, audit: withAudit });
        results.push({ package: name, mode, ...observation });
        if (observation.outcome === 'error') {
          failures += 1;
          console.error(`${observation.error.code}: ${observation.error.message}`);
          continue;
        }
        console.log(observation.status.padEnd(16) + name + ' [' + mode + ']  (' + observation.durationMs + ' ms)');
        for (const entry of observation.entries) console.log('                 ' + entry.id + ': ' + entry.reason);
        if (observation.tools && !observation.tools.error) {
          console.log('                 tools ' + observation.tools.baseline + ' -> ' + observation.tools.total
            + (observation.tools.added.length ? '  +' + observation.tools.added.length + ': ' + observation.tools.added.join(', ') : '  (none)'));
          console.log('                 system prompt ' + observation.systemPrompt.baselineChars + ' -> ' + observation.systemPrompt.chars + ' chars');
        }
        if (observation.audit) {
          console.log('                 audit: ' + observation.audit.observed.length + ' capabilities observed');
          for (const item of observation.audit.observed) {
            console.log('                   ' + item.capability + '  (' + item.sites + ' site' + (item.sites === 1 ? '' : 's') + ', first: ' + item.first.file + ')');
          }
        }
      } finally {
        if (stub) stub.server.close();
      }
    }
  } catch (error) {
    failures += 1;
    const code = error.code || 'PROBE_FAILED';
    const message = code === 'PROBE_FAILED' ? 'The probe could not complete.' : error.message;
    console.error(`${code}: ${message}`);
    results.push({ package: name, outcome: 'error', error: { code, message } });
  }
}

console.log('\n' + JSON.stringify(results, null, 2));
process.exitCode = failures > 0 ? 2 : 0;
