import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { compareVersions, parseVersion } from '../core/semver.js';
import { readCells } from './cells.js';

const REGISTRY = 'https://registry.npmjs.org/';
const CONCURRENCY = 4;

function readJson(path) {
  if (typeof path !== 'string') return undefined;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

function registryUrl(name) {
  return REGISTRY + encodeURIComponent(name);
}

async function fetchPackument(name, fetchImpl) {
  const response = await fetchImpl(registryUrl(name), {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!response || response.ok === false) throw new Error('registry returned ' + (response?.status ?? 'no response'));
  return response.json();
}

async function mapPool(items, worker, size = CONCURRENCY) {
  const results = new Array(items.length);
  let index = 0;
  async function run() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current]);
    }
  }
  const lanes = Array.from({ length: Math.min(size, items.length) }, () => run());
  await Promise.all(lanes);
  return results;
}

/** latest -> mainline, every other dist-tag -> frontier. */
function channelFor(tag) {
  return tag === 'latest' ? 'mainline' : 'frontier';
}

function coveredVersionsByPlugin(cells) {
  const map = new Map();
  for (const cell of cells) {
    const name = cell.plugin?.name;
    const version = cell.plugin?.resolvedVersion;
    if (typeof name !== 'string' || typeof version !== 'string') continue;
    if (!map.has(name)) map.set(name, new Set());
    map.get(name).add(version);
  }
  return map;
}

function newDshVersions(packument, versionsFile) {
  const known = new Set((versionsFile?.versions || []).map((entry) => entry?.version));
  const tags = packument?.['dist-tags'] || {};
  const time = packument?.time || {};
  // Dedupe: two tags can point at one version. latest wins the channel.
  const byVersion = new Map();
  for (const tag of Object.keys(tags)) {
    const version = tags[tag];
    if (typeof version !== 'string' || known.has(version)) continue;
    const channel = channelFor(tag);
    const existing = byVersion.get(version);
    if (!existing || tag === 'latest') {
      byVersion.set(version, { version, channel, publishedAt: time[version] ?? null });
    }
  }
  return [...byVersion.values()];
}

function stalePlugin(name, coveredSet, packument) {
  const latest = packument?.['dist-tags']?.latest;
  if (typeof latest !== 'string') return null;
  const covered = [...(coveredSet || [])];
  const latestParsed = parseVersion(latest);
  if (!latestParsed) return null;
  const isNewer = covered.every((version) => {
    const parsed = parseVersion(version);
    return parsed ? compareVersions(latestParsed, parsed) > 0 : true;
  });
  if (!isNewer) return null;
  const integrity = packument?.versions?.[latest]?.dist?.integrity;
  return {
    stale: { name, latest, covered },
    target: typeof integrity === 'string' ? { name, version: latest, integrity } : null,
  };
}

export async function buildQueue({
  versionsPath,
  targetsPath,
  cellsDir,
  dsh = '@deepseek-ai/dsh',
  top,
  fetchImpl = globalThis.fetch,
} = {}) {
  const versionsFile = readJson(versionsPath);
  const targetsFile = readJson(targetsPath);
  const cells = (cellsDir && existsSync(cellsDir))
    ? readCells(cellsDir).filter((e) => e.ok && e.kind !== 'run-manifest').map((e) => e.cell)
    : [];
  const covered = coveredVersionsByPlugin(cells);

  const queue = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    newDshVersions: [],
    stalePlugins: [],
    suggestedTargets: [],
    errors: [],
  };

  try {
    const dshPackument = await fetchPackument(dsh, fetchImpl);
    queue.newDshVersions = newDshVersions(dshPackument, versionsFile);
  } catch (error) {
    queue.errors.push({ name: dsh, error: error.message });
  }

  let targets = (targetsFile?.targets || []).map((t) => t?.name).filter((n) => typeof n === 'string');
  if (Number.isInteger(top) && top > 0) targets = targets.slice(0, top);

  await mapPool(targets, async (name) => {
    try {
      const packument = await fetchPackument(name, fetchImpl);
      const result = stalePlugin(name, covered.get(name), packument);
      if (result) {
        queue.stalePlugins.push(result.stale);
        if (result.target) queue.suggestedTargets.push(result.target);
      }
    } catch (error) {
      queue.errors.push({ name, error: error.message });
    }
  });

  queue.stalePlugins.sort((a, b) => a.name.localeCompare(b.name));
  return queue;
}

export function applyWriteVersions(versionsPath, newVersions) {
  const file = readJson(versionsPath);
  if (!file || !Array.isArray(file.versions)) throw new Error('versions file not found or invalid: ' + versionsPath);
  const known = new Set(file.versions.map((entry) => entry?.version));
  const additions = [];
  for (const entry of newVersions) {
    if (!entry || typeof entry.version !== 'string' || known.has(entry.version)) continue;
    known.add(entry.version);
    additions.push({ version: entry.version, channel: entry.channel, note: '' });
  }
  file.versions = [...file.versions, ...additions];
  writeFileSync(versionsPath, JSON.stringify(file, null, 2) + '\n');
  return { added: additions.length, versionsPath };
}

export function formatWatch(queue) {
  const lines = [];
  lines.push(`matrix watch · ${queue.generatedAt}`);
  lines.push('');
  lines.push(`new DSH versions: ${queue.newDshVersions.length}`);
  for (const v of queue.newDshVersions) {
    lines.push(`  ${v.version}  [${v.channel}]  ${v.publishedAt ?? 'unknown date'}`);
  }
  lines.push(`stale plugins: ${queue.stalePlugins.length}`);
  for (const p of queue.stalePlugins) {
    lines.push(`  ${p.name}  latest ${p.latest}  covered ${p.covered.join(', ') || 'none'}`);
  }
  lines.push(`suggested targets: ${queue.suggestedTargets.length}`);
  if (queue.errors.length) {
    lines.push(`errors: ${queue.errors.length}`);
    for (const e of queue.errors) lines.push(`  ${e.name}: ${e.error}`);
  }
  return lines.join('\n');
}
