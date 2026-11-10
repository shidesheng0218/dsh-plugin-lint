import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPayload } from '../panel/host/payload.js';
import { validatePanelPayload } from '../panel/shared/payload.js';
import { isNewer, latestPublishedVersion } from '../panel/host/update.js';
import { registerRoutes, ROUTE } from '../panel/host/routes.js';

const AT = '2026-10-01T00:00:00.000Z';

function matrix(plugins = [], overrides = {}) {
  return {
    full: { plugins },
    dshVersions: ['0.2.0', '0.3.0'],
    plugins: plugins.length,
    ecosystem: { versions: {} },
    hasPerPluginData: true,
    generatedAt: AT,
    sourceRunId: 'run-1',
    conflicts: { tools: [], slots: [], routes: [], verified: {} },
    ...overrides,
  };
}

function cell(status, overrides = {}) {
  return { dsh: '0.2.0', composition: 'headless', status, trust: 'verified', at: AT, toolsAdded: [], ...overrides };
}

function profile(overrides = {}) {
  return { dir: '/profile', bundles: [{ name: 'demo', version: '1.0.0' }], dshVersion: '0.2.0', composition: 'headless', ...overrides };
}

function known(cells, version = '1.0.0') {
  return [{ name: 'demo', versions: [{ version, cells }] }];
}

function payloadOf({ bundles, cells, p = profile(), m = matrix(known(cells)) }) {
  return createPayload({ profile: { ...p, bundles }, matrix: m, checkedAt: AT });
}

test('validatePanelPayload rejects every malformed surface', () => {
  const valid = {
    schemaVersion: 2, checkedAt: AT, profile: {}, summary: {}, conflicts: {},
    matrix: { hasPerPluginData: true, plugins: 0, dshVersions: [], ecosystem: {} },
    rows: [],
  };
  assert.equal(validatePanelPayload(valid).ok, true);
  const cases = [
    (value) => null,
    (value) => [],
    (value) => { value.schemaVersion = 1; },
    (value) => { value.checkedAt = 'never'; },
    (value) => { delete value.profile; },
    (value) => { value.profile = 'x'; },
    (value) => { delete value.matrix; },
    (value) => { value.matrix = 'x'; },
    (value) => { value.checkedAt = 5; },
    (value) => { value.matrix.hasPerPluginData = 'yes'; },
    (value) => { value.matrix.plugins = -1; },
    (value) => { value.matrix.plugins = 1.5; },
    (value) => { value.matrix.generatedAt = 'never'; },
    (value) => { value.matrix.sourceRunId = 1; },
    (value) => { value.matrix.dshVersions = '0.2.0'; },
    (value) => { delete value.matrix.ecosystem; },
    (value) => { value.rows = {}; },
    (value) => { delete value.summary; },
    (value) => { delete value.conflicts; },
  ];
  for (const mutate of cases) {
    const copy = structuredClone(valid);
    const result = mutate(copy.length === 0 ? copy : copy);
    if (!result) continue;
    assert.equal(validatePanelPayload(result).ok, false);
  }
  assert.equal(validatePanelPayload(null).ok, false);
  assert.equal(validatePanelPayload([]).ok, false);
});

test('healthFor covers every recorded state', () => {
  const states = (bundles, cells, p = profile(), m = matrix(known(cells))) => payloadOf({ bundles, cells, p, m }).rows[0].health.state;
  assert.equal(states([{ name: '@deepseek-ai/core', version: '1.0.0' }], []), 'installed');
  assert.equal(states([{ name: 'demo' }], []), 'missing-install');
  assert.equal(states([{ name: 'demo', version: '1.0.0' }], [], profile({ dshVersion: undefined })), 'unverified');
  assert.equal(states([{ name: 'demo', version: '2.0.0' }], [cell('active')]), 'unverified');
  assert.equal(states([{ name: 'demo', version: '1.0.0' }], []), 'unverified');
  assert.equal(states([{ name: 'demo', version: '1.0.0' }], [cell('active'), cell('active', { composition: 'web' })], profile({ composition: undefined })), 'mixed');
  assert.equal(states([{ name: 'demo', version: '1.0.0' }], [cell('active')], profile({ composition: undefined })), 'unverified');
  assert.equal(states([{ name: 'demo', version: '1.0.0' }], [cell('active')], profile({ composition: 'web' })), 'unverified');
  assert.equal(states([{ name: 'demo', version: '1.0.0' }], [cell('active', { composition: 'web' }), cell('rejected-by-host')]), 'mixed');
  assert.equal(states([{ name: 'demo', version: '1.0.0' }], [cell('active', { trust: 'stale' })]), 'stale');
  assert.equal(states([{ name: 'demo', version: '1.0.0' }], [cell('active', { trust: 'legacy-unpinned' })]), 'unverified');
  assert.equal(states([{ name: 'demo', version: '1.0.0' }], [cell('active')]), 'recorded-active');
  assert.equal(states([{ name: 'demo', version: '1.0.0' }], [cell('rejected-by-host')]), 'recorded-failure');
  assert.equal(states([{ name: 'demo', version: '1.0.0' }], [cell('awaiting-service')]), 'waiting');
  assert.equal(states([{ name: 'demo', version: '1.0.0' }], [cell('something-else')]), 'mixed');
});

