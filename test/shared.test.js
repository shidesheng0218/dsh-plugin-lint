import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolError } from '../src/shared/errors.js';
import { stableStringify, sha256 } from '../src/shared/hash.js';
import { isPlainObject, requireFields } from '../src/shared/validate.js';
import {
  CELL_SCHEMA_VERSION,
  EXPERIMENTAL_SCHEMA_VERSION,
  PANEL_PAYLOAD_SCHEMA_VERSION,
  PROBE_VERSION,
} from '../src/shared/version.js';

test('stableStringify canonicalizes object keys without reordering arrays', () => {
  const input = { b: 2, a: { d: 1, c: 3 }, list: [{ z: 1, a: 2 }, 3] };
  assert.equal(stableStringify(input), '{"a":{"c":3,"d":1},"b":2,"list":[{"a":2,"z":1},3]}');
});

test('stableStringify rejects values outside JSON data', () => {
  assert.throws(() => stableStringify({ missing: undefined }), /JSON/);
  assert.throws(() => stableStringify(Number.NaN), /JSON/);
});

test('sha256 hashes text and bytes with the standard algorithm', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256(Buffer.from('abc')), sha256('abc'));
});

test('ToolError preserves its code, name, and cause', () => {
  const cause = new Error('root');
  const error = new ToolError('ISOLATION_UNAVAILABLE', 'no backend', { cause });
  assert.equal(error.name, 'ToolError');
  assert.equal(error.code, 'ISOLATION_UNAVAILABLE');
  assert.equal(error.cause, cause);
});

test('isPlainObject distinguishes records from other values', () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject(Object.create(null)), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject(new Date()), false);
});

test('requireFields reports only missing required fields with their path', () => {
  assert.deepEqual(requireFields({ name: 'demo' }, ['name', 'version'], 'plugin'), ['plugin.version is required']);
  assert.deepEqual(requireFields(null, ['name'], 'plugin'), ['plugin must be an object']);
});

test('schema and probe versions are explicit public contracts', () => {
  assert.equal(CELL_SCHEMA_VERSION, 2);
  assert.equal(EXPERIMENTAL_SCHEMA_VERSION, 2);
  assert.equal(PANEL_PAYLOAD_SCHEMA_VERSION, 2);
  assert.equal(PROBE_VERSION, '0.4.0');
});
