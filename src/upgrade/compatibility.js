const INCOMPATIBLE = /incompatible|unsupported|broken|failed|rejected|inactive|boot/i;

export function classifyCompatibilityDeclaration(value) {
  if (value === true || value === 'compatible') return 'compatible';
  if (value === false || value === 'incompatible') return 'incompatible';
  if (typeof value === 'string') return INCOMPATIBLE.test(value) ? 'incompatible' : 'unknown';
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (value.compatible === true) return 'compatible';
    if (value.compatible === false) return 'incompatible';
    const status = value.status ?? value.verdict;
    if (typeof status === 'string' && INCOMPATIBLE.test(status)) return 'incompatible';
  }
  return 'unknown';
}
