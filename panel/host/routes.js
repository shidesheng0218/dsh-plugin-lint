import { currentVersion, profileSnapshot, installedBundles } from './profile.js';
import { loadMatrix } from './matrix.js';
import { createPayload } from './payload.js';
import { isNewer, latestPublishedVersion } from './update.js';
import { createActionHandler } from './actions.js';

// Only honours options supplied by the caller. panel/index.js passes the real
// `payload` resolver, which adds the profile cache and the bundled snapshot.
// Calling registerRoutes without deps from a production entry would render an
// empty matrix; test/panel-assembly.test.js pins the real entry point.
function defaultPayload(options) {
  return createPayload({
    profile: profileSnapshot(),
    matrix: loadMatrix({ indexPath: options.indexPath, aggregatePath: options.aggregatePath, now: options.now || Date.now }),
    checkedAt: options.checkedAt || new Date().toISOString(),
  });
}

export const ROUTE = '/api/dsh-plugin-lint/panel';

export function registerRoutes(ctx, deps = {}) {
  const payload = deps.payload || defaultPayload;
  const payloadOptions = deps.payloadOptions || {};
  const routes = {
    [ROUTE]: {
      path: ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          return Response.json(payload(payloadOptions), { headers: { 'cache-control': 'no-store' } });
        } catch {
          return Response.json({ ok: false, error: { code: 'PAYLOAD_FAILED', message: 'The panel payload could not be created' } }, { status: 500 });
        }
      },
    },
    [ROUTE + '/action']: {
      path: ROUTE + '/action',
      methods: ['POST'],
      requestBody: 'buffered',
      // The action handler resolves the installed version through this
      // dependency. Without it every request failed with 400 before reaching
      // the executor, so the default must be the real reader.
      fetch: createActionHandler(Object.assign({ installedBundles }, deps)),
    },
    [ROUTE + '/update']: {
      path: ROUTE + '/update',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async () => {
        const current = currentVersion();
        try {
          const latest = await latestPublishedVersion({ fetchImpl: deps.fetchImpl || fetch, now: deps.now || Date.now });
          return Response.json({ ok: true, current, latest, update: latest && isNewer(latest, current) ? { current, latest } : undefined }, { headers: { 'cache-control': 'no-store' } });
        } catch {
          return Response.json({ ok: true, current, latest: undefined, update: undefined }, { headers: { 'cache-control': 'no-store' } });
        }
      },
    },
  };
  ctx.inject(['connection'], (scoped) => {
    const connection = scoped.get('connection');
    const register = typeof connection?.fetch?.register === 'function' ? connection.fetch.register.bind(connection.fetch) : undefined;
    if (register === undefined) return;
    for (const route of Object.values(routes)) scoped.effect(() => register(route), 'dsh-plugin-lint-panel: routes');
  });
  return routes;
}
