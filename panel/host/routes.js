import { currentVersion, profileSnapshot } from './profile.js';
import { loadMatrix } from './matrix.js';
import { createPayload } from './payload.js';
import { isNewer, latestPublishedVersion } from './update.js';
import { createActionHandler } from './actions.js';

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
      fetch: createActionHandler(deps),
    },
    [ROUTE + '/update']: {
      path: ROUTE + '/update',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          const latest = await latestPublishedVersion({ fetchImpl: deps.fetchImpl || fetch, now: deps.now || Date.now });
          const current = currentVersion();
          return Response.json({ ok: true, update: latest && isNewer(latest, current) ? { current, latest } : undefined }, { headers: { 'cache-control': 'no-store' } });
        } catch {
          return Response.json({ ok: true, update: undefined }, { headers: { 'cache-control': 'no-store' } });
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
