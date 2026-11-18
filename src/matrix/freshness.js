import { existsSync, readFileSync } from 'node:fs';
import { readCells } from './cells.js';

const REGISTRY = 'https://registry.npmjs.org/';
const COMPOSITIONS = ['headless', 'web'];
const DAY_MS = 24 * 60 * 60 * 1000;

function readJson(path) {
  if (typeof path !== 'string' || !existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

function registryUrl(name) {
  return REGISTRY + encodeURIComponent(name).replace(/^@/, '@').replace(/%2[fF]/g, '%2f');
}

async function fetchPackument(name, fetchImpl) {
  const response = await fetchImpl(registryUrl(name), {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!response || response.ok === false) throw new Error('registry returned ' + (response?.status ?? 'no response'));
  return response.json();
}

function summarizeVersions(cells, versionsFile, now, staleDays) {
  const channelByVersion = new Map();
  for (const entry of versionsFile?.versions || []) {
    if (entry && typeof entry.version === 'string') channelByVersion.set(entry.version, entry.channel);
  }
  const grouped = new Map();
  for (const cell of cells) {
    const version = cell.dsh?.version;
    if (typeof version !== 'string') continue;
    if (!grouped.has(version)) grouped.set(version, []);
    grouped.get(version).push(cell);
  }
  const versions = [];
  for (const [version, group] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const timestamps = group.map((cell) => Date.parse(cell.run?.at)).filter(Number.isFinite);
    const newestAtMs = timestamps.length ? Math.max(...timestamps) : undefined;
    const newestAt = newestAtMs === undefined ? null : new Date(newestAtMs).toISOString();
    const ageDays = newestAtMs === undefined ? null : Math.floor((now - newestAtMs) / DAY_MS);
    const present = new Set(group.map((cell) => cell.dsh?.composition));
    versions.push({
      version,
      channel: channelByVersion.get(version) ?? null,
      cells: group.length,
      newestAt,
      ageDays,
      stale: ageDays !== null && ageDays > staleDays,
      active: group.filter((cell) => cell.result?.status === 'active').length,
      rejected: group.filter((cell) => cell.result?.status === 'rejected-by-host').length,
      errors: group.filter((cell) => cell.run?.outcome === 'error').length,
      missingCompositions: COMPOSITIONS.filter((mode) => !present.has(mode)),
    });
  }
  return versions;
}

function summarizePlugins(cells, targetsFile) {
  const targets = (targetsFile?.targets || []).map((entry) => entry?.name).filter((name) => typeof name === 'string');
  const coveredNames = new Set(cells.map((cell) => cell.plugin?.name).filter(Boolean));
  const targetSet = new Set(targets);
  const covered = targets.filter((name) => coveredNames.has(name)).length;
  const missingTargets = targets.filter((name) => !coveredNames.has(name));
  const untargetedCells = [...coveredNames].filter((name) => !targetSet.has(name)).sort();
  return { targets: targets.length, covered, missingTargets, untargetedCells };
}

async function registryDrift(fetchImpl, coveredVersions) {
  const packument = await fetchPackument('@deepseek-ai/dsh', fetchImpl);
  const tags = packument?.['dist-tags'] || {};
  const covered = new Set(coveredVersions);
  const registry = {
    latest: tags.latest ?? null,
    next: tags.next ?? null,
    alpha: tags.alpha ?? null,
    drift: [],
  };
  for (const tag of ['latest', 'next', 'alpha']) {
    const version = tags[tag];
    if (typeof version === 'string' && !covered.has(version)) {
      registry.drift.push(`${tag} ${version} not covered`);
    }
  }
  return registry;
}

export async function computeStatus({
  cellsDir,
  targetsPath,
  versionsPath,
  registry = false,
  staleDays = 14,
  now = Date.now(),
  fetchImpl = globalThis.fetch,
  dsh = '@deepseek-ai/dsh',
} = {}) {
  const entries = readCells(cellsDir).filter((entry) => entry.ok && entry.kind !== 'run-manifest');
  const cells = entries.map((entry) => entry.cell);
  const versionsFile = readJson(versionsPath);
  const targetsFile = readJson(targetsPath);
  const versions = summarizeVersions(cells, versionsFile, now, staleDays);
  const plugins = summarizePlugins(cells, targetsFile);

  let registryReport = null;
  if (registry) {
    try {
      registryReport = await registryDrift(fetchImpl, versions.map((v) => v.version));
    } catch {
      registryReport = null;
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    cellsDir,
    staleDays,
    versions,
    plugins,
    registry: registryReport,
  };
}

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

export function formatStatus(report) {
  const lines = [];
  lines.push(`matrix status · ${report.cellsDir} · stale > ${report.staleDays}d`);
  lines.push('');
  lines.push(pad('dsh version', 18) + pad('channel', 10) + pad('cells', 6) + pad('active', 7) + pad('rejected', 9) + pad('errors', 7) + pad('age', 6) + 'state');
  for (const v of report.versions) {
    const state = v.stale ? `STALE (${v.ageDays}d)` : `${v.ageDays}d`;
    lines.push(
      pad(v.version, 18)
      + pad(v.channel ?? '-', 10)
      + pad(v.cells, 6)
      + pad(v.active, 7)
      + pad(v.rejected, 9)
      + pad(v.errors, 7)
      + pad(v.ageDays === null ? '?' : v.ageDays + 'd', 6)
      + state,
    );
  }
  lines.push('');
  lines.push(`plugins: ${report.plugins.covered}/${report.plugins.targets} targets covered`
    + (report.plugins.missingTargets.length ? ` · missing: ${report.plugins.missingTargets.join(', ')}` : '')
    + (report.plugins.untargetedCells.length ? ` · untargeted: ${report.plugins.untargetedCells.join(', ')}` : ''));
  if (report.registry) {
    lines.push('');
    lines.push(`registry: latest ${report.registry.latest ?? '?'} · next ${report.registry.next ?? '?'} · alpha ${report.registry.alpha ?? '?'}`);
    for (const drift of report.registry.drift) lines.push(`  ! ${drift}`);
  } else {
    lines.push('registry: not fetched (pass --registry)');
  }
  return lines.join('\n');
}
