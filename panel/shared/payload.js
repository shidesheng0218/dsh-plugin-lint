export const PANEL_PAYLOAD_SCHEMA_VERSION = 2;

export function validatePanelPayload(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, errors: ['payload must be an object'] };
  if (value.schemaVersion !== PANEL_PAYLOAD_SCHEMA_VERSION) errors.push('schemaVersion must be 2');
  if (typeof value.checkedAt !== 'string' || !Number.isFinite(Date.parse(value.checkedAt))) errors.push('checkedAt must be an ISO date');
  if (!value.profile || typeof value.profile !== 'object') errors.push('profile must be an object');
  if (!value.matrix || typeof value.matrix !== 'object') {
    errors.push('matrix must be an object');
  } else {
    if (typeof value.matrix.hasPerPluginData !== 'boolean') errors.push('matrix.hasPerPluginData must be boolean');
    if (!Number.isInteger(value.matrix.plugins) || value.matrix.plugins < 0) errors.push('matrix.plugins must be a non-negative integer');
    if (value.matrix.generatedAt !== undefined && !Number.isFinite(Date.parse(value.matrix.generatedAt))) errors.push('matrix.generatedAt must be an ISO date');
    if (value.matrix.sourceRunId !== undefined && typeof value.matrix.sourceRunId !== 'string') errors.push('matrix.sourceRunId must be a string');
    if (!Array.isArray(value.matrix.dshVersions)) errors.push('matrix.dshVersions must be an array');
    if (!value.matrix.ecosystem || typeof value.matrix.ecosystem !== 'object') errors.push('matrix.ecosystem must be an object');
  }
  if (!Array.isArray(value.rows)) errors.push('rows must be an array');
  if (!value.summary || typeof value.summary !== 'object') errors.push('summary must be an object');
  if (!value.conflicts || typeof value.conflicts !== 'object') errors.push('conflicts must be an object');
  return { ok: errors.length === 0, errors };
}