test('createPayload counts upgrade regressions and filters conflicts to installed plugins', () => {
  const cells = [
    cell('active', { dsh: '0.2.0' }),
    cell('rejected-by-host', { dsh: '0.3.0' }),
  ];
  const m = matrix(known(cells), {
    conflicts: {
      tools: [{ resource: 'x', plugins: ['demo', 'other'] }, { resource: 'y', plugins: ['demo'] }],
      slots: [{ resource: 's', plugins: ['demo', 'other', 'third'] }],
      routes: [],
      verified: { tools: [], slots: [], routes: [] },
    },
  });
  const payload = createPayload({ profile: profile({ bundles: [{ name: 'demo', version: '1.0.0' }, { name: 'other', version: '2.0.0' }] }), matrix: m, checkedAt: AT });
  assert.equal(payload.upgrade.worse, 1);
  assert.deepEqual(payload.conflicts.tools.map((entry) => entry.resource), ['x']);
  assert.deepEqual(payload.conflicts.tools[0].plugins, ['demo', 'other']);
  assert.deepEqual(payload.conflicts.slots.map((entry) => entry.plugins), [['demo', 'other']]);
  assert.equal(payload.summary.total, 2);
});

test('the payload route reports a thrown resolver as PAYLOAD_FAILED', async () => {
  const registrations = new Map();
  const ctx = {
    inject(_deps, callback) {
      callback({ get: () => ({ fetch: { register: (route) => route } }), effect: (register) => { const route = register(); registrations.set(route.path, route); return () => {}; } });
    },
  };
  registerRoutes(ctx, { payload: () => { throw new Error('boom'); } });
  const response = await registrations.get(ROUTE).fetch(new Request('http://localhost' + ROUTE, { method: 'POST' }));
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, 'PAYLOAD_FAILED');
});

test('the update route reports the published version and survives an unavailable registry', async () => {
  const registrations = new Map();
  const ctx = {
    inject(_deps, callback) {
      callback({ get: () => ({ fetch: { register: (route) => route } }), effect: (register) => { const route = register(); registrations.set(route.path, route); return () => {}; } });
    },
  };
  registerRoutes(ctx, {
    payload: () => ({}),
    now: Date.now() + 72 * 60 * 60 * 1000,
    fetchImpl: async () => ({ ok: true, json: async () => ({ version: '9.9.9' }) }),
  });
  const ok = await registrations.get(ROUTE + '/update').fetch(new Request('http://localhost' + ROUTE + '/update', { method: 'POST' }));
  const okBody = await ok.json();
  assert.equal(okBody.latest, '9.9.9');
  assert.equal(okBody.update.latest, '9.9.9');

  const failing = new Map();
  const failingCtx = {
    inject(_deps, callback) {
      callback({ get: () => ({ fetch: { register: (route) => route } }), effect: (register) => { const route = register(); failing.set(route.path, route); return () => {}; } });
    },
  };
  registerRoutes(failingCtx, {
    payload: () => ({}),
    now: Date.now() + 96 * 60 * 60 * 1000,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  const offline = await failing.get(ROUTE + '/update').fetch(new Request('http://localhost' + ROUTE + '/update', { method: 'POST' }));
  const offlineBody = await offline.json();
  assert.equal(offlineBody.ok, true);
  assert.equal(offlineBody.latest, undefined);
});

test('registerRoutes tolerates a context without a connection service', () => {
  const registrations = new Map();
  const ctx = { inject(_deps, callback) { callback({ get: () => undefined, effect: () => () => {} }); } };
  registerRoutes(ctx, { payload: () => ({}) });
  assert.equal(registrations.size, 0, 'no connection means no route registration');
  assert.equal(typeof registerRoutes(ctx, { payload: () => ({}) }), 'object');
});

test('isNewer compares numeric components and ignores equal strings', () => {
  assert.equal(isNewer('0.2.0', '0.1.9'), true);
  assert.equal(isNewer('0.1.9', '0.2.0'), false);
  assert.equal(isNewer('1.0.0', '1.0.0'), false);
  assert.equal(isNewer(undefined, undefined), false);
  assert.equal(isNewer('1.0.1', undefined), true);
});

test('latestPublishedVersion caches, tolerates errors and ignores a missing version', async () => {
  const calls = [];
  const now = Date.now() + 120 * 60 * 60 * 1000;
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ version: '9.9.9' }) };
  };
  assert.equal(await latestPublishedVersion({ fetchImpl, now }), '9.9.9');
  assert.equal(await latestPublishedVersion({ fetchImpl, now: now + 1000 }), '9.9.9', 'cached');
  assert.equal(calls.length, 1);
  assert.equal(await latestPublishedVersion({ fetchImpl, now: () => now + 7 * 60 * 60 * 1000 }), '9.9.9', 'a function clock is accepted');
  assert.equal(calls.length, 2);

  assert.equal(await latestPublishedVersion({ fetchImpl: async () => ({ ok: false }), now: now + 40 * 60 * 60 * 1000 }), undefined);
  assert.equal(await latestPublishedVersion({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }), now: now + 40 * 60 * 60 * 1000 }), undefined);
  assert.equal(await latestPublishedVersion({ fetchImpl: async () => { throw new Error('offline'); }, now: now + 40 * 60 * 60 * 1000 }), undefined);
});