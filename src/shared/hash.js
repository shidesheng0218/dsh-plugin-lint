import { createHash } from 'node:crypto';
import { isPlainObject } from './validate.js';

export function stableStringify(value) {
  return JSON.stringify(normalizeJson(value, new Set()));
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeJson(value, ancestors) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('stableStringify only accepts JSON data');
    return value;
  }
  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw new TypeError('stableStringify only accepts JSON data');
  }
  if (ancestors.has(value)) throw new TypeError('stableStringify cannot encode a JSON cycle');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => normalizeJson(entry, ancestors));
    const normalized = {};
    for (const key of Object.keys(value).sort()) normalized[key] = normalizeJson(value[key], ancestors);
    return normalized;
  } finally {
    ancestors.delete(value);
  }
}
