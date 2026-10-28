import { CELL_SCHEMA_VERSION, PROBE_VERSION } from '../shared/version.js';
import { ToolError } from '../shared/errors.js';
import { cacheKeyFor } from './cache.js';
import { validateCell } from './schema.js';

export function createCell(input) {
  const { artifact, dsh, observation } = input;
  const composition = input.composition || dsh.composition || observation.composition;
  const probeVersion = input.probeVersion || PROBE_VERSION;
  const cacheKey = cacheKeyFor({ artifact, dshVersion: dsh.version, composition, probeVersion });
  const cell = {
    schemaVersion: CELL_SCHEMA_VERSION,
    cacheKey,
    plugin: {
      name: artifact.name,
      requestedVersion: artifact.requestedVersion,
      resolvedVersion: artifact.resolvedVersion,
      loadedVersion: observation.loadedVersion,
      integrity: artifact.integrity,
      local: artifact.local === true,
      sourceDigest: artifact.sourceDigest,
      path: artifact.path,
      tarballUrl: artifact.tarballUrl,
    },
    dsh: { version: dsh.version, source: dsh.source || dsh.kind || 'npm', composition },
    probe: {
      version: probeVersion,
      isolation: input.isolation || observation.isolation || 'unknown',
      host: input.host || observation.host || { os: process.platform + '-' + process.arch, node: process.version },
    },
    run: {
      outcome: observation.outcome,
      at: input.at || new Date().toISOString(),
      durationMs: observation.durationMs,
      trust: input.trust || 'self-reported',
    },
    reproduce: observation.reproduce,
  };
  if (input.verification) cell.run.verification = input.verification;
  if (input.dispute) cell.run.dispute = input.dispute;
  if (observation.outcome === 'error') {
    cell.run.error = { code: observation.error.code, message: observation.error.message };
  } else {
    cell.result = observation.result;
    cell.evidence = { note: observation.note || '', outputSha256: observation.outputSha256 };
  }
  const validation = validateCell(cell);
  if (!validation.ok) throw new ToolError('CELL_INVALID', validation.errors.join('; '));
  return cell;
}

export function selectCells(cells, { dshVersion, composition } = {}) {
  const selected = cells.filter((cell) => dshVersion === undefined || cell.dsh.version === dshVersion);
  if (composition !== undefined) {
    const exact = selected.filter((cell) => cell.dsh.composition === composition);
    return { kind: exact.length > 0 ? 'cells' : 'untested', cells: exact };
  }
  if (selected.length === 0) return { kind: 'untested', cells: [] };
  const compositions = new Set(selected.map((cell) => cell.dsh.composition));
  return { kind: compositions.size > 1 ? 'mixed' : 'unknown', cells: selected };
}

export function recommendationEligible(cell, { now = Date.now(), maxAgeDays = 30 } = {}) {
  if (cell?.recommendationEligible === false || cell?.migration) return false;
  if (!validateCell(cell).ok) return false;
  if (cell.plugin.local !== false || typeof cell.plugin.integrity !== 'string') return false;
  if (cell.plugin.resolvedVersion !== cell.plugin.loadedVersion) return false;
  if (cell.run.outcome !== 'completed' || cell.run.trust !== 'verified') return false;
  if (!cell.run.verification || cell.run.verification.probeVersion !== cell.probe.version) return false;
  if (cell.result.status !== 'active') return false;
  const at = Date.parse(cell.run.at);
  const age = now - at;
  return Number.isFinite(at) && age >= 0 && age <= maxAgeDays * 24 * 60 * 60 * 1000;
}
