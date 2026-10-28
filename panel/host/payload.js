import { PANEL_PAYLOAD_SCHEMA_VERSION, validatePanelPayload } from '../shared/payload.js';

const BAD = new Set(['rejected-by-host', 'inactive-error', 'boot-failed']);

function healthFor(bundle, knownVersion, cells, profile) {
  const firstParty = bundle.name.startsWith('@deepseek-ai/');
  const exactVersion = Boolean(bundle.version && knownVersion?.version === bundle.version);
  const currentCells = exactVersion && profile.dshVersion
    ? cells.filter((cell) => cell.dsh === profile.dshVersion)
    : [];
  const compositions = new Set(currentCells.map((cell) => cell.composition));
  const cell = profile.composition
    ? currentCells.find((cell) => cell.composition === profile.composition)
    : currentCells[0];
  const statuses = new Set(currentCells.map((cell) => cell.status));
  const state = firstParty ? 'installed'
    : !bundle.version ? 'missing-install'
      : !profile.dshVersion || !exactVersion ? 'unverified'
        : currentCells.length === 0 ? 'unverified'
          : !profile.composition ? (compositions.size > 1 ? 'mixed' : 'unverified')
            : !cell ? 'unverified'
              : statuses.size > 1 ? 'mixed'
                : cell.trust === 'stale' ? 'stale'
                  : cell.trust === 'legacy-unpinned' ? 'unverified'
                    : cell.status === 'active' ? 'recorded-active'
                      : BAD.has(cell.status) ? 'recorded-failure'
                        : cell.status === 'awaiting-service' ? 'waiting' : 'mixed';
  return {
    state,
    reason: state === 'recorded-active' ? 'Historical matrix probe recorded active; runtime is not verified.' : `Health state: ${state}.`,
    evidence: cell ? { dsh: cell.dsh, pluginVersion: knownVersion.version, status: cell.status, trust: cell.trust, at: cell.at, composition: cell.composition } : undefined,
  };
}

export function createPayload({ profile, matrix, checkedAt }) {
  const byPlugin = new Map((matrix.full?.plugins ?? []).map((plugin) => [plugin.name, plugin]));
  const rows = (profile.bundles ?? []).map((bundle) => {
    const plugin = byPlugin.get(bundle.name);
    const knownVersion = plugin?.versions.find((version) => version.version === bundle.version);
    const cells = knownVersion?.cells ?? [];
    return {
      name: bundle.name,
      version: bundle.version,
      providedBy: bundle.providedBy,
      firstParty: bundle.name.startsWith('@deepseek-ai/'),
      known: knownVersion !== undefined,
      cells,
      health: healthFor(bundle, knownVersion, cells, profile),
      audit: cells.find((cell) => cell.audit)?.audit,
    };
  });
  const latest = matrix.dshVersions[matrix.dshVersions.length - 1];
  const upgrade = profile.dshVersion && latest && profile.dshVersion !== latest
    ? { running: profile.dshVersion, latest, worse: 0 }
    : undefined;
  if (upgrade && profile.composition) {
    for (const bundle of profile.bundles ?? []) {
      if (bundle.name.startsWith('@deepseek-ai/')) continue;
      const knownVersion = byPlugin.get(bundle.name)?.versions.find((version) => version.version === bundle.version);
      if (!knownVersion) continue;
      const fromCells = knownVersion.cells.filter((cell) => cell.dsh === upgrade.running && cell.composition === profile.composition);
      const toCells = knownVersion.cells.filter((cell) => cell.dsh === upgrade.latest && cell.composition === profile.composition);
      if (fromCells.length === 1 && toCells.length === 1 && !BAD.has(fromCells[0].status) && BAD.has(toCells[0].status)) upgrade.worse += 1;
    }
  }
  const installedNames = new Set((profile.bundles ?? []).map((bundle) => bundle.name));
  const selectConflicts = (entries) => (entries ?? []).filter((entry) => {
    const involved = (entry.plugins ?? []).filter((name) => installedNames.has(name));
    return new Set(involved).size > 1;
  }).map((entry) => ({ ...entry, plugins: entry.plugins.filter((name) => installedNames.has(name)) }));
  const conflicts = {
    tools: selectConflicts(matrix.conflicts.tools),
    slots: selectConflicts(matrix.conflicts.slots),
    routes: selectConflicts(matrix.conflicts.routes),
    verified: matrix.conflicts.verified,
  };
  const payload = {
    ok: true,
    schemaVersion: PANEL_PAYLOAD_SCHEMA_VERSION,
    checkedAt,
    summary: { total: rows.length, states: rows.reduce((counts, row) => { counts[row.health.state] = (counts[row.health.state] ?? 0) + 1; return counts; }, {}) },
    dsh: { version: profile.dshVersion, composition: profile.composition || null },
    profile: { dir: profile.dir, error: profile.error, composition: profile.composition || null },
    matrix: {
      generatedAt: matrix.generatedAt,
      sourceRunId: matrix.sourceRunId,
      dshVersions: matrix.dshVersions,
      plugins: matrix.plugins,
      ecosystem: matrix.ecosystem,
      hasPerPluginData: matrix.hasPerPluginData,
    },
    upgrade,
    conflicts,
    rows,
  };
  const validation = validatePanelPayload(payload);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return payload;
}
