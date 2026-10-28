/**
 * Tests for the experimental composition conflict detector.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { detectConflicts } from '../src/composition.js';
import { maskSource } from '../src/mask.js';

const pkgWith = (name, files) => ({
  name,
  manifest: { name },
  jsFiles: files.map(([path, text]) => ({ path, text, ...maskSource(text) })),
});

test('detectConflicts - detects slot collisions registered through the current API', () => {
  const client = (id) => "ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: '" + id + "' }, Component));";
  const conflicts = detectConflicts([
    pkgWith('plugin-a', [['client.js', client('a')]]),
    pkgWith('plugin-b', [['client.js', client('b')]]),
  ]);

  assert.equal(conflicts.slots.length, 1, 'should detect one slot conflict');
  assert.deepEqual(conflicts.slots[0].plugins.sort(), ['plugin-a', 'plugin-b']);
});

test('detectConflicts - detects tool name collisions registered through defineTool()', () => {
  const tools = "ctx.tools.register(defineTool({ name: 'search', execute: () => {} }));";
  const conflicts = detectConflicts([
    pkgWith('search-a', [['index.js', tools]]),
    pkgWith('search-b', [['index.js', tools]]),
  ]);

  assert.equal(conflicts.toolNames.length, 1, 'should detect one tool name conflict');
  assert.equal(conflicts.toolNames[0].risk, 'high');
  assert.deepEqual(conflicts.toolNames[0].plugins.sort(), ['search-a', 'search-b']);
});

test('detectConflicts - detects route collisions by method and path', () => {
  const route = "connection.fetch.register({ path: '/api/shared', methods: ['POST'] });";
  const conflicts = detectConflicts([
    pkgWith('route-a', [['index.js', route]]),
    pkgWith('route-b', [['index.js', route]]),
  ]);

  assert.equal(conflicts.routes.length, 1, 'should detect one route conflict');
  assert.equal(conflicts.routes[0].resource, 'POST /api/shared');
  assert.equal(conflicts.routes[0].path, '/api/shared');
  assert.deepEqual(conflicts.routes[0].methods, ['POST']);
});

test('detectConflicts - reports no conflict for distinct resources', () => {
  const conflicts = detectConflicts([
    pkgWith('plugin-a', [['client.js', "ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock' }));"]]),
    pkgWith('plugin-b', [['client.js', "ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section' }));"]]),
  ]);

  assert.equal(conflicts.summary.total, 0);
});

test('detectConflicts - one plugin claiming the same resource twice is not a conflict', () => {
  const text = [
    "ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'one' }));",
    "ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'two' }));",
  ].join('\n');
  const conflicts = detectConflicts([pkgWith('solo', [['client.js', text]])]);

  assert.equal(conflicts.summary.total, 0, 'a plugin does not conflict with itself');
});

test('detectConflicts - flags a shared waterfall event when a listener does not preserve next()', () => {
  const noNext = "ctx.on('agent/pre-step', async (decision) => {\n  decision.foo = 'bar';\n});";
  const returnsNext = "ctx.on('agent/pre-step', (decision, next) => {\n  return next();\n});";
  const conflicts = detectConflicts([
    pkgWith('plugin-a', [['index.js', noNext]]),
    pkgWith('plugin-b', [['index.js', returnsNext]]),
  ]);

  assert.equal(conflicts.eventListeners.length, 1, 'should report the shared waterfall event');
  assert.deepEqual(conflicts.eventListeners[0].problematic, ['plugin-a']);
  assert.equal(conflicts.eventListeners[0].risk, 'medium');
});

test('detectConflicts - a package loaded from disk gets a usable plugin label', () => {
  const loaded = {
    manifest: { name: 'manifest-plugin' },
    jsFiles: [{ path: 'client.js', ...maskSource("ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section' }));") }],
  };
  const conflicts = detectConflicts([
    loaded,
    pkgWith('plugin-b', [['client.js', "ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section' }));"]]),
  ]);

  assert.deepEqual(conflicts.slots[0].plugins.sort(), ['manifest-plugin', 'plugin-b'], 'name falls back to manifest.name');
});

test('detectConflicts - marks the analysis as experimental schema v2', () => {
  const conflicts = detectConflicts([]);
  assert.equal(conflicts.schemaVersion, 2);
  assert.equal(conflicts.experimental, true);
  assert.ok(Array.isArray(conflicts.limits) && conflicts.limits.length > 0);
  assert.equal(conflicts.summary.total, 0);
});

test('different HTTP methods on one path do not conflict', () => {
  const conflicts = detectConflicts([
    pkgWith('a', [['index.js', "connection.fetch.register({ path: '/api/x', methods: ['GET'] });"]]),
    pkgWith('b', [['index.js', "connection.fetch.register({ path: '/api/x', methods: ['POST'] });"]]),
  ]);
  assert.equal(conflicts.routes.length, 0);
});

test('deliberate reject and throw are decisions, not missing next()', () => {
  const rejecting = "ctx.on('agent/pre-step', () => { return { kind: 'reject' }; });";
  const throwing = "ctx.on('agent/pre-step', () => { throw new Error('stop'); });";
  const conflicts = detectConflicts([
    pkgWith('a', [['index.js', rejecting]]),
    pkgWith('b', [['index.js', throwing]]),
  ]);
  assert.equal(conflicts.eventListeners.length, 0);
});

test('routes without method information are unknown rather than certain conflicts', () => {
  const route = "connection.fetch.register({ path: '/api/unknown' });";
  const conflicts = detectConflicts([
    pkgWith('a', [['index.js', route]]),
    pkgWith('b', [['index.js', route]]),
  ]);
  assert.equal(conflicts.routes.length, 0);
  assert.equal(conflicts.unknownRoutes.length, 2);
  assert.equal(conflicts.unknownRoutes[0].method, 'unknown');
});
