import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { ToolError } from '../../shared/errors.js';
import { safeEnv } from '../dsh-adapter.js';

const IMAGE = 'node:22-bookworm-slim';

export async function preflightDocker({ runner, timeoutMs = 10000 }) {
  await runner('docker', ['version', '--format', '{{.Server.Version}}'], {
    env: safeEnv(),
    timeout: timeoutMs,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
}

export function createDockerEnvironment({ workDir, sourceDir, profileDir, dshDir, timeoutMs, network, runner, materialize }) {
  const containers = new Set();

  async function execute(stage, dsh, args, env, requestedNetwork) {
    if (dsh.kind === 'desktop') {
      throw new ToolError('ISOLATION_UNSUPPORTED', 'Desktop DSH is not supported by the Docker backend.');
    }
    const name = `dsh-probe-${randomUUID()}`;
    containers.add(name);
    const networkName = requestedNetwork === 'registry' || requestedNetwork === 'bridge' ? 'bridge' : 'none';
    const containerEnv = safeEnv({ HOME: '/profile', DSH_HOME: '/profile', NO_COLOR: '1', ...env });
    const argsForDocker = [
      'run', '--rm', '--name', name,
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--user=1000:1000',
      '--pids-limit=128',
      '--memory=512m',
      '--cpus=1',
      `--network=${networkName}`,
      `--volume=${sourceDir}:/source:ro`,
      `--volume=${profileDir}:/profile:rw`,
      `--volume=${dshDir}:/dsh:ro`,
      '--tmpfs=/tmp:rw,nosuid,nodev,size=128m',
      '--workdir=/profile',
      ...Object.entries(containerEnv).map(([key, value]) => `--env=${key}=${value}`),
      IMAGE,
      dsh.containerNode || 'node',
      ...(dsh.extraArgs || []),
      dsh.containerCli || dsh.cli,
      ...args,
    ];
    const result = await runner('docker', argsForDocker, {
      env: safeEnv(),
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ...result, stage, out: String(result.stdout || '') + String(result.stderr || '') };
  }

  return {
    backend: 'docker',
    isolation: 'docker',
    workDir,
    sourceDir,
    profileDir,
    dshDir,
    materialize,
    async install({ dsh, target, profile = 'headless', env = {} }) {
      const installTarget = typeof target === 'string' ? target : target?.installTarget;
      if (!installTarget) throw new ToolError('ARTIFACT_MISSING', 'No pinned artifact was provided for installation.');
      return execute('install', dsh, ['plugin', '--profile', profile, 'add', installTarget], env, 'registry');
    },
    async boot({ dsh, args, env = {}, network: bootNetwork }) {
      return execute('boot', dsh, args, env, bootNetwork || network);
    },
    async destroy() {
      const removals = [...containers].map((name) => runner('docker', ['rm', '-f', name], {
        env: safeEnv(),
        timeout: 10000,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      }));
      await Promise.allSettled(removals);
      containers.clear();
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}
