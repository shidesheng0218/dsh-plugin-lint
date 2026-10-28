import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileSnapshot, installedBundles, currentVersion, runningDshVersion, runningProfileName } from './host/profile.js';
import { loadMatrix } from './host/matrix.js';
import { createPayload } from './host/payload.js';
import { isNewer } from './host/update.js';
import { actionCommand } from './host/actions.js';
import { registerRoutes, ROUTE } from './host/routes.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const indexPath = () => process.env.DSH_PLUGIN_LINT_INDEX || join(HERE, 'data', 'matrix-index.json');
const aggregatePath = () => join(HERE, 'data', 'aggregate.json');

export function payload(options = {}) {
  return createPayload({
    profile: profileSnapshot(),
    matrix: loadMatrix({
      indexPath: options.indexPath || indexPath(),
      aggregatePath: options.aggregatePath || aggregatePath(),
      now: options.now || Date.now,
    }),
    checkedAt: options.checkedAt || new Date().toISOString(),
  });
}

export function apply(ctx) {
  registerRoutes(ctx);
}

export { installedBundles, currentVersion, runningDshVersion, runningProfileName, isNewer, actionCommand, ROUTE };
