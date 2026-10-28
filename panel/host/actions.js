const profileLocks = new Set();

export function validPackageName(name) {
  return typeof name === 'string' && (name === '@' ? false : /^(?:@[a-z0-9._~-]+\/[a-z0-9._~-]+|[a-z0-9._~-]+(?:-[a-z0-9._~-]+)*)$/.test(name));
}

export function isProtectedPlugin(name) {
  return name.startsWith('@deepseek-ai/') || name === '@shidesheng0218/dsh-plugin-lint-panel';
}

export function runningProfileName(argv = process.argv) {
  const index = argv.indexOf('--profile');
  const name = index >= 0 ? argv[index + 1] : undefined;
  return name && !name.startsWith('-') ? name : 'desktop';
}

export function actionCommand(action, plugin, options = {}) {
  if (!['fix', 'isolate'].includes(action) || !validPackageName(plugin)) throw new Error('invalid action or package name');
  if (action === 'fix' && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(options.version ?? '')) throw new Error('exact installed version is required');
  const argv = options.argv ?? process.argv;
  const cli = options.cli ?? argv[1];
  if (!cli) throw new Error('cannot locate the dsh CLI');
  const electron = options.electron ?? Boolean(process.versions.electron);
  const profile = options.profile ?? runningProfileName(argv);
  const prefix = [...(electron ? ['--expose-internals'] : []), cli, 'plugin', '--profile', profile];
  const steps = action === 'fix' ? [[...prefix, 'add', `${plugin}@${options.version}`]] : [[...prefix, 'remove', plugin]];
  const env = { ...process.env };
  if (electron) env.ELECTRON_RUN_AS_NODE = '1';
  else delete env.ELECTRON_RUN_AS_NODE;
  return { file: options.execPath ?? process.execPath, steps, env, profile };
}

export function createActionHandler(deps = {}) {
  const installedBundles = deps.installedBundles;
  const executor = deps.executor ?? ((file, args, options) => new Promise((resolve, reject) => {
    import('node:child_process').then(({ execFile }) => execFile(file, args, options, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })));
  }));
  return async (request) => {
    let plan;
    let acquired = false;
    let removed = false;
    let action;
    let plugin;
    const started = Date.now();
    try {
      const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (contentType !== 'application/json') return Response.json({ ok: false, error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'JSON is required' } }, { status: 415 });
      if (request.headers.get('x-dsh-plugin-lint-action') !== '1') return Response.json({ ok: false, error: { code: 'ACTION_HEADER_REQUIRED', message: 'The explicit action header is required' } }, { status: 400 });
      const origin = request.headers.get('origin');
      if (origin && new URL(origin).host !== new URL(request.url).host) return Response.json({ ok: false, error: { code: 'ORIGIN_MISMATCH', message: 'Cross-origin requests are not allowed' } }, { status: 403 });
      const body = await request.json();
      ({ action, plugin } = body);
      if (body.confirmed !== true) return Response.json({ ok: false, error: { code: 'CONFIRMATION_REQUIRED', message: 'Explicit confirmation is required' } }, { status: 400 });
      if (action !== 'fix' && action !== 'isolate') return Response.json({ ok: false, error: { code: 'UNKNOWN_ACTION', message: 'Unknown action' } }, { status: 400 });
      if (!validPackageName(plugin)) return Response.json({ ok: false, error: { code: 'INVALID_PLUGIN', message: 'A valid package name is required' } }, { status: 400 });
      if (isProtectedPlugin(plugin)) return Response.json({ ok: false, error: { code: 'PROTECTED_PLUGIN', message: 'This plugin is protected' } }, { status: 403 });
      const installed = installedBundles().bundles?.find((bundle) => bundle.name === plugin && bundle.version);
      if (!installed) return Response.json({ ok: false, error: { code: 'NOT_INSTALLED', message: 'Plugin is not installed in the current profile' } }, { status: 404 });
      plan = actionCommand(action, plugin, { version: installed.version });
      if (profileLocks.has(plan.profile)) return Response.json({ ok: false, error: { code: 'PROFILE_BUSY', message: 'A profile mutation is already running' } }, { status: 409 });
      profileLocks.add(plan.profile);
      acquired = true;
      for (const args of plan.steps) {
        try {
          deps.calls?.push({ file: plan.file, args });
          await executor(plan.file, args, { env: plan.env, timeout: 120000 });
          deps.audit?.({ action, plugin, version: installed.version, profile: plan.profile, outcome: 'success', durationMs: Date.now() - started });
        } catch {
          deps.audit?.({ action, plugin, version: installed.version, profile: plan.profile, outcome: 'error', durationMs: Date.now() - started });
          return Response.json({ ok: false, error: { code: 'EXECUTION_FAILED', message: 'The plugin action could not be completed', partial: removed, completed: removed ? ['remove'] : [] } }, { status: 500 });
        }
        if (args.includes('remove')) removed = true;
      }
      return Response.json({ ok: true, action, plugin, version: installed.version, profile: plan.profile });
    } catch {
      return Response.json({ ok: false, error: { code: 'BAD_REQUEST', message: 'The action request is invalid' } }, { status: 400 });
    } finally {
      if (acquired) profileLocks.delete(plan.profile);
    }
  };
}
