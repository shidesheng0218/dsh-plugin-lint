import { rmSync } from 'node:fs';
import { ToolError } from '../../shared/errors.js';
import { runDsh, runUntilReady } from '../dsh-adapter.js';

export function createHostUnsafeEnvironment({ workDir, profileDir, dshDir, timeoutMs, runner, materialize }) {
  // DSH_HOME must be the profile root. The Docker backend mounts the same
  // directory at /profile, so the probe reads profiles/<name> from one place in
  // both backends. Before this, the host backend set DSH_HOME to workDir while
  // probe.js read profileDir, and every non-Docker probe ended in TEMPLATE_FAILED.
  return {
    backend: 'host-unsafe',
    isolation: 'host-unsafe',
    warning: 'UNSAFE: plugin code runs on the host without container isolation.',
    workDir,
    profileDir,
    dshDir,
    materialize,
    async install({ dsh, target, profile = 'headless', env = {} }) {
      const installTarget = typeof target === 'string' ? target : target?.hostPath || target?.installTarget || target?.path;
      if (!installTarget) throw new ToolError('ARTIFACT_MISSING', 'No artifact was provided for installation.');
      const out = await runDsh(dsh, profileDir, ['plugin', '--profile', profile, 'add', installTarget], env, { runner, timeoutMs });
      return { out };
    },
    async boot({ dsh, args, env = {}, readyRe, graceMs = 2500 }) {
      const out = readyRe
        ? await runUntilReady(dsh, profileDir, args, env, readyRe, { timeoutMs, graceMs })
        : await runDsh(dsh, profileDir, args, env, { runner, timeoutMs });
      return { out };
    },
    async destroy() {
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}
