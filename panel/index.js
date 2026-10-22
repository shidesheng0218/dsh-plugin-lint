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
const aggregatePath = () => join(HERE, 'data', 'aggregate.json');
const ROUTE = '/api/dsh-plugin-lint/panel';
/** Same staleness window as the site generator. */
const STALE_DAYS = 30;

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

/** The version this install is running, read from the package's own manifest. */
function currentVersion() {
  return readJson(join(HERE, 'package.json'))?.version;
}

/** Strictly newer, numeric segments only — the published versions are plain x.y.z. */
export function isNewer(latest, current) {
  const a = String(latest ?? '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const b = String(current ?? '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/**
 * The latest published version, cached for six hours.
 *
 * A failed lookup is not an error: the panel works offline, and an update
 * notice is a convenience, not a dependency. The timeout is short so opening
 * the settings page is never held up by the registry.
 */
const UPDATE_TTL_MS = 6 * 60 * 60 * 1000;
let updateCache;
async function latestPublishedVersion() {
  const now = Date.now();
  if (updateCache && now - updateCache.at < UPDATE_TTL_MS) return updateCache.version;
  try {
    const response = await fetch('https://registry.npmjs.org/@shidesheng0218/dsh-plugin-lint-panel/latest', {
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return undefined;
    const meta = await response.json();
    const version = typeof meta?.version === 'string' ? meta.version : undefined;
    if (version) updateCache = { at: now, version };
    return version;
  } catch {
    return undefined;
  }
}

/**
 * The panel reads two data files: the full matrix index when it exists (local
 * runs, named packages), and the aggregate that ships in the npm package
 * (counts per version, never a package name). A user who installs the panel
 * from npm without running the matrix sees the ecosystem picture; a user who
 * also runs the matrix sees their own plugins against it.
 */
function matrixData() {
  const full = readJson(indexPath());
  if (full) return { full, aggregate: undefined };
  const aggregate = readJson(aggregatePath());
  return { full: undefined, aggregate };
}

/**
 * The snapshot carries the trust each cell had when the snapshot was bundled,
 * but a verified cell does not stay verified: it ages. The site generator
 * recomputes staleness at render time; the panel must do the same, because a
 * snapshot bundled in October still says "verified" in November.
 */
function withCurrentTrust(cells) {
  const now = Date.now();
  return (cells ?? []).map((cell) => {
    if (cell.trust !== 'verified') return cell;
    const ageDays = (now - Date.parse(cell.at || '')) / 86400000;
    return Number.isFinite(ageDays) && ageDays > STALE_DAYS ? { ...cell, trust: 'stale' } : cell;
  });
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

/**
 * The profile directory, with a fallback for compositions that do not expose it.
 *
 * DSH_PROFILE_DIR is contributed by dsh-shell-env, which is part of the shell
 * surface: a web composition does not mount it, so the panel saw "not set"
 * although the profile was right there. DSH_HOME is set for every profile, and
 * the launcher was invoked with `--profile <name>`, so the directory is
 * derivable: $DSH_HOME/profiles/<name>.
 */
function profileDir() {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR;
  const home = process.env.DSH_HOME;
  if (!home) return undefined;
  const argv = process.argv || [];
  const i = argv.indexOf('--profile');
  const name = i >= 0 ? argv[i + 1] : undefined;
  if (!name || name.startsWith('-')) return undefined;
  const dir = join(home, 'profiles', name);
  return existsSync(join(dir, 'package.json')) ? dir : undefined;
}

/** Bundles this profile selected, with the version actually installed. */
function installedBundles() {
  const dir = profileDir();
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
  const checkedAt = new Date().toISOString();
  const { full: index, aggregate } = matrixData();
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
      cells: known ? withCurrentTrust(known.cells) : [],
      health: (() => {
        const firstParty = bundle.name.startsWith('@deepseek-ai/');
        const dshVersion = runningDshVersion();
        const exactVersion = Boolean(bundle.version && known?.version === bundle.version);
        const currentCells = exactVersion && dshVersion
          ? withCurrentTrust(known?.cells ?? []).filter((item) => item.dsh === dshVersion) : [];
        const cell = currentCells[0];
        const statuses = new Set(currentCells.map((item) => item.status));
        const state = firstParty ? 'installed' : !bundle.version ? 'missing-install'
          : !dshVersion || !exactVersion ? 'unverified' : currentCells.length === 0 ? 'unverified' : statuses.size > 1 ? 'mixed' : cell.trust === 'stale' ? 'stale'
            : cell.status === 'active' ? 'recorded-active'
              : ['boot-failed', 'inactive-error', 'install-failed', 'rejected-by-host'].includes(cell.status) ? 'recorded-failure'
                : cell.status === 'awaiting-service' ? 'waiting' : 'mixed';
        return { state, reason: state === 'recorded-active' ? 'Historical matrix probe recorded active; runtime is not verified.' : `Health state: ${state}.`, evidence: cell ? { dsh: cell.dsh, pluginVersion: known.version, status: cell.status, trust: cell.trust, at: cell.at } : undefined };
      })(),
      // The audit is the capability inventory: what the code actually does.
      // It lives on the cells, not the plugin row — read it from the first cell
      // that recorded one.
      audit: known?.cells?.find((c) => c.audit)?.audit ?? undefined,
    };
  });
  // Aggregate counts: from the full index when available, else from the
  // aggregate that ships in the npm package. Never a package name.
  const ecosystem = { versions: {} };
  const source = index ?? aggregate;
  // The full index's plugins is an array of named plugins; the aggregate's is a
  // count. Only the array carries cells to tally.
  const plugins = Array.isArray(source?.plugins) ? source.plugins : [];
  for (const plugin of plugins) {
    for (const cell of plugin.cells ?? []) {
      if (!ecosystem.versions[cell.dsh]) ecosystem.versions[cell.dsh] = {};
      const tally = ecosystem.versions[cell.dsh];
      tally[cell.status] = (tally[cell.status] || 0) + 1;
    }
  }
  // The aggregate already carries the tally; use it directly.
  if (!index && aggregate?.versions) {
    for (const [v, tally] of Object.entries(aggregate.versions)) {
      ecosystem.versions[v] = { ...tally };
    }
  }
  // The upgrade banner: the running version is behind the newest the matrix
  // covers, and at least one installed plugin would get a worse verdict there.
  const running = runningDshVersion();
  const versions = index?.dshVersions ?? [];
  const latest = versions[versions.length - 1];
  const upgrade = running && latest && running !== latest
    ? { running, latest, worse: 0 }
    : undefined;
  if (upgrade) {
    const BAD = new Set(['rejected-by-host', 'inactive-error', 'boot-failed']);
    const RANK = { active: 0, 'awaiting-service': 1, 'rejected-by-host': 2, 'inactive-error': 3, 'boot-failed': 4, 'install-failed': 5 };
    const best = (cells, v) => (cells ?? []).filter((c) => c.dsh === v).sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9))[0];
    for (const bundle of installed.bundles ?? []) {
      if (bundle.name.startsWith('@deepseek-ai/')) continue;
      const known = byPlugin.get(bundle.name);
      if (!known) continue;
      const from = best(known.cells, running);
      const to = best(known.cells, latest);
      if (from && to && !BAD.has(from.status) && BAD.has(to.status)) upgrade.worse += 1;
    }
  }
  // Slot conflicts: read the conflicts report from the matrix index when it
  // exists, and keep only the clashes that involve an installed plugin.
  const conflicts = [];
  if (index?.slots?.clashes) {
    const installedNames = new Set((installed.bundles ?? []).map((b) => b.name));
    for (const clash of index.slots.clashes) {
      const involved = clash.plugins.filter((p) => installedNames.has(p));
      if (involved.length > 1) {
        conflicts.push({ slot: clash.slot, plugins: involved });
      }
    }
  }
  return {
    ok: true,
    checkedAt,
    summary: { total: rows.length, states: rows.reduce((counts, row) => { counts[row.health.state] = (counts[row.health.state] ?? 0) + 1; return counts; }, {}) },
    dsh: { version: runningDshVersion() },
    profile: { dir: installed.dir, error: installed.error },
    matrix: {
      generatedAt: (index ?? aggregate)?.generatedAt,
      dshVersions: (index ?? aggregate)?.dshVersions ?? [],
      plugins: Array.isArray((index ?? aggregate)?.plugins) ? (index ?? aggregate).plugins.length : ((index ?? aggregate)?.plugins ?? 0),
      ecosystem,
      // The client needs to know whether it can offer a per-plugin verdict:
      // the full index names packages, the aggregate does not.
      hasPerPluginData: index !== undefined,
    },
    upgrade,
    conflicts,
    rows,
  };
}

