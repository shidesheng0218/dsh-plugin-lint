import { readFileSync } from 'node:fs';

const STALE_DAYS = 30;

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

function currentTime(now) {
  return typeof now === 'function' ? now() : now;
}

function withCurrentTrust(cells, { now, legacy }) {
  const time = currentTime(now);
  return (cells ?? []).map((cell) => {
    if (legacy) return { ...cell, trust: 'legacy-unpinned' };
    if (cell.trust !== 'verified') return cell;
    const ageDays = (time - Date.parse(cell.at || '')) / 86400000;
    return Number.isFinite(ageDays) && ageDays > STALE_DAYS ? { ...cell, trust: 'stale' } : cell;
  });
}

function normalizeVersion(version, options) {
  return {
    version: version.version,
    integrity: version.integrity,
    cells: withCurrentTrust(version.cells, options),
  };
}

export function loadMatrix({ indexPath, aggregatePath, now = Date.now() }) {
  const full = readJson(indexPath);
  const aggregate = readJson(aggregatePath);
  const source = full || aggregate;
  const legacy = full?.schemaVersion === 1;
  const plugins = (full?.plugins ?? []).map((plugin) => ({
    name: plugin.name,
    versions: Array.isArray(plugin.versions)
      ? plugin.versions.map((version) => normalizeVersion(version, { now, legacy }))
      : [normalizeVersion(plugin, { now, legacy })],
  }));
  const ecosystem = { versions: {} };
  if (full) {
    for (const plugin of plugins) {
      for (const version of plugin.versions) {
        for (const cell of version.cells) {
          if (!ecosystem.versions[cell.dsh]) ecosystem.versions[cell.dsh] = {};
          ecosystem.versions[cell.dsh][cell.status] = (ecosystem.versions[cell.dsh][cell.status] || 0) + 1;
        }
      }
    }
  } else if (aggregate?.versions) {
    for (const [version, tally] of Object.entries(aggregate.versions)) ecosystem.versions[version] = { ...tally };
  }
  const conflicts = full?.conflicts || {
    tools: [],
    slots: full?.slots?.clashes?.map((clash) => ({ resource: clash.slot, plugins: clash.plugins, status: 'candidate' })) || [],
    routes: [],
    verified: { tools: [], slots: [], routes: [] },
  };
  return {
    full: full ? { ...full, plugins } : undefined,
    aggregate,
    hasPerPluginData: full !== undefined,
    generatedAt: source?.generatedAt,
    sourceRunId: full?.source?.runId || aggregate?.sourceRunId,
    dshVersions: source?.dshVersions ?? [],
    plugins: full ? plugins.length : (aggregate?.plugins ?? 0),
    ecosystem,
    conflicts,
  };
}
