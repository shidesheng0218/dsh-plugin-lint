import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ToolError } from '../shared/errors.js';
import { execFileRunner } from './dsh-adapter.js';
import { createDockerEnvironment, preflightDocker } from './environment/docker.js';
import { createHostUnsafeEnvironment } from './environment/host-unsafe.js';
import { materializeArtifact } from './environment/materialize.js';

export async function createProbeEnvironment({
  backend = 'auto',
  workDir,
  dshDir: sharedDshDir,
  timeoutMs = 180000,
  network = 'none',
  runner = execFileRunner,
} = {}) {
  const parent = workDir ? resolve(workDir) : tmpdir();
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'dsh-probe-'));
  const sourceDir = join(root, 'source');
  const profileDir = join(root, 'profile');
  // A shared dshDir (one per DSH version under the cache root) lets consecutive
  // probe cells reuse the harness install instead of downloading it per cell.
  const dshDir = sharedDshDir ? resolve(sharedDshDir) : join(root, 'dsh');
  // The npm cache behind the pnpm shim is shared too: without it every cell
  // re-downloads pnpm before it can install the plugin.
  const toolDir = join(parent, '.probe-tools');
  for (const dir of [sourceDir, profileDir, dshDir, toolDir]) mkdirSync(dir, { recursive: true });
  chmodSync(root, 0o755);
  chmodSync(sourceDir, 0o755);
  chmodSync(profileDir, 0o777);
  chmodSync(dshDir, 0o777);
  chmodSync(toolDir, 0o777);
  const materialize = (artifact) => materializeArtifact(artifact, sourceDir);
  try {
    if (backend === 'host-unsafe') {
      return createHostUnsafeEnvironment({ workDir: root, profileDir, dshDir, timeoutMs, runner, materialize });
    }
    if (backend !== 'auto' && backend !== 'docker') {
      throw new ToolError('ISOLATION_UNSUPPORTED', `Unsupported probe backend: ${backend}`);
    }
    await preflightDocker({ runner, timeoutMs: Math.min(timeoutMs, 10000) });
    return createDockerEnvironment({ workDir: root, sourceDir, profileDir, dshDir, toolDir, timeoutMs, network, runner, materialize });
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    if (error instanceof ToolError) throw error;
    throw new ToolError('ISOLATION_UNAVAILABLE', 'Docker is unavailable; no plugin code was executed.', { cause: error });
  }
}
