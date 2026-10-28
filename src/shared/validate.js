export function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function requireFields(value, fields, path) {
  if (!isPlainObject(value)) return [`${path} must be an object`];
  const errors = [];
  for (const field of fields) {
    if (!Object.hasOwn(value, field) || value[field] === undefined) errors.push(`${path}.${field} is required`);
  }
  return errors;
}
