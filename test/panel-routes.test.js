import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActionHandler } from '../panel/host/actions.js';
import { registerRoutes, ROUTE } from '../panel/host/routes.js';

const AGGREGATE = {
  schemaVersion: 2,
  generatedAt: '2026-10-01T00:00:00.000Z',
  sourceRunId: 'run-aggregate',
  dshVersions: ['0.2.0-rc.2'],
  plugins: 50,
  versions: { '0.2.0-rc.2': { active: 80, 'awaiting-service': 16 } },
};

function postJson(url, body, headers = {}) {
  return new Request('http://localhost' + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function actionRequest(body, headers = {}) {
  return postJson(ROUTE + '/action', body, { 'x-dsh-plugin-lint-action': '1', ...headers });
}

function routeContext() {
  const registrations = new Map();
  const ctx = {
    inject(_dependencies, callback) {
      callback({
        get: () => ({ fetch: { register: (route) => route } }),
        effect: (register) => {
          const route = register();
          registrations.set(route.path, route);
          return () => {};
        },
      });
    },
  };
  return { ctx, registrations };
}

function actionDeps(overrides = {}) {
  const calls = [];
  const audits = [];
  return {
    calls,
    audits,
    installedBundles: () => ({ bundles: [{ name: 'demo', version: '1.0.0' }, { name: '@shidesheng0218/dsh-plugin-lint-panel', version: '0.1.6' }] }),
    executor: async () => ({ stdout: '', stderr: '' }),
    audit: (entry) => audits.push(entry),
    ...overrides,
  };
}

test('aggregate-only payload keeps counts and snapshot metadata without registry access', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-panel-aggregate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const aggregatePath = join(dir, 'aggregate.json');
  writeFileSync(aggregatePath, JSON.stringify(AGGREGATE));
  const registryFetch = async () => {
    registryFetch.calls += 1;
    return { ok: true, json: async () => ({ version: '99.0.0' }) };
  };
  registryFetch.calls = 0;
  const { ctx, registrations } = routeContext();
  registerRoutes(ctx, { payloadOptions: { aggregatePath }, fetchImpl: registryFetch });
  const response = await registrations.get(ROUTE).fetch(postJson(ROUTE, {}));
  const data = await response.json();
  assert.equal(data.schemaVersion, 2);
  assert.equal(data.matrix.hasPerPluginData, false);
  assert.equal(data.matrix.plugins, 50);
  assert.equal(data.matrix.generatedAt, AGGREGATE.generatedAt);
  assert.equal(data.matrix.sourceRunId, AGGREGATE.sourceRunId);
  assert.equal(registryFetch.calls, 0);
  const update = await registrations.get(ROUTE + '/update').fetch(postJson(ROUTE + '/update', {}));
  const updateData = await update.json();
  assert.equal(updateData.current, '0.1.6');
  assert.equal(updateData.latest, '99.0.0');
  assert.equal(updateData.update.latest, '99.0.0');
  assert.equal(registryFetch.calls, 1);
});

test('the server refuses to remove the panel itself', async () => {
  const deps = actionDeps();
  const action = createActionHandler(deps);
  const response = await action(actionRequest({ action: 'isolate', plugin: '@shidesheng0218/dsh-plugin-lint-panel', confirmed: true }));
  assert.equal(response.status, 403);
  assert.equal(deps.calls.length, 0);
});

test('action requires JSON, its custom header, and explicit confirmation', async () => {
  const action = createActionHandler(actionDeps());
  const nonJson = await action(postJson(ROUTE + '/action', { action: 'isolate', plugin: 'demo', confirmed: true }, { 'content-type': 'text/plain' }));
  assert.equal(nonJson.status, 415);
  const noHeader = await action(actionRequest({ action: 'isolate', plugin: 'demo', confirmed: true }, { 'x-dsh-plugin-lint-action': '0' }));
  assert.equal(noHeader.status, 400);
  const unconfirmed = await action(actionRequest({ action: 'isolate', plugin: 'demo' }));
  assert.equal(unconfirmed.status, 400);
});

test('missing Origin is accepted with independent auth; a mismatched Origin is rejected', async () => {
  const deps = actionDeps();
  const action = createActionHandler(deps);
  const accepted = await action(actionRequest({ action: 'isolate', plugin: 'demo', confirmed: true }));
  assert.equal(accepted.status, 200);
  assert.equal(deps.calls.length, 1);
  const rejected = await action(actionRequest({ action: 'isolate', plugin: 'demo', confirmed: true }, { origin: 'https://evil.example' }));
  assert.equal(rejected.status, 403);
  assert.equal(deps.calls.length, 1);
});

test('concurrent actions return 409 and always release the profile lock', async () => {
  let release;
  let firstCall = true;
  const deps = actionDeps({
    executor: () => {
      if (!firstCall) return Promise.resolve({ stdout: '', stderr: '' });
      firstCall = false;
      return new Promise((resolve) => { release = resolve; });
    },
  });
  const action = createActionHandler(deps);
  const first = action(actionRequest({ action: 'isolate', plugin: 'demo', confirmed: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = await action(actionRequest({ action: 'isolate', plugin: 'demo', confirmed: true }));
  assert.equal(second.status, 409);
  release({ stdout: '', stderr: '' });
  assert.equal((await first).status, 200);
  const third = await action(actionRequest({ action: 'isolate', plugin: 'demo', confirmed: true }));
  assert.equal(third.status, 200);
});

test('executor failures are sanitized and the next action can proceed', async () => {
  let shouldThrow = true;
  const deps = actionDeps({
    executor: async () => {
      if (!shouldThrow) return { stdout: '', stderr: '' };
      const error = new Error('secret-token');
      error.stdout = 'stdout-secret';
      error.stderr = 'stderr-secret';
      throw error;
    },
  });
  const action = createActionHandler(deps);
  const response = await action(actionRequest({ action: 'isolate', plugin: 'demo', confirmed: true }));
  assert.equal(response.status, 500);
  const text = JSON.stringify(await response.json());
  assert.doesNotMatch(text, /secret-token|stdout-secret|stderr-secret/);
  assert.equal(deps.audits.some((entry) => entry.outcome === 'error'), true);
  assert.equal(JSON.stringify(deps.audits).includes('stdout-secret'), false);
  shouldThrow = false;
  const next = await action(actionRequest({ action: 'isolate', plugin: 'demo', confirmed: true }));
  assert.equal(next.status, 200);
});
