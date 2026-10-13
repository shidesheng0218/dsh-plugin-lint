/**
 * Host half of the compatibility panel.
 *
 * One job: answer the browser half with the facts it cannot gather itself —
 * which plugins this profile has installed, which DSH is running, and what the
 * compatibility matrix says about that combination.
 *
 * The matrix is a snapshot bundled at build time (data/matrix-index.json), so the
 * page works offline and never reports a verdict we did not publish.
 *
 * The connection service is optional: in a profile without it (headless) the
 * plugin still mounts and simply registers no route.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(HERE, 'data', 'matrix-index.json');
const ROUTE = '/api/dsh-plugin-lint/panel';

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

/** The DSH the profile is running, read from the install that provides it. */
function runningDshVersion() {
  for (const spec of ['@deepseek-ai/dsh/package.json']) {
    try {
      const resolved = import.meta.resolve(spec);
      const version = readJson(fileURLToPath(resolved))?.version;
      if (version) return version;
    } catch { /* resolution differs per surface; the field stays absent */ }
  }
  return undefined;
}

/** Bundles this profile selected, with the version actually installed. */
function installedBundles() {
  const dir = process.env.DSH_PROFILE_DIR;
  if (!dir) return { error: 'DSH_PROFILE_DIR is not set, so the installed plugins cannot be listed' };
  const manifest = readJson(join(dir, 'package.json'));
  if (!manifest) return { error: 'no package.json in ' + dir };
  // Bundle entries are package names; anything else in the list is skipped rather
  // than allowed to throw, because a host half that throws blanks the whole page.
  const bundles = (manifest.dsh?.profile?.bundles ?? []).filter((name) => typeof name === 'string' && name !== '');
  return {
    dir,
    bundles: bundles.map((name) => {
      const version = readJson(join(dir, 'node_modules', name, 'package.json'))?.version;
      return { name, version };
    }),
  };
}

function payload() {
  const index = readJson(INDEX_PATH);
  const installed = installedBundles();
  const byPlugin = new Map((index?.plugins ?? []).map((p) => [p.name, p]));
  const rows = (installed.bundles ?? []).map((bundle) => {
    const known = byPlugin.get(bundle.name);
    return {
      name: bundle.name,
      version: bundle.version,
      firstParty: bundle.name.startsWith('@deepseek-ai/'),
      known: known !== undefined,
      cells: known?.cells ?? [],
    };
  });
  return {
    ok: true,
    dsh: { version: runningDshVersion() },
    profile: { dir: installed.dir, error: installed.error },
    matrix: {
      generatedAt: index?.generatedAt,
      dshVersions: index?.dshVersions ?? [],
      plugins: index?.plugins?.length ?? 0,
    },
    rows,
  };
}

export function apply(ctx) {
  ctx.inject(['connection'], (scoped) => {
    const connection = scoped.get('connection');
    const register = typeof connection?.fetch?.register === 'function'
      ? connection.fetch.register.bind(connection.fetch)
      : undefined;
    if (register === undefined) return;
    scoped.effect(() => register({
      path: ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          return Response.json(payload(), { headers: { 'cache-control': 'no-store' } });
        } catch (error) {
          return Response.json({ ok: false, error: String(error?.message ?? error) }, { status: 500 });
        }
      },
    }), 'dsh-plugin-lint-panel: panel route');
  });
}

export { payload, runningDshVersion, installedBundles, ROUTE };
void existsSync;