/**
 * The profile this process is serving. The launcher was given `--profile
 * <name>`; without one the desktop profile is the default. This is the same
 * derivation profileDir() uses — a fix or isolate action must touch the profile
 * the user is looking at, not a hardcoded one.
 */
export function runningProfileName(argv = process.argv) {
  const i = argv.indexOf('--profile');
  const name = i >= 0 ? argv[i + 1] : undefined;
  return name && !name.startsWith('-') ? name : 'desktop';
}

/**
 * The command that performs a panel action, as {file, args, env}.
 *
 * Under the desktop app the process is Electron, so the CLI runs through it
 * with ELECTRON_RUN_AS_NODE — the same way the probe starts a desktop DSH.
 * Everywhere else it is plain node running the CLI entry point.
 */
export function validPackageName(name) {
  return typeof name === 'string' && (name === '@' ? false : /^(?:@[a-z0-9._~-]+\/[a-z0-9._~-]+|[a-z0-9._~-]+(?:-[a-z0-9._~-]+)*)$/.test(name));
}

const profileLocks = new Set();

export function actionCommand(action, plugin, options = {}) {
  if (!['fix', 'isolate'].includes(action) || !validPackageName(plugin)) throw new Error('invalid action or package name');
  if (action === 'fix' && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(options.version ?? '')) throw new Error('exact installed version is required');
  const argv = options.argv ?? process.argv;
  const cli = options.cli ?? argv[1];
  if (!cli) throw new Error('cannot locate the dsh CLI');
  const electron = options.electron ?? Boolean(process.versions.electron);
  const profile = options.profile ?? runningProfileName(argv);
  const prefix = [...(electron ? ['--expose-internals'] : []), cli, 'plugin', '--profile', profile];
  const steps = action === 'fix'
    ? [[...prefix, 'add', `${plugin}@${options.version}`]]
    : [[...prefix, 'remove', plugin]];
  return {
    file: options.execPath ?? process.execPath,
    steps,
    env: electron ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : { ...process.env },
    profile,
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
          const data = payload();
          // The update check is best-effort and never blocks the page: a failed
          // or slow registry lookup leaves `update` undefined.
          const latest = await latestPublishedVersion();
          const current = currentVersion();
          if (latest && current && isNewer(latest, current)) data.update = { current, latest };
          return Response.json(data, { headers: { 'cache-control': 'no-store' } });
        } catch (error) {
          return Response.json({ ok: false, error: String(error?.message ?? error) }, { status: 500 });
        }
      },
    }), 'dsh-plugin-lint-panel: panel route');

    // The action route: fix and isolate operations. Each action is a POST with
    // a JSON body naming the operation and the target plugin.
    scoped.effect(() => register({
      path: ROUTE + '/action',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let plan;
        let removed = false;
        let acquired = false;
        try {
          const origin = request.headers.get('origin');
          if (origin && new URL(origin).origin !== new URL(request.url).origin) return Response.json({ ok: false, error: { code: 'ORIGIN_MISMATCH', message: 'Cross-origin requests are not allowed' } }, { status: 403 });
          const body = await request.json();
          const { action, plugin, confirmed } = body;
          if (!confirmed) return Response.json({ ok: false, error: { code: 'CONFIRMATION_REQUIRED', message: 'Explicit confirmation is required' } }, { status: 400 });
          if (action !== 'fix' && action !== 'isolate') return Response.json({ ok: false, error: { code: 'UNKNOWN_ACTION', message: 'Unknown action' } }, { status: 400 });
          if (!validPackageName(plugin) || plugin.startsWith('@deepseek-ai/')) return Response.json({ ok: false, error: { code: 'INVALID_PLUGIN', message: 'Only community package names are allowed' } }, { status: 400 });
          const installed = installedBundles().bundles?.find((bundle) => bundle.name === plugin && bundle.version);
          if (!installed) return Response.json({ ok: false, error: { code: 'NOT_INSTALLED', message: 'Plugin is not installed in the current profile' } }, { status: 404 });
          plan = actionCommand(action, plugin, { version: installed.version });
          if (profileLocks.has(plan.profile)) return Response.json({ ok: false, error: { code: 'PROFILE_BUSY', message: 'A profile mutation is already running' } }, { status: 409 });
          profileLocks.add(plan.profile);
          acquired = true;
          const execute = ctx.dshPluginPanelExecutor ?? ((file, args, options) => new Promise((resolve, reject) => {
            import('node:child_process').then(({ execFile }) => execFile(file, args, options, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })));
          }));
          for (const args of plan.steps) {
            try { await execute(plan.file, args, { env: plan.env, timeout: 120000 }); }
            catch (error) { return Response.json({ ok: false, error: { code: 'EXECUTION_FAILED', message: String(error?.message ?? error), partial: removed, completed: removed ? ['remove'] : [] } }, { status: 500 }); }
            if (args.includes('remove')) removed = true;
          }
          return Response.json({ ok: true, action, plugin, version: installed.version, profile: plan.profile });
        } catch (error) {
          return Response.json({ ok: false, error: { code: 'BAD_REQUEST', message: String(error?.message ?? error) } }, { status: 400 });
        } finally {
          if (acquired) profileLocks.delete(plan.profile);
        }
      },
    }), 'dsh-plugin-lint-panel: action route');
  });
}

export { payload, runningDshVersion, installedBundles, currentVersion, ROUTE };
void existsSync;
