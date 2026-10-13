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
/**
 * The matrix snapshot is generated locally (scripts/matrix/bundle-panel-data.mjs)
 * and is deliberately not tracked: it names packages and carries verdicts, which
 * belongs to whoever ran the probe, not to this repository. A profile without it
 * still renders, with every plugin reported as not covered.
 */
const indexPath = () => process.env.DSH_PLUGIN_LINT_INDEX || join(HERE, 'data', 'matrix-index.json');
const ROUTE = '/api/dsh-plugin-lint/panel';

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

/**
 * The DSH the profile is running.
 *
 * import.meta.resolve cannot see it from inside a profile — measured, and the
 * panel said "Running DSH unknown" until this also walked the launcher path.
 * The process was started by the dsh CLI, so its entry point names the install.
 */
function runningDshVersion() {
  const candidates = [];
  try { candidates.push(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/package.json'))); } catch { /* not resolvable from a profile */ }
  const entry = process.argv[1];
  if (typeof entry === 'string' && entry.includes('@deepseek-ai')) {
    const marker = entry.indexOf('@deepseek-ai');
    candidates.push(join(entry.slice(0, marker), '@deepseek-ai', 'dsh', 'package.json'));
  }
  for (const candidate of candidates) {
    const version = readJson(candidate)?.version;
    if (version) return version;
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
      // First-party bundles resolve from the dsh installation, not the profile, so
      // "not installed" would be the wrong word for them.
      const providedBy = version ? 'profile' : (name.startsWith('@deepseek-ai/') ? 'dsh-installation' : undefined);
      return { name, version, providedBy };
    }),
  };
}

function payload() {
  const index = readJson(indexPath());
  const installed = installedBundles();
  const byPlugin = new Map((index?.plugins ?? []).map((p) => [p.name, p]));
  const rows = (installed.bundles ?? []).map((bundle) => {
    const known = byPlugin.get(bundle.name);
    return {
      name: bundle.name,
      version: bundle.version,
      // Carried through from installedBundles; dropping it here is why the page
      // said "not installed" about bundles the dsh installation provides.
      providedBy: bundle.providedBy,
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
