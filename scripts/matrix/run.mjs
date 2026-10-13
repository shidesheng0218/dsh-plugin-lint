#!/usr/bin/env node
/**
 * Run the compatibility and capability matrix.
 *
 *   node scripts/matrix/run.mjs [--targets matrix/targets.json] [--plugins a,b]
 *                               [--dsh 0.2.0-rc.2,0.2.1-alpha.2] [--concurrency 4]
 *                               [--force] [--keep] [--no-tools]
 *
 * One cell = one plugin version x one DSH version. Cells are written to
 * matrix/cells/<plugin>/<dsh>.json and an existing cell is SKIPPED unless
 * --force, so a long run can be resumed and a contributor can add a single cell.
 *
 * Every cell gets its OWN stub provider: two cells sharing one would steal each
 * other's captured requests, and the baseline diff would be meaningless.
 *
 * A cell records facts, so the run always exits 0. Read the summary, not the code.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { probePackage, resolveDsh, startStub } from '../lib/probe.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(name);

const concurrency = Number(argOf('--concurrency', '4'));
const force = has('--force');
const keep = has('--keep');
const useTools = !has('--no-tools');
// headless gives the tool inventory; web gives a faithful composition for plugins
// that need web-surface services. "both" runs each cell twice.
const modeArg = (argOf('--mode', 'both') || 'both').split(',').filter(Boolean);
const modes = modeArg.includes('both') ? ['headless', 'web'] : modeArg;
const outDir = argOf('--out', join(ROOT, 'matrix/cells'));
const cacheRoot = argOf('--cache', join(ROOT, '.matrix-cache'));

const versionsFile = JSON.parse(readFileSync(join(ROOT, 'matrix/versions.json'), 'utf8'));
const versions = (argOf('--dsh', '') || '').split(',').filter(Boolean).length
  ? argOf('--dsh', '').split(',').filter(Boolean)
  : versionsFile.versions.map((v) => v.version);

let targets;
if (argOf('--plugins', '')) {
  targets = argOf('--plugins', '').split(',').filter(Boolean).map((name) => ({ name }));
} else {
  const file = argOf('--targets', join(ROOT, 'matrix/targets.json'));
  targets = JSON.parse(readFileSync(file, 'utf8')).targets;
}
if (targets.length === 0) {
  console.error('no targets selected');
  process.exit(2);
}

const sanitize = (name) => name.replace(/^@/, '').replace(/[^a-z0-9.-]/gi, '_');
const cellPath = (name, version, mode) => join(outDir, sanitize(name), version + (mode === 'web' ? '+web' : '') + '.json');

/** Pin the artifact the way packages.json does, so a cell names an exact tarball. */
async function artifactOf(name) {
  if (existsSync(name)) return { name, version: 'local', integrity: undefined, local: true };
  try {
    const meta = await (await fetch('https://registry.npmjs.org/' + encodeURIComponent(name), { headers: { accept: 'application/vnd.npm.install-v1+json' } })).json();
    const version = meta['dist-tags']?.latest;
    return { name, version, integrity: meta.versions?.[version]?.dist?.integrity };
  } catch {
    return { name, version: undefined, integrity: undefined };
  }
}

const dshList = [];
for (const version of versions) dshList.push(await resolveDsh(version, cacheRoot));

const tasks = [];
for (const target of targets) {
  for (const dsh of dshList) {
    for (const mode of modes) tasks.push({ target, dsh, mode });
  }
}

const summary = [];
let done = 0;
async function runCell(task) {
  const { target, dsh, mode } = task;
  const path = cellPath(target.name, dsh.version, mode);
  if (!force && existsSync(path)) {
    done += 1;
    const cell = JSON.parse(readFileSync(path, 'utf8'));
    summary.push({ plugin: target.name, dsh: dsh.version, mode, status: cell.result.status, tools: cell.result.tools?.added?.length ?? 0, cached: true });
    process.stdout.write('[' + done + '/' + tasks.length + '] cached  ' + target.name + ' x ' + dsh.version + ' [' + mode + ']\n');
    return;
  }
  const artifact = await artifactOf(target.name);
  const stub = useTools && mode !== 'web' ? await startStub() : undefined;
  let cell;
  try {
    cell = await probePackage({ target: target.name, dsh, stub, tools: useTools, keep, mode });
  } catch (error) {
    cell = { status: 'boot-failed', install: 'crashed', entries: [], durationMs: 0, note: String(error.message).slice(0, 300) };
  } finally {
    if (stub) stub.server.close();
  }
  const record = {
    schemaVersion: 1,
    plugin: { name: target.name, version: artifact.version, integrity: artifact.integrity, local: artifact.local },
    dsh: { version: dsh.version, source: dsh.kind, profile: mode === 'web' ? 'web' : 'headless' },
    probe: { tool: 'dsh-plugin-lint/probe', mode, capabilities: useTools && mode !== 'web' },
    run: { at: new Date().toISOString(), durationMs: cell.durationMs, os: process.platform + '-' + process.arch, node: process.version, trust: 'verified' },
    result: {
      status: cell.status,
      composition: cell.composition,
      awaitedServices: cell.awaitedServices,
      rejection: cell.rejection,
      entries: cell.entries,
      tools: cell.tools,
      systemPrompt: cell.systemPrompt,
      packagesAdded: cell.packagesAdded,
      clientHalf: 'not-covered',
    },
    evidence: { note: cell.note, install: cell.install, installOutput: cell.installOutput },
    reproduce: { command: 'node scripts/probe-boot.mjs ' + target.name + (useTools && mode !== 'web' ? ' --tools' : '') + (mode === 'web' ? ' --mode web' : '') + ' --dsh ' + dsh.version },
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n');
  done += 1;
  summary.push({ plugin: target.name, dsh: dsh.version, mode, status: cell.status, tools: cell.tools?.added?.length ?? 0, cached: false });
  process.stdout.write('[' + done + '/' + tasks.length + '] ' + cell.status.padEnd(16) + target.name + ' x ' + dsh.version + ' [' + mode + ']'
    + '  ' + (cell.durationMs / 1000).toFixed(1) + 's'
    + (cell.tools?.added?.length ? '  +' + cell.tools.added.length + ' tools' : '') + '\n');
}

const queue = [...tasks];
const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
  while (queue.length > 0) {
    const task = queue.shift();
    await runCell(task);
  }
});
await Promise.all(workers);

const tally = {};
for (const row of summary) tally[row.status] = (tally[row.status] || 0) + 1;
console.log('\n=== summary ===');
console.log('cells: ' + summary.length + ' (' + summary.filter((r) => r.cached).length + ' cached)');
for (const [status, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log('  ' + String(n).padStart(3) + '  ' + status);
const withTools = summary.filter((r) => r.tools > 0);
if (withTools.length) console.log('registered tools: ' + withTools.map((r) => r.plugin + '(+' + r.tools + ')').join(', '));
console.log('cells written under ' + outDir);
