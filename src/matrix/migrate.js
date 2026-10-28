import { ToolError } from '../shared/errors.js';
import { TRUST } from '../shared/status.js';
import { validateCell } from './schema.js';

export function migrateCellV1(value) {
  if (!value || value.schemaVersion !== 1 || typeof value.plugin?.name !== 'string' || typeof value.plugin?.version !== 'string' || typeof value.dsh?.version !== 'string' || typeof value.result?.status !== 'string') {
    throw new ToolError('CELL_INVALID', 'The legacy cell is missing required v1 fields.');
  }
  const cell = structuredClone(value);
  const originalTrust = cell.run?.trust;
  cell.run = { ...(cell.run || {}), outcome: cell.run?.outcome || 'completed', trust: TRUST.LEGACY_UNPINNED };
  cell.plugin = {
    ...cell.plugin,
    requestedVersion: cell.plugin.requestedVersion || 'legacy',
    resolvedVersion: cell.plugin.version,
  };
  delete cell.plugin.loadedVersion;
  cell.dsh = {
    ...cell.dsh,
    composition: cell.dsh.composition || cell.result.composition || cell.dsh.profile || cell.probe?.mode || 'unknown',
  };
  cell.probe = {
    ...(cell.probe || {}),
    version: cell.probe?.version || 'legacy',
    isolation: cell.probe?.isolation || 'unknown',
    host: cell.probe?.host || { os: cell.run.os || 'unknown', node: cell.run.node || 'unknown' },
  };
  cell.recommendationEligible = false;
  cell.migration = { originalTrust };
  return cell;
}

export function readCellAny(value) {
  if (value?.schemaVersion === 2) {
    const validation = validateCell(value);
    if (!validation.ok) throw new ToolError('CELL_INVALID', validation.errors.join('; '));
    return { kind: 'v2', cell: value };
  }
  if (value?.schemaVersion === 1) return { kind: 'legacy-v1', cell: migrateCellV1(value) };
  throw new ToolError('CELL_SCHEMA_UNSUPPORTED', 'Only matrix cell schema v1 and v2 are supported.');
}
