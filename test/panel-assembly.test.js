import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Assembly-root test for the panel.
 *
 * Every other panel test calls the exported `payload()` or passes its own deps
 * to `registerRoutes`. Neither proves that the entry point the DSH host calls
 * (`apply(ctx)`) wires the real data source, so a missing dependency could ship
 * with 240 green tests. This one drives `apply()` and then the registered HTTP
 * routes, exactly as the host does.
 */

const FIXTURE_INDEX = {
  schemaVersion: 2,
  generatedAt: '2026-01-01T00:00:00.000Z',
  dshVersions: ['0.2.0-rc.2'],
  plugins: [
    {
      name: 'covered-plugin',
      versions: [
        {
          version: '1.0.0',
          integrity: 'sha512-fixture',
          cells: [
            {
              dsh: '0.2.0-rc.2',
              composition: 'headless',
              status: 'active',
              trust: 'self-reported',
              at: '2026-01-01T00:00:00.000Z',
              toolsAdded: ['demo_tool'],
            },
          ],
        },
      ],
    },
  ],
  conflicts: { tools: [], slots: [], routes: [] },
};

const root = mkdtempSync(join(tmpdir(), 'dsh-panel-assembly-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

const profileDir = join(root, 'profile');
mkdirSync(join(profileDir, 'node_modules', 'covered-plugin'), { recursive: true });
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-assembly',
  dsh: { profile: { bundles: ['covered-plugin'], composition: 'headless' } },
}));
writeFileSync(
  join(profileDir, 'node_modules', 'covered-plugin', 'package.json'),
  JSON.stringify({ name: 'covered-plugin', version: '1.0.0' }),
);

const indexPath = join(root, 'matrix-index.json');
writeFileSync(indexPath, JSON.stringify(FIXTURE_INDEX));

// A just-generated manifest stops apply() from starting a network refresh.
const cacheDir = join(root, 'cache');
mkdirSync(cacheDir, { recursive: true });
writeFileSync(join(cacheDir, 'manifest.json'), JSON.stringify({ generatedAt: new Date().toISOString() }));

process.env.DSH_PROFILE_DIR = profileDir;
process.env.DSH_PLUGIN_LINT_INDEX = indexPath;
process.env.DSH_PLUGIN_LINT_CACHE = cacheDir;

const panel = await import(fileURLToPath(new URL('../panel/index.js', import.meta.url)));
const { ROUTE } = await import(fileURLToPath(new URL('../panel/host/routes.js', import.meta.url)));

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

function post(path, body = {}) {
  return new Request('http://localhost' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('apply(ctx) renders the profile matrix instead of an empty payload', async () => {
  const { ctx, registrations } = routeContext();
  panel.apply(ctx);

  const response = await registrations.get(ROUTE).fetch(post(ROUTE));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.equal(data.matrix.hasPerPluginData, true, 'the configured matrix index must reach the route');
  assert.equal(data.matrix.dshVersions.length, 1);
  assert.equal(data.rows.length, 1);
  assert.equal(data.rows[0].name, 'covered-plugin');
  assert.equal(data.rows[0].known, true);
  assert.equal(data.rows[0].cells.length, 1);
});

test('apply(ctx) wires the installed-bundle reader into the action route', async () => {
  const { ctx, registrations } = routeContext();
  panel.apply(ctx);

  // Without deps.installedBundles the handler threw and answered 400 BAD_REQUEST.
  // With it, an unknown package is a real 404 decision.
  const response = await registrations.get(ROUTE + '/action').fetch(
    new Request('http://localhost' + ROUTE + '/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-plugin-lint-action': '1' },
      body: JSON.stringify({ action: 'isolate', plugin: 'not-installed', confirmed: true }),
    }),
  );
  assert.equal(response.status, 404);
  const data = await response.json();
  assert.equal(data.error.code, 'NOT_INSTALLED');
});