#!/usr/bin/env node
/**
 * Fetch official @deepseek-ai packages from npm into fixtures/.
 *
 *   node scripts/fetch-official-from-npm.mjs [--limit 80] [--out fixtures]
 *
 * The asar extractor (extract-official-fixtures.mjs) needs a local DSH install,
 * which a CI runner does not have. This one only needs the registry, so the
 * zero-false-positive baseline can run anywhere.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const LIMIT = Number(argOf('--limit', '80'));
const OUT = argOf('--out', fileURLToPath(new URL('../fixtures', import.meta.url)));
const work = join(tmpdir(), 'dsh-official-npm-' + process.pid);
mkdirSync(work, { recursive: true });
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const search = await (await fetch('https://registry.npmjs.org/-/v1/search?text=@deepseek-ai/dsh&size=250')).json();
const names = [...new Set((search.objects || []).map((o) => o.package.name))]
  .filter((n) => /^@deepseek-ai\/dsh-/.test(n) && !/-(darwin|win32|linux)-/.test(n))
  .slice(0, LIMIT);
if (names.length === 0) {
  console.error('the registry search returned no @deepseek-ai/dsh-* packages');
  process.exit(2);
}

let ok = 0;
let skipped = 0;
for (const name of names) {
  try {
    const meta = await (await fetch('https://registry.npmjs.org/' + encodeURIComponent(name), { headers: { accept: 'application/vnd.npm.install-v1+json' } })).json();
    const version = meta['dist-tags'] && meta['dist-tags'].latest;
    const dist = version && meta.versions && meta.versions[version] && meta.versions[version].dist;
    if (!dist || !dist.tarball) { skipped += 1; continue; }
    const dir = join(work, name.replace(/[^a-z0-9.-]/gi, '_'));
    mkdirSync(dir, { recursive: true });
    const tgz = join(dir, 'package.tgz');
    const res = await fetch(dist.tarball);
    if (!res.ok) { skipped += 1; continue; }
    writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
    const short = name.replace('@deepseek-ai/', '');
    const dest = join(OUT, short);
    mkdirSync(dest, { recursive: true });
    execFileSync('tar', ['xf', tgz, '-C', dest, '--strip-components=1'], { stdio: 'ignore' });
    if (!existsSync(join(dest, 'package.json'))) { rmSync(dest, { recursive: true, force: true }); skipped += 1; continue; }
    ok += 1;
  } catch {
    skipped += 1;
  }
}
rmSync(work, { recursive: true, force: true });
console.log('fetched ' + ok + ' official packages (' + skipped + ' skipped) -> ' + OUT);
console.log('directories: ' + readdirSync(OUT).length);
