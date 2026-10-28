import { ToolError } from '../shared/errors.js';
import { validateCell } from './schema.js';

export function sanitizeText(value) {
  return String(value)
    .replace(/token=[^\s&"']+/gi, 'token=<redacted>')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>')
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1<redacted>@')
    .replace(/((?:api[_-]?key|api[_-]?token|access[_-]?token|secret|password|npm_token|probe_api_key)\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1<redacted>')
    .replace(/\/(Users|home)\/[^/\s]+/g, '/$1/<redacted>');
}

export function sanitizeCellForPublish(cell) {
  if (cell?.schemaVersion !== 2 || cell.run?.outcome !== 'completed') {
    throw new ToolError('EXPORT_INPUT_INVALID', 'Only completed v2 cells can be published.');
  }
  const validation = validateCell(cell);
  if (!validation.ok) throw new ToolError('EXPORT_INPUT_INVALID', validation.errors.join('; '));
  const publicCell = structuredClone(cell);
  delete publicCell.plugin.path;
  delete publicCell.installOutput;
  delete publicCell.stdout;
  delete publicCell.stderr;
  delete publicCell.env;
  if (publicCell.evidence) publicCell.evidence.note = sanitizeText(publicCell.evidence.note || '');
  if (publicCell.reproduce?.command) publicCell.reproduce.command = sanitizeText(publicCell.reproduce.command);
  return publicCell;
}

export function sanitizeForPublish(value) {
  if (Array.isArray(value)) return value.map(sanitizeForPublish);
  if (value && typeof value === 'object') {
    if (value.schemaVersion === 2 && value.plugin && value.run) return sanitizeCellForPublish(value);
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      if (['stdout', 'stderr', 'installOutput', 'env', 'cause', 'rawOutput'].includes(key)) continue;
      output[key] = sanitizeForPublish(entry);
    }
    return output;
  }
  return typeof value === 'string' ? sanitizeText(value) : value;
}
