import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileSnapshot, installedBundles, currentVersion, runningDshVersion, runningProfileName } from './host/profile.js';
import { loadMatrix } from './host/matrix.js';
import { createPayload } from './host/payload.js';
import { isNewer } from './host/update.js';
import { actionCommand } from './host/actions.js';
import { registerRoutes, ROUTE } from './host/routes.js';
import { maybeRefreshInBackground, defaultCacheDir } from './host/sync.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// Resolution order for per-plugin data: an explicit override, then the synced
// cache under the active profile, then the snapshot bundled into the npm
// package (which ships only aggregate counts). The aggregate file is always
// the last-resort source. The cache lives in the profile, not the package,
// because an installed package directory may be read-only.
const cacheDir = () => process.env.DSH_PLUGIN_LINT_CACHE || defaultCacheDir();
const bundledIndexPath = () => join(HERE, 'data', 'matrix-index.json');
const aggregatePath = () => join(HERE, 'data', 'aggregate.json');

function resolveIndexPath(explicit) {
  if (explicit) return explicit;
  if (process.env.DSH_PLUGIN_LINT_INDEX) return process.env.DSH_PLUGIN_LINT_INDEX;
  const dir = cacheDir();
  if (dir) {
    const cached = join(dir, 'index', 'latest.json');
    try {
      if (existsSync(cached)) return cached;
    } catch { /* fall through to the bundled snapshot */ }
  }
  return bundledIndexPath();
}

export function payload(options = {}) {
  return createPayload({
    profile: profileSnapshot(),
    matrix: loadMatrix({
      indexPath: resolveIndexPath(options.indexPath),
      aggregatePath: options.aggregatePath || aggregatePath(),
      now: options.now || Date.now,
    }),
    checkedAt: options.checkedAt || new Date().toISOString(),
  });
}

export function apply(ctx) {
  // Render with whatever local data exists, then refresh in the background.
  // A failed refresh must never affect the panel: it is fire-and-forget.
  maybeRefreshInBackground({ cacheDir: cacheDir() });
  // Pass the resolvers explicitly: the route module's own defaults only honour
  // options supplied by a caller, so registering without them rendered an empty
  // matrix and rejected every action with 400.
  registerRoutes(ctx, { payload, installedBundles });
}

export { installedBundles, currentVersion, runningDshVersion, runningProfileName, isNewer, actionCommand, ROUTE };
