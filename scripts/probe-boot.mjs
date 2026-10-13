#!/usr/bin/env node
/**
 * Probe one plugin's host half.
 *
 *   node scripts/probe-boot.mjs <npm-package|path> [...] [--tools] [--dsh <version>] [--keep]
 *
 * Without --dsh the installed desktop app is used, which is the fastest path on
 * this machine. With --dsh <version> the CLI comes from npm and runs under plain
 * node, which is how the matrix runs on Linux CI and how a plugin author can run
 * the same probe locally.
 *
 * See docs/10-m4-verification.md and docs/11-m4-capability-probe.md for the
 * method and the failure taxonomy.
 */
import { fileURLToPath } from 'node:url';
import { probePackage, resolveDsh, startStub } from './lib/probe.mjs';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const keep = argv.includes('--keep');
const withTools = argv.includes('--tools');
const dshVersion = argOf('--dsh', undefined);
const modeArg = argOf('--mode', 'headless');
// 'both' expands the same way the matrix runner expands it, so one flag means one
// thing across the tool.
const modes = modeArg === 'both' ? ['headless', 'web'] : [modeArg];
const VALUE_FLAGS = ['--dsh', '--mode', '--cache'];
const packages = argv.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(argv[i - 1]));
if (packages.length === 0) {
  console.error('usage: node scripts/probe-boot.mjs <npm-package|path> [...] [--tools] [--dsh <version>] [--keep]');
  process.exit(2);
}

const cacheRoot = argOf('--cache', fileURLToPath(new URL('../.matrix-cache', import.meta.url)));
const dsh = await resolveDsh(dshVersion, cacheRoot);
const stub = withTools ? await startStub() : undefined;
console.log('probing with ' + dsh.id + (withTools ? ' + stub provider' : ''));

const results = [];
for (const name of packages) {
  for (const mode of modes) {
  const cell = await probePackage({ target: name, dsh, stub: mode === 'web' ? undefined : stub, tools: withTools, keep, mode });
  results.push({ package: name, mode, ...cell });
  console.log(cell.status.padEnd(16) + name + ' [' + mode + ']  (' + cell.durationMs + ' ms)');
  for (const e of cell.entries) console.log('                 ' + e.id + ': ' + e.reason);
  if (cell.tools && !cell.tools.error) {
    console.log('                 tools ' + cell.tools.baseline + ' -> ' + cell.tools.total
      + (cell.tools.added.length ? '  +' + cell.tools.added.length + ': ' + cell.tools.added.join(', ') : '  (none)'));
    console.log('                 system prompt ' + cell.systemPrompt.baselineChars + ' -> ' + cell.systemPrompt.chars + ' chars');
  }
  }
}
if (stub) stub.server.close();
console.log('\n' + JSON.stringify(results, null, 2));
