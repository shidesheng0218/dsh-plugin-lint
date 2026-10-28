import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveArtifact } from '../../src/probe/artifact-resolver.js';
import { createProbeEnvironment } from '../../src/probe/environment.js';
import { probePackage as probePinnedPackage } from '../../src/probe/probe.js';

export { WEB_READY, resolveDsh, runDsh, runUntilReady, startStub } from '../../src/probe/dsh-adapter.js';
export { classify } from '../../src/probe/classify.js';
export {
  capture,
  redact,
  parseInactive,
  awaitedServices,
  rejectionOf,
  noteOf,
  payloadOf,
} from '../../src/probe/probe.js';

export async function probePackage(options) {
  const artifact = options.artifact || await resolveArtifact(options.target);
  const environment = options.environment || await createProbeEnvironment({
    backend: options.backend || 'auto',
    workDir: options.workDir,
  });
  return probePinnedPackage({
    ...options,
    artifact,
    environment,
    composition: options.composition || options.mode || 'headless',
  });
}

export const tmpHome = () => mkdtempSync(join(tmpdir(), 'dsh-probe-'));
