import { rmSync } from 'node:fs';
import { ToolError } from '../../shared/errors.js';
import { runDsh, runUntilReady } from '../dsh-adapter.js';

export function createHostUnsafeEnvironment({ workDir, profileDir, timeoutMs, runner, materialize }) {
  return {
    backend: 'host-unsafe',
    isolation: 'host-unsafe',
    warning: 'UNSAFE: plugin code runs on the host without container isolation.',
    workDir,
    profileDir,
    materialize,
    async install({ dsh, target, profile = 'headless', env = {} }) {
      const installTarget = typeof target === 'string' ? target : target?.hostPath || target?.installTarget || target?.path;
      if (!installTarget) throw new ToolError('ARTIFACT_MISSING', 'No artifact was provided for installation.');
      const out = await runDsh(dsh, workDir, ['plugin', '--profile', profile, 'add', installTarget], env, { runner, timeoutMs });
      return { out };
    },
    async boot({ dsh, args, env = {}, readyRe, graceMs = 2500 }) {
      const out = readyRe
        ? await runUntilReady(dsh, workDir, args, env, readyRe, { timeoutMs, graceMs })
        : await runDsh(dsh, workDir, args, env, { runner, timeoutMs });
      return { out };
    },
    async destroy() {
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}
