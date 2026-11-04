# DSH Plugin Lint 0.4.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不破坏核心 lint CLI/JSON v1 与同步 `lintPackage` 的前提下，完成隔离 probe、可复现 Matrix v2、composition 感知升级、Panel payload v2 和可验证发布链，最终发布 lint 0.4.0 与 Panel 0.2.0。

**Architecture:** 一个稳定核心门面加按领域划分的实验模块；Cell/Index/PanelPayload 共享 v2 契约，v1 仅以 legacy-unpinned 读取。第三方代码在一次性容器中执行，JSON 的生产、复验、发布分离；高权限 job 只处理经过 hash 与 schema 校验的数据，不执行插件。

**Tech Stack:** Node.js 22/24、ESM、Node 内置模块、`node:test`、内置 test coverage、Docker CLI、GitHub Actions、现有 DSH ModuleLoader 与 React。

**Spec:** `docs/superpowers/specs/2026-10-27-dsh-plugin-lint-0.4-design.md`

## Global Constraints

- 不发布 0.3.x；目标版本为 lint `0.4.0`、Panel `0.2.0`。
- `dsh-plugin-lint` 的既有命令、参数、退出码和 lint JSON `schemaVersion: 1` 不变；`lintPackage(dir, options = {})` 始终同步。
- 核心导出保持：`lintPackage`、`loadPackage`、`filesCover`、`maskSource`、`RULES`、`EVENT_TYPES`、`DOC`、`formatText`、`toSarif`、`toBadge`。
- 实验报告、Cell/Index/PanelPayload 新写均为 schema v2；v1 只读迁移为 `legacy-unpinned`，不能产生 verified 或升级推荐。
- 不拆 npm workspaces，不引入构建步骤，不增加外部运行时依赖；测试继续使用 `node:test`。
- Docker 不可用时必须报 `ISOLATION_UNAVAILABLE`；禁止静默回退本机。unsafe-host 只能显式选择，且结果只能是 self-reported。
- 不得展开 `process.env`；只传白名单变量。写权限 CI job 不执行第三方插件、DSH、npm install 或 artifact 中的命令。
- 不得跨 composition 选择最优状态；不确定时返回 unknown/mixed/untested，不给升级背书。
- 不自动上传/下载 profile；`matrix sync` 必须显式给出 source。Panel npm 包只带 aggregate，不带逐插件全量 index。
- 每个任务先写失败测试再实现；不得删除或放宽失败回归。每个任务完成后才允许其提交点，提交不等于发布。
- 总覆盖率门槛：行 ≥85%、分支 ≥80%、函数 ≥80%；Node 22 与 24 都要通过。
- 本轮计划文档的编写不授权实施、git commit、git push、workflow 触发或 npm publish。

## Review Focus

1. **宿主含秘密且没有 Docker**：预期秘密不进入子进程，缺后端时不执行任何插件。由 Task 2 的环境白名单和 fail-closed 测试覆盖。
2. **registry 返回漂移元数据、被篡改 tarball 或“成功但未安装”**：预期拒绝证据并记基础设施错误，而非插件 verdict。由 Task 5 的 artifact/install 测试覆盖。
3. **main 未列入 files、空 files、config-only、否定 glob**：预期与真实 npm pack 一致，既不误报也不漏报。由 Task 3 的差分测试覆盖。
4. **legacy、篡改、混合 composition 或本地自签复验**：预期只读展示或 disputed，绝不升级为可信推荐。由 Task 6、8、9 的数据契约测试覆盖。
5. **Panel 离线、聚合-only、针对自身的 action、executor 输出含秘密**：预期主页面可用、危险 action 被拒绝、错误不泄密。由 Task 10 与 11 的路由和 view-model 测试覆盖。

---

### Task 1: 稳定核心门面与共享基础模块

**Files:**
- Create: `src/shared/errors.js`, `src/shared/status.js`, `src/shared/validate.js`, `src/shared/version.js`, `src/shared/hash.js`
- Create: `src/core/load.js`, `src/core/mask.js`, `src/core/rules.js`, `src/core/report.js`
- Modify: `src/index.js`, `src/load.js`, `src/mask.js`, `src/rules.js`, `src/report.js`
- Test: `test/shared.test.js`, `test/lint.test.js`

**Interfaces:**
- Consumes: 当前 `lintPackage`、core 实现和 lint JSON v1。
- Produces:
  - `new ToolError(code, message, { cause } = {})`，具有 `name: 'ToolError'`、`code`、`cause`。
  - `isPlainObject(value) -> boolean`；`requireFields(value, fields, path) -> string[]`。
  - `CELL_SCHEMA_VERSION = 2`、`EXPERIMENTAL_SCHEMA_VERSION = 2`、`PANEL_PAYLOAD_SCHEMA_VERSION = 2`、`PROBE_VERSION = '0.4.0'`。
  - `stableStringify(value) -> string`；`sha256(value) -> <64 位小写 hex>`。
  - `src/core/*` 提供原实现；旧 `src/load.js` 等仅保留 re-export shim。

- [ ] **Step 1: 写共享模块与核心兼容的失败测试**

```js
test('stableStringify canonicalizes object keys and sha256 is stable', () => {
  const input = { b: 2, a: { d: 1, c: 3 } };
  assert.equal(stableStringify(input), '{"a":{"c":3,"d":1},"b":2}');
  assert.match(sha256(stableStringify(input)), /^[0-9a-f]{64}$/);
});

test('ToolError preserves code and cause', () => {
  const cause = new Error('root');
  const error = new ToolError('ISOLATION_UNAVAILABLE', 'no backend', { cause });
  assert.equal(error.code, 'ISOLATION_UNAVAILABLE');
  assert.equal(error.cause, cause);
});
```

另在 lint 兼容测试中断言 `lintPackage` 的返回值不是 Promise、`schemaVersion === 1`，既有字段 `target/dsh/checks/summary/findings/limits` 均存在。

- [ ] **Step 2: 运行测试，确认新模块不存在导致失败**

Run: `node --test test/shared.test.js test/lint.test.js`
Expected: FAIL，首先出现 `ERR_MODULE_NOT_FOUND: src/shared/...`。

- [ ] **Step 3: 实现共享模块并迁移 core 实现**

将现有 load/mask/rules/report 的实现移到 `src/core/`，内部 import 改为同目录相对路径；旧文件只 re-export，避免一次性改动所有调用方。`src/index.js` 改从 core 导入，暂不删除实验导出。`stableStringify` 只接受 JSON 数据并递归排序 object key；数组顺序不变。

- [ ] **Step 4: 验证核心与现有全部测试**

Run: `node --test test/shared.test.js test/lint.test.js && npm test`
Expected: 新测试 PASS；现有全部测试 PASS，lint JSON 仍为 v1。

- [ ] **Step 5: Commit**

```bash
git add src test/shared.test.js test/lint.test.js
git commit -m "refactor: establish core facade and shared contracts"
```

### Task 2: Probe 隔离环境与 CI 权限边界

**Files:**
- Create: `src/probe/environment.js`, `src/probe/environment/docker.js`, `src/probe/environment/host-unsafe.js`, `src/probe/dsh-adapter.js`
- Modify: `scripts/lib/probe.mjs`, `.github/workflows/matrix-refresh.yml`, `.github/workflows/verify-sample.yml`
- Test: `test/probe-environment.test.js`, `test/workflow-contract.test.js`

**Interfaces:**
- Consumes: Task 1 的 `ToolError`；现有 DSH CLI 调用方式。
- Produces:
  - `createProbeEnvironment({ backend = 'auto', workDir, timeoutMs = 180000, network = 'none', runner } = {}) -> Promise<ProbeEnvironment>`。
  - `ProbeEnvironment.materialize(artifact)`、`.install(input)`、`.boot(input)`、`.destroy()`，均为 async；每次执行使用独立临时容器，destroy 清理所有资源。
  - `safeEnv(overrides = {}) -> object`；`runDsh(dsh, home, args, env = {})`；`runUntilReady(...)`；`resolveDsh(...)`；`startStub()`。
  - `runner` 是可注入的 execFile 适配器，生产默认使用 Node child_process，测试使用 fake。

- [ ] **Step 1: 写秘密隔离、Docker 参数、清理与 workflow 的失败测试**

```js
test('safeEnv drops ambient credentials and keeps only explicit probe values', () => {
  process.env.NPM_TOKEN = 'must-not-leak';
  process.env.PROBE_API_KEY = 'ambient-too';
  const env = safeEnv({ DSH_HOME: '/tmp/profile', PROBE_API_KEY: 'probe' });
  assert.equal(env.NPM_TOKEN, undefined);
  assert.equal(env.DSH_HOME, '/tmp/profile');
  assert.equal(env.PROBE_API_KEY, 'probe');
});

test('auto fails closed when Docker is unavailable', async () => {
  await assert.rejects(
    createProbeEnvironment({ backend: 'auto', runner: unavailableRunner }),
    (error) => error.code === 'ISOLATION_UNAVAILABLE',
  );
  assert.equal(unavailableRunner.executed.length, 0, 'no environment or plugin command is started');
});
```

补充 Docker 测试：`--read-only`、`--cap-drop=ALL`、`--security-opt=no-new-privileges`、非 root、PID/内存限制、network 分阶段和 `destroy` 的强制清理均被断言。workflow 静态测试定位 probe/verify job，要求 `contents: read`、`persist-credentials: false`，且其中没有 PR/git push 步骤。

- [ ] **Step 2: 运行测试，确认当前环境继承和 workflow 权限导致失败**

Run: `node --test test/probe-environment.test.js test/workflow-contract.test.js`
Expected: FAIL；当前缺少环境模块，workflow 仍声明写权限并执行 PR 步骤。

- [ ] **Step 3: 实现环境与适配器，并收窄 CI**

`safeEnv` 只读取白名单键；`runDsh` 和 `runUntilReady` 不再展开 ambient env。Docker 后端用一次性 `docker run --rm` 执行各阶段，宿主机仅挂载受控 workDir；源码只读，只有临时 profile 可写。`host-unsafe` 必须要求显式 `backend: 'host-unsafe'` 并返回 `warning`。

将 matrix-refresh 的 probe 改为只读 artifact job，暂时移除 PR 发布段；verify-sample 同样先改为只读 artifact job。Task 8/9 会加入独立离线 publish job，不能保留旧的“probe 后直接 push”路径。

- [ ] **Step 4: 运行环境测试与现有 probe 测试**

Run: `node --test test/probe-environment.test.js test/workflow-contract.test.js test/probe.test.js`
Expected: PASS；无 backend 时不调用 unsafe-host，现有 probe 单测不因 env 白名单失效。

- [ ] **Step 5: Commit**

```bash
git add src/probe scripts/lib/probe.mjs .github/workflows test/probe-environment.test.js test/workflow-contract.test.js
git commit -m "feat: isolate probe execution from host and CI credentials"
```

### Task 3: 核心规则、packlist 与官方基线

**Files:**
- Create: `src/core/packlist.js`, `src/upgrade/compatibility.js`
- Modify: `src/core/mask.js:119-128`, `src/core/rules.js:19-159`, `src/core/load.js:96-119`, `src/index.js:23-52`, `scripts/e2e-official.mjs`, `.github/workflows/ci.yml`
- Test: `test/packlist.test.js`, `test/lint.test.js`, `test/lint-cli.test.js`, `test/official-baseline.test.js`, `test/upgrade-plan.test.js`

**Interfaces:**
- Consumes: Task 1 的 core/shims 与 `ToolError`。
- Produces:
  - `buildPacklist(dir, manifest) -> { paths: Set<string>, complete: boolean }`。
  - `hasPackedFile(packlist, relPath) -> boolean`；`globToRegExp(pattern) -> RegExp`。
  - `classifyCompatibilityDeclaration(value) -> 'compatible' | 'incompatible' | 'unknown'`。
  - `e2e-official.mjs [fixtures-dir] [--expect <count>]`。

- [ ] **Step 1: 写 E1、E5、工具异常、pending 和空基线的失败测试**

```js
test('E1 ignores FormData and unrelated receivers', () => {
  const report = fixture({
    'package.json': base(),
    'index.js': 'form.append("custom/event", value); other.append("other/event", value);',
  });
  assert.equal(rules(report).includes('E1'), false);
});

test('E5 honors npm automatic main inclusion but not empty-files client inclusion', () => {
  const { dir, manifest } = packageFixture({
    'package.json': base({ files: [], exports: { '.': './index.js', './client': './client.js' } }),
    'index.js': 'export function apply() {}',
    'client.js': 'window.__ModuleLoader__.load({ id: "demo-plugin", factory: () => ({}) });',
  });
  const packlist = buildPacklist(dir, manifest);
  assert.equal(hasPackedFile(packlist, 'index.js'), true);
  assert.equal(hasPackedFile(packlist, 'client.js'), false);
});
```

真实差分测试调用 `npm pack --dry-run --json --ignore-scripts`，解析 `files[].path`，对 main/client/patch/icon/locale 的预期集合逐项比较。另断言 `classifyCompatibilityDeclaration('pending') === 'unknown'`；`lintPackage` 对抛出异常的规则抛 `RULE_FAILED` 且不生成 info finding；官方脚本在 0 个目标、加载异常或 `--expect` 不符时失败。

- [ ] **Step 2: 运行核心回归，确认当前误判与语义差异**

Run: `node --test test/packlist.test.js test/lint.test.js test/lint-cli.test.js test/official-baseline.test.js test/upgrade-plan.test.js`
Expected: FAIL，覆盖 FormData 误报、空 files 漏报、main 误报、pending 退出 0 和空基线 PASS。

- [ ] **Step 3: 实现同步 packlist 与严格规则错误**

E1 仅匹配 `ctx.session.append` 和 `session.append`。packlist 同步处理 npm 固有文件、main、files/空 files、目录、glob、`.npmignore` 与常见排除；不执行 npm 或 package scripts。无法判断时 `complete: false`，E5 不将未知报为缺失。

规则异常用 `ToolError('RULE_FAILED', ...)` 重新抛出并保留 rule id/cause。CLI 对工具错误退出 2。`classifyCompatibilityDeclaration` 只接受 spec 4.4 的明确值。官方脚本记录加载错误并验证实际检查数。

- [ ] **Step 4: 运行差分、官方基线与全量测试**

Run: `node --test test/packlist.test.js test/lint.test.js test/lint-cli.test.js test/official-baseline.test.js test/upgrade-plan.test.js && npm test`
Expected: PASS。

Run: `node scripts/fetch-official-from-npm.mjs --limit 80 && npm run e2e:official -- --expect 80`
Expected: `packages checked: 80`，0 error，PASS；没有 0 包或加载跳过。

- [ ] **Step 5: Commit**

```bash
git add src .github/workflows/ci.yml scripts/e2e-official.mjs test
git commit -m "fix: align lint rules with npm and host semantics"
```

### Task 4: 实验分析迁移与静态误判修复

**Files:**
- Create: `src/experimental/index.js`, `src/experimental/conflicts.js`, `src/experimental/performance.js`, `src/experimental/security.js`
- Modify: `src/index.js`, `src/composition.js`, `src/performance.js`, `src/security.js`, `bin/dsh-plugin-analyze.mjs`, `package.json`
- Test: `test/composition.test.js`, `test/performance.test.js`, `test/security.test.js`, `test/analyze-cli.test.js`

**Interfaces:**
- Consumes: Task 3 的 `buildPacklist` 和 structural mask。
- Produces:
  - package export `./experimental`：`detectConflicts`、`analyzePerformance`、`analyzeSecurityDeep`、`SECURITY_RULES`、`SECURITY_LIMITS`、`EXPERIMENTAL_SCHEMA_VERSION`。
  - `detectConflicts(packages) -> { schemaVersion: 2, ... }`；route claim 为 `{ path, method }`，冲突项含 `resource: '<METHOD> <path>'`、`path`、`methods`。
  - `analyzePerformance(pkg) -> { schemaVersion: 2, ... }`；security/full 同样标记 v2，嵌套 lint 保持 v1。

- [ ] **Step 1: 写 method、故意 reject、glob、structural 和导出的失败测试**

```js
test('different HTTP methods on one path do not conflict', () => {
  const conflicts = detectConflicts([
    pkgWith('a', [['index.js', "connection.fetch.register({ path: '/api/x', methods: ['GET'] });"]]),
    pkgWith('b', [['index.js', "connection.fetch.register({ path: '/api/x', methods: ['POST'] });"]]),
  ]);
  assert.equal(conflicts.routes.length, 0);
});

test('deliberate reject is a decision, not a missing next()', () => {
  const source = "ctx.on('agent/pre-step', () => { return { kind: 'reject' }; });";
  const conflicts = detectConflicts([pkgWith('a', [['index.js', source]]), pkgWith('b', [['index.js', source]])]);
  assert.equal(conflicts.eventListeners.length, 0);
});
```

另断言 `files: ['**/*']` 包含 index.js；`const s = "{{{{";` 不增加 deepNesting；experimental 子路径可导入且报告为 v2；根入口只含 Global Constraints 中的核心导出。

- [ ] **Step 2: 运行实验测试，确认现有实现失败**

Run: `node --test test/composition.test.js test/performance.test.js test/security.test.js test/analyze-cli.test.js`
Expected: FAIL；当前路由只按 path、reject 被误报、glob 连续替换、复杂度使用 masked。

- [ ] **Step 3: 迁移实验模块并修复静态分析**

保留旧文件为 re-export shim；`src/index.js` 移除实验导出，`package.json` 增加 `./experimental`。路由按 method + path，method 缺失只记录 unknown。waterfall 用 `mayFallThrough`，显式非空 return 或 throw 是 decision。

performance 使用真实 packlist，所有复杂度相关函数使用 `file.structural ?? maskSource(file.text).structural`。测试中的伪 pkg 改为真实临时目录 + `loadPackage`，避免掩盖磁盘语义。

- [ ] **Step 4: 运行实验与完整 CLI 测试**

Run: `node --test test/composition.test.js test/performance.test.js test/security.test.js test/analyze-cli.test.js && npm test`
Expected: PASS；四个 analyze 子命令的 stdout/stderr 和退出码契约不变。

- [ ] **Step 5: Commit**

```bash
git add src bin/dsh-plugin-analyze.mjs package.json test
git commit -m "refactor: version experimental analysis and fix static false positives"
```

### Task 5: 固定 Artifact 并统一 Probe 状态

**Files:**
- Create: `src/probe/artifact-resolver.js`, `src/probe/classify.js`, `src/probe/installed-artifact.js`, `src/probe/probe.js`
- Modify: `src/probe/dsh-adapter.js`, `scripts/lib/probe.mjs`, `scripts/probe-boot.mjs`
- Test: `test/artifact-resolver.test.js`, `test/probe.test.js`, `test/probe-integration.test.js`

**Interfaces:**
- Consumes: Task 2 的环境/适配器与 Task 3 的 packlist。
- Produces:
  - `resolveArtifact(target, { fetchImpl = fetch } = {}) -> Promise<Artifact>`；`target` 为字符串或 `{ name, version?, integrity? }`，对象 integrity 是必须与 registry 核对的期望值。
  - `downloadArtifact(artifact, { fetchImpl = fetch, destination } = {}) -> Promise<Artifact>`，返回带 `tarballPath` 的新对象。
  - `verifyIntegrity(bytes, integrity) -> boolean`。
  - `readInstalledArtifact(profileDir, name) -> { version, path }`；缺失或不可读时抛 `ARTIFACT_MISSING`。
  - `classify(bootText, entries, completionSignal) -> status`。
  - `probePackage({ artifact, dsh, environment, stub, tools = false, keep = false, composition = 'headless', audit = false }) -> Promise<ProbeObservation>`；观察结果为 `{ outcome: 'completed' | 'error', result?, error?, install, entries, durationMs, ... }`，供 `createCell` 包装。

- [ ] **Step 1: 写 latest 固定、篡改、加载漂移和 web 分类的失败测试**

```js
test('registry target resolves once to an exact installTarget with integrity', async () => {
  const artifact = await resolveArtifact('demo@latest', { fetchImpl: registryFixture });
  assert.equal(artifact.requestedVersion, 'latest');
  assert.equal(artifact.resolvedVersion, '1.2.3');
  assert.equal(artifact.installTarget, 'demo@1.2.3');
  assert.match(artifact.integrity, /^sha512-/);
});

test('web uses the same non-waiting failure classifier as headless', () => {
  const entries = [{ reason: 'configuration rejected' }];
  assert.equal(classify('ready', entries, true), 'inactive-error');
});
```

另断言：目标对象的 version/integrity 被严格遵守，期望 integrity 与 registry 不一致时失败；`^`、`~`、`*` 等范围返回 `ARTIFACT_SPEC_UNSUPPORTED`，不得回退 latest。SRI 不匹配时 `downloadArtifact` reject 且不产生可 materialize 文件；install 返回成功但 manifest 缺失为 `ARTIFACT_MISSING`；resolvedVersion 与 loadedVersion 不同为 `VERSION_MISMATCH`，且 observation.error.code 匹配、observation.result 为 undefined；registry 非 200/缺 dist 字段为基础设施错误。

- [ ] **Step 2: 运行 probe 回归，确认裸包名与旧 web 分支失败**

Run: `node --test test/artifact-resolver.test.js test/probe.test.js test/probe-integration.test.js`
Expected: FAIL，当前 resolver 取 latest 但不 pin，web 只看 `/Error/`，成功路径不检查安装产物。

- [ ] **Step 3: 实现 resolver、统一分类与安装后验证**

registry 响应必须 `ok` 且具有确切 version、tarball、integrity；使用 Node crypto 验证下载内容。local target 以排序后的 `path + bytes` 计算 sourceDigest，不伪造 registry integrity。

`probePackage` 在 `finally` 中 destroy，无论 install 退出码都调用 `readInstalledArtifact`；版本不一致属于 `run.error`，不输出插件 verdict。web/headless 共用 `classify`，reproduce 始终使用 `installTarget`。

DSH 安装也进入受控环境：解析后的 DSH cache 只能由隔离安装产生；cell 中以只读方式挂载。desktop 在不支持的隔离后端上抛 `ISOLATION_UNSUPPORTED`，unsafe-host 结果只能 self-reported。

- [ ] **Step 4: 运行 resolver/probe 测试与全量测试**

Run: `node --test test/artifact-resolver.test.js test/probe.test.js test/probe-integration.test.js && npm test`
Expected: PASS；所有安装路径都验证真实产物，web 不再把非 Error 失败归为 waiting。

- [ ] **Step 5: Commit**

```bash
git add src/probe scripts/lib/probe.mjs scripts/probe-boot.mjs test/artifact-resolver.test.js test/probe.test.js test/probe-integration.test.js
git commit -m "feat: pin probe artifacts and verify installed versions"
```

### Task 6: Matrix v2、legacy 迁移与组合查询

**Files:**
- Create: `src/matrix/schema.js`, `src/matrix/migrate.js`, `src/matrix/cache.js`, `src/matrix/cell.js`, `src/matrix/index.js`, `src/matrix/manifest.js`
- Test: `test/matrix-schema.test.js`, `test/matrix-index.test.js`

**Interfaces:**
- Consumes: Task 1 的 hash/version/validate 与 Task 5 的 Artifact/Cell 观察结果。
- Produces:
  - `validateCell(value) -> { ok, errors }`；`validateIndex(value)`；`validateManifest(value)`。
  - `readCellAny(value) -> { kind: 'v2' | 'legacy-v1', cell }`；`migrateCellV1(value) -> LegacyCellView`。
  - `cacheKeyFor({ artifact, dshVersion, composition, probeVersion, schemaVersion = 2 }) -> <sha256>`。
  - `createCell(input) -> CellV2`；`buildIndex(cells, { generatedAt, source }) -> IndexV2`。
  - `selectCells(cells, { dshVersion, composition }) -> { kind: 'cells' | 'unknown' | 'mixed' | 'untested', cells }`。
  - `recommendationEligible(cell, { now = Date.now(), maxAgeDays = 30 } = {}) -> boolean`。
  - `buildManifest({ runId, generatedAt, probeVersion, inputs, artifacts }) -> ManifestV2`。

- [ ] **Step 1: 写 cache key、legacy、schema 和 composition 的失败测试**

```js
test('cache key changes with composition and resolved artifact', () => {
  const base = { artifact: artifact123, dshVersion: '0.2.0-rc.2', probeVersion: '0.4.0' };
  assert.notEqual(
    cacheKeyFor({ ...base, composition: 'web' }),
    cacheKeyFor({ ...base, composition: 'headless' }),
  );
});

test('v1 is legacy-unpinned and cannot be recommended', () => {
  const { kind, cell } = readCellAny(v1ActiveVerified);
  assert.equal(kind, 'legacy-v1');
  assert.equal(cell.run.trust, 'legacy-unpinned');
  assert.equal(recommendationEligible(cell), false);
});
```

另断言：缺 composition 时单组合返回 unknown、多组合返回 mixed；明确 composition 只返回精确 cell；verified 但超过 30 天不可推荐；缺 integrity/cacheKey、版本漂移、未知 schema 或损坏字段使 validate 失败；Index 保留同一插件多个版本。

- [ ] **Step 2: 运行测试，确认模块与 v2 行为尚不存在**

Run: `node --test test/matrix-schema.test.js test/matrix-index.test.js`
Expected: FAIL，首先出现 matrix 模块不存在。

- [ ] **Step 3: 实现 v2 schema、只读迁移、index 和 manifest**

legacy 视图保留 `schemaVersion: 1`，设置 `run.trust = 'legacy-unpinned'`、`recommendationEligible = false` 和 `migration.originalTrust`；不得把旧 version 当作已验证 loadedVersion。v2 新 cell 由 `createCell` 生成，trust 默认 self-reported。

`recommendationEligible` 必须同时要求：非 legacy、有效 cacheKey、registry integrity、resolvedVersion === loadedVersion、run.outcome completed、run.trust verified、带复验 provenance、未过期、result.status active。`buildIndex` 拒绝 error/incomplete cell，不静默减少样本。

- [ ] **Step 4: 运行 matrix 契约测试与全量测试**

Run: `node --test test/matrix-schema.test.js test/matrix-index.test.js && npm test`
Expected: PASS；v1 只读可展示但无任何推荐资格。

- [ ] **Step 5: Commit**

```bash
git add src/matrix test/matrix-schema.test.js test/matrix-index.test.js
git commit -m "feat: add reproducible matrix v2 schemas and composition queries"
```

### Task 7: Matrix runner、site 与冲突扫描

**Files:**
- Create: `src/matrix/run.js`, `src/matrix/cells.js`, `src/matrix/conflicts.js`, `src/matrix/site.js`
- Modify: `scripts/matrix/run.mjs`, `scripts/matrix/conflicts.mjs`, `scripts/matrix/site.mjs`
- Test: `test/matrix-run.test.js`, `test/matrix-conflicts.test.js`, `test/matrix-site.test.js`

**Interfaces:**
- Consumes: Task 5 的 resolver/probe/environment 与 Task 6 的 v2 合约。
- Produces:
  - `runMatrix({ targets, targetMode = 'pinned', dshVersions, compositions = ['headless', 'web'], outDir, cacheRoot, concurrency = 4, force = false, keep = false, useTools = true, backend = 'auto', services = productionServices }) -> Promise<{ cells, summary }>`；`targetMode` 仅允许 `pinned | refresh-latest`，`services` 仅供 resolver/environment/probe 的测试替身注入。
  - `cellFilePath(outDir, cell) -> <name>/<resolvedVersion>/<dsh>+<composition>.<cacheKey 前 16 位>.json`。
  - `writeCell(outDir, cell)`；`readCells(dir) -> CellReadResult[]`，递归读取且不忽略损坏文件。
  - `scanConflicts({ cells, materialize, verify = false }) -> Promise<ConflictsV2>`；CLI 支持 `--out <file>` 将结果写到显式路径。
  - `renderSite(index) -> html`；`escapeHtml(value) -> string`。

- [ ] **Step 1: 写单次解析、缓存、纯 UI 冲突、组合与转义的失败测试**

```js
test('one target is resolved once before concurrent cells and cached by full key', async () => {
  const services = fakeMatrixServices();
  const result = await runMatrix(testOptions({ services, concurrency: 4, compositions: ['headless', 'web'] }));
  assert.equal(services.resolveArtifact.calls.length, 1);
  assert.equal(result.summary.completed, 2);
  assert.equal(new Set(result.cells.map((cell) => cell.cacheKey)).size, 2);
});

test('slot scan includes a UI-only plugin and never fetches latest', async () => {
  const report = await scanConflicts({ cells: [uiOnlyV2Cell], materialize: fakeMaterialize });
  assert.equal(report.pluginsScanned.includes('ui-only'), true);
  assert.equal(fakeMaterialize.latestCalls, 0);
});
```

另断言损坏 cache 不被复用；pinned 模式严格遵守目标对象的 version/integrity，只有 refresh-latest 才重新解析 latest 并记录该输入；site 同 DSH 的 headless/web 不压成最优；插件名、title、note 中 `<script>` 被转义；method 不同不冲突，相同才产生候选；任一基础设施错误使 runner 退出 2，负向插件状态不使 runner 失败。

- [ ] **Step 2: 运行测试，确认旧缓存、slot 和 best-of 行为失败**

Run: `node --test test/matrix-run.test.js test/matrix-conflicts.test.js test/matrix-site.test.js`
Expected: FAIL，当前路径不含完整 key、slot 只扫工具插件、site 按 RANK 取最优。

- [ ] **Step 3: 实现 runner、冲突扫描和组合保真 site**

每个 target 在展开任务前 resolve 一次；pinned 默认遵守目标 version/integrity，refresh-latest 必须显式指定并把选择和解析后输入写入 run manifest。每个 DSH/composition 使用独立 environment 和 stub，finally destroy。缓存仅在完整 key 和 schema 匹配且 outcome completed 时复用；error cell 不缓存为成功证据。新写 trust 为 self-reported。

冲突按唯一 name + resolvedVersion + integrity 扫描所有插件，materialize 使用 cell 的 pinned artifact。runtime verify 复用同一 environment；静态候选与 verified 结果分字段。site 对每个 composition 单独展示，并转义所有插入 HTML 的文本。

- [ ] **Step 4: 运行 matrix 测试与全量测试**

Run: `node --test test/matrix-run.test.js test/matrix-conflicts.test.js test/matrix-site.test.js && npm test`
Expected: PASS；无 latest 回查、无跨组合最优、无静默跳过损坏 cell。

- [ ] **Step 5: Commit**

```bash
git add src/matrix scripts/matrix test/matrix-run.test.js test/matrix-conflicts.test.js test/matrix-site.test.js
git commit -m "feat: run and render reproducible composition-aware matrices"
```

### Task 8: 数据导出/同步与 composition 感知升级

**Files:**
- Create: `src/matrix/sanitize.js`, `src/matrix/export.js`, `src/matrix/sync.js`, `src/upgrade/profile.js`, `src/upgrade/planner.js`, `bin/dsh-plugin-matrix.mjs`
- Modify: `bin/dsh-plugin-upgrade-plan.mjs`, `package.json`, `.gitignore`
- Test: `test/matrix-sync.test.js`, `test/upgrade-plan.test.js`

**Interfaces:**
- Consumes: Task 6/7 的 cell/index/conflicts/manifest 和 Task 3 的兼容声明分类。
- Produces:
  - `sanitizeCellForPublish(cell) -> PublicCellV2`，保留结构化事实、消毒 note 和 outputSha256，不含原始输出。
  - `exportPublicArtifact({ cellsDir, conflictsPath, outDir, runId, generatedAt, expectedCells }) -> Promise<ExportResult>`。
  - `verifyPublicArtifact({ dir }) -> Promise<{ ok, errors }>`，重新计算 hash、index、aggregate 和计数。
  - `syncMatrix({ source, outDir, fetchImpl = fetch }) -> Promise<{ manifest, filesWritten }>`。
  - `readProfile(profileDir) -> Profile`；`planUpgrade({ profileDir, matrixDir, from, to, composition }) -> Promise<UpgradeReportV2>`。
  - CLI：`dsh-plugin-matrix export|sync`；upgrade 新增 `--composition headless|web`。

- [ ] **Step 1: 写篡改、路径逃逸、计数、legacy 和组合升级的失败测试**

```js
test('sync rejects a modified artifact and never escapes the output directory', async () => {
  await assert.rejects(
    syncMatrix({ source: tamperedSource, outDir }),
    (error) => error.code === 'ARTIFACT_INTEGRITY_MISMATCH',
  );
  assert.equal(existsSync(join(outDir, '..', 'escape.json')), false);
});

test('legacy active and a different composition cannot justify an upgrade', async () => {
  const report = await planUpgrade({ ...fixture, composition: 'headless' });
  assert.equal(report.summary.compatible, 0);
  assert.equal(report.summary.needsUpdate, 0);
  assert.equal(report.categories.untested.length > 0 || report.categories.unknown.length > 0, true);
});
```

另断言：aggregate 数字被篡改时 verify 失败；v1 active 不推荐；self-reported active 不推荐；缺 composition 返回 unknown/mixed；明确 composition 的 verified active 才 compatible；`pending` 在 check 模式退出 2；source 不含 profile，sync 不执行任何 artifact 内容。

- [ ] **Step 2: 运行数据与升级测试，确认当前行为失败**

Run: `node --test test/matrix-sync.test.js test/upgrade-plan.test.js`
Expected: FAIL，当前无 manifest/hash 链，upgrade 跨组合取最优，pending 被判 compatible。

- [ ] **Step 3: 实现公开 artifact、离线同步与升级模块**

公开目录固定为 `manifest.json`、`index/latest.json`、`index/conflicts.json`、`aggregate.json`、`cells/`。export 只接受 v2 completed cells 和已计算的 conflicts，不下载/执行插件；原始日志只留 hash。同步先写临时目录并验证所有 artifact，再原子替换；文件 path 必须是规范化相对路径且不能逃出 out。

升级优先使用显式 `--composition`，否则读取 `manifest.dsh.profile.composition`；两者都缺失时按 unknown/mixed 处理，不能猜。只有 `recommendationEligible` 的 active cell 可产生 compatible/needsUpdate。保留现有分析退出码和 `--auto-fix` 只打印不执行。根 bin 注册 `dsh-plugin-matrix`，package exports 已含所需 src。

- [ ] **Step 4: 运行同步、升级与全量测试**

Run: `node --test test/matrix-sync.test.js test/upgrade-plan.test.js && npm test`
Expected: PASS；损坏或 legacy 数据不能产生安全升级结论。

- [ ] **Step 5: Commit**

```bash
git add src bin package.json .gitignore test/matrix-sync.test.js test/upgrade-plan.test.js
git commit -m "feat: add verifiable matrix artifacts and upgrade planning"
```

### Task 9: 联邦复验、作者 Action 与数据 PR 闭环

**Files:**
- Create: `src/matrix/verify.js`, `scripts/matrix/verify-public.mjs`
- Modify: `scripts/matrix/verify.mjs`, `bin/dsh-plugin-matrix.mjs`, `.github/actions/probe/action.yml`, `.github/workflows/matrix-refresh.yml`, `.github/workflows/verify-sample.yml`
- Test: `test/federation.test.js`, `test/workflow-contract.test.js`

**Interfaces:**
- Consumes: Task 5 的 pinned probe、Task 8 的 public artifact 校验。
- Produces:
  - `sampleCells(cells, { sample = 0.2, seed = 1, all = false }) -> cells`。
  - `verifyCells({ cells, probe }) -> Promise<VerificationReportV2>`，每项含 `cacheKey/reported/observed/verdict`。
  - `applyVerification(cell, reportEntry, { trustedVerifier = false } = {}) -> cell`，不修改输入。
  - `verify-public.mjs --source <dir>`：publish job 的离线入口。
  - CLI 增加 `dsh-plugin-matrix verify`。

- [ ] **Step 1: 写复验绑定、争议、信任身份与 action/workflow 的失败测试**

```js
test('local confirmation does not self-promote to project verified', () => {
  const updated = applyVerification(selfReportedCell, confirmedEntry);
  assert.equal(updated.run.trust, 'self-reported');
  assert.equal(selfReportedCell.run.trust, 'self-reported', 'input is untouched');
});

test('a different cache key is invalid verification, not comparable evidence', () => {
  assert.throws(
    () => applyVerification(selfReportedCell, confirmedEntryWithOtherCacheKey, { trustedVerifier }),
    (error) => error.code === 'VERIFICATION_KEY_MISMATCH',
  );
  assert.equal(selfReportedCell.run.trust, 'self-reported');
});

test('the same artifact with a different observed status is disputed with both results', () => {
  const updated = applyVerification(selfReportedCell, disputedEntry, { trustedVerifier });
  assert.equal(updated.run.trust, 'disputed');
  assert.deepEqual(updated.run.dispute.reported, selfReportedCell.result.status);
  assert.equal(updated.run.dispute.observed, disputedEntry.observed.status);
});
```

静态 action 测试断言 `github.action_path/../../scripts/matrix/run.mjs` 存在且 `mkdir -p` 位于 `tee` 前。workflow 测试分别定位 probe 与 publish：probe 无秘密/无写权限；publish 不执行 matrix run、probe、DSH 或 npm install，只运行 `verify-public.mjs` 与数据 PR 命令。

- [ ] **Step 2: 运行联邦与 workflow 测试，确认当前闭环失败**

Run: `node --test test/federation.test.js test/workflow-contract.test.js`
Expected: FAIL，当前复验使用裸包名、直接改写 cell，action 路径与 mkdir 顺序错误，publish 职责未分离。

- [ ] **Step 3: 实现独立复验报告与离线发布 job**

复验只接受确切 artifact，比较完整 cache key；cache key 不一致时抛 `VERIFICATION_KEY_MISMATCH`，不把不同 artifact 当作可比较证据。原 cell 不改写。只有 publish 流程传入真实项目 verifier provenance 时才提升 confirmed；只有同一 artifact 的观测分歧才标 disputed 并同时保留 reported/observed。`verify` CLI 默认不传 trustedVerifier。

matrix-refresh 的 probe job 显式使用 `--target-mode refresh-latest` 生成当前快照，publish job 下载 candidate，执行 `verify-public.mjs`，用本地 sync 写入 `matrix/public` 并开 PR，不自动合并。verify-sample 同样拆 probe/publish；checked 为 0 时不产生空 PR。沿用作者通知和人工审查，不把外部数据仓库当作前置条件。

- [ ] **Step 4: 运行联邦、workflow 与全量测试**

Run: `node --test test/federation.test.js test/workflow-contract.test.js && npm test`
Expected: PASS；本地复验不能自签，数据发布 job 没有第三方代码执行路径。

- [ ] **Step 5: Commit**

```bash
git add src/matrix scripts/matrix bin/dsh-plugin-matrix.mjs .github test/federation.test.js test/workflow-contract.test.js
git commit -m "feat: close the federated verification and data publication loop"
```

### Task 10: Panel Host、Payload v2 与 Action 路由

**Files:**
- Create: `panel/shared/payload.js`, `panel/host/profile.js`, `panel/host/matrix.js`, `panel/host/payload.js`, `panel/host/update.js`, `panel/host/actions.js`, `panel/host/routes.js`
- Modify: `panel/index.js`, `panel/package.json`, `panel/README.md`
- Test: `test/panel.test.js`, `test/panel-routes.test.js`

**Interfaces:**
- Consumes: Task 6/8 的 IndexV2、legacy 视图和 aggregate。
- Produces:
  - `PANEL_PAYLOAD_SCHEMA_VERSION = 2`；`validatePanelPayload(value) -> { ok, errors }`。
  - `loadMatrix({ indexPath, aggregatePath, now }) -> MatrixReadModel`。
  - `createPayload({ profile, matrix, checkedAt }) -> PanelPayloadV2`，不访问 registry。
  - `latestPublishedVersion({ fetchImpl = fetch, now = Date.now() } = {}) -> Promise<string | undefined>`。
  - `isProtectedPlugin(name) -> boolean`；`createActionHandler(deps) -> async (Request) => Response`。
  - `registerRoutes(ctx, deps) -> void`，注册 `ROUTE`、`ROUTE + '/action'`、`ROUTE + '/update'`。

- [ ] **Step 1: 写 aggregate-only、独立 update、自保护和 action 的失败测试**

```js
test('aggregate-only payload keeps counts and snapshot metadata without registry access', async () => {
  const response = await routes.get(ROUTE).fetch(postJson(ROUTE, {}));
  const data = await response.json();
  assert.equal(data.schemaVersion, 2);
  assert.equal(data.matrix.hasPerPluginData, false);
  assert.equal(data.matrix.plugins, 50);
  assert.equal(data.matrix.generatedAt, fixtureAggregate.generatedAt);
  assert.equal(registryFetch.calls, 0);
});

test('the server refuses to remove the panel itself', async () => {
  const response = await action(validAction({ plugin: '@shidesheng0218/dsh-plugin-lint-panel' }));
  assert.equal(response.status, 403);
  assert.equal(executor.calls.length, 0);
});
```

另断言：主路由不等待 update；非 JSON 为 415；缺 confirmed 为 400；并发为 409 且 finally 释放锁；executor 失败响应不含 secret/stdout/stderr；legacy cell 为 legacy-unpinned；混合 composition 不选最优；Panel 只 join `bundle.version` 对应的 `versions[]`，不得用同插件其他版本的 cell 代替。

- [ ] **Step 2: 运行 Panel 测试，确认 payload 与 action 缺口**

Run: `node --test test/panel.test.js test/panel-routes.test.js`
Expected: FAIL，当前主 payload 等 registry、schema 为 v1、服务端未保护 Panel 自身，action 路由缺少直接集成测试。

- [ ] **Step 3: 核对 DSH 路由鉴权并实现 Host 分层**

先从当前支持的 DSH 版本源码或官方文档确认 connection.fetch 的 URL token、cookie 与 Origin 语义，将版本和证据写进 `panel/README.md`。根据证据固定“缺 Origin”测试；若依赖 ambient credential，写路由必须有对应 CSRF 防线。不得仅凭缺 Origin 宣称为漏洞。

拆分 host；主 payload 同步拼装本地数据，update 独立请求并保持 4 秒超时/6 小时缓存。所有 action 要求 `content-type: application/json`、`x-dsh-plugin-lint-action: 1`、confirmed、合法包名与安装状态；Origin 存在时校验同源。保留 execFile、profile lock、确切版本，新增 Panel 自保护和脱敏审计。`panel/package.json` 的 files 增加 `host/`、`shared/`。

- [ ] **Step 4: 运行 Host、路由、现有 Panel 与打包测试**

Run: `node --test test/panel.test.js test/panel-routes.test.js && npm test && npm pack ./panel --dry-run --json`
Expected: PASS；payload 为 v2，aggregate-only 仍有完整计数与日期，打包包含 host/shared 且不含本地全量 index。

- [ ] **Step 5: Commit**

```bash
git add panel test/panel.test.js test/panel-routes.test.js
git commit -m "feat: split panel host and secure payload v2 routes"
```

### Task 11: Panel Client 状态、冲突与数据打包

**Files:**
- Modify: `panel/client.js`, `scripts/matrix/bundle-panel-data.mjs`, `panel/data/aggregate.json`, `panel/README.md`
- Test: `test/panel-client.test.js`, `test/panel.test.js`

**Interfaces:**
- Consumes: Task 10 的 PanelPayloadV2 与 update 路由。
- Produces:
  - client 顶层纯函数 `healthBucket(row) -> 'recorded' | 'attention' | 'unverified'`。
  - `summarizeEcosystem(matrix) -> { tallies, plugins, generatedAt, sourceRunId }`，其中 `tallies` 来自 `matrix.ecosystem.versions`。
  - `buildPanelModel(data) -> { rows, counts, total, issues, dshVersions, ecosystem, conflicts, hasPerPluginData }`，其中 `dshVersions` 只用于矩阵列。
  - `bundle-panel-data.mjs` 从 v2 public artifact 生成本地全量快照与可发布 aggregate。

- [ ] **Step 1: 写真实 client 入口的状态与展示失败测试**

用 `vm.runInNewContext` 执行 `panel/client.js`，提供 `window.__ModuleLoader__.load` 捕获注册，再直接调用 context 中的纯函数：

```js
test('recorded-active is recorded history, never a live healthy count', () => {
  const model = buildPanelModel(payloadWithRecordedActive);
  assert.equal(model.counts.recorded, 1);
  assert.equal(model.counts.healthy, undefined);
  assert.equal(model.issues.length, 0);
});

test('aggregate-only data still produces an ecosystem view', () => {
  const model = buildPanelModel(aggregateOnlyPayload);
  assert.equal(model.hasPerPluginData, false);
  assert.equal(model.ecosystem.plugins, 50);
  assert.equal(model.ecosystem.generatedAt, fixtureDate);
});
```

另断言 conflicts 的 tools/slots/routes 进入 model；composition 保持分格；update 请求独立于主 refresh，失败不清空主数据。

- [ ] **Step 2: 运行 client 测试，确认旧健康映射与缺失视图失败**

Run: `node --test test/panel-client.test.js test/panel.test.js`
Expected: FAIL，当前 recorded-active 落入 unverified 且没有 recorded 桶，ecosystem/update/conflicts 未完整进入视图。

- [ ] **Step 3: 实现 view-model、独立 update 和 v2 数据打包**

将纯函数移到 client 顶层，组件保留在工厂内，不增加浏览器 import 或构建步骤。用 recorded/attention/unverified 替代 live healthy 暗示；显示快照日期、来源和逐格 composition。主数据 ready 后独立请求 update，失败仅隐藏提示。

bundle 脚本优先读取 `matrix/public/index/latest.json` 和 `aggregate.json`，验证 schema/hash；本地全量文件仍写 gitignored `panel/data/matrix-index.json`，发布文件只更新 aggregate。文档说明 recorded 不是实时健康，legacy 不推荐。

- [ ] **Step 4: 运行 client、全量、lint 与真实浏览器验证**

Run: `node --test test/panel-client.test.js test/panel.test.js && npm test && node bin/dsh-plugin-lint.mjs panel --no-color --exit-code`
Expected: PASS，Panel 自检 0 error / 0 warn / 0 info。

Run: `node scripts/screenshot-panel.mjs`
Expected: 在一次性 web profile 中完成真实浏览器截图；随后用图片读取工具检查 aggregate、快照日期、历史状态、冲突与更新区域，不能用 mock 页面替代。

- [ ] **Step 5: Commit**

```bash
git add panel scripts/matrix/bundle-panel-data.mjs test/panel-client.test.js test/panel.test.js
git commit -m "feat: make panel evidence and ecosystem state visible"
```

### Task 12: 覆盖率、双 Node CI 与 0.4.0 发布验收

**Files:**
- Create: `scripts/package-smoke.mjs`, `docs/21-release-0.4.0.md`
- Modify: `package.json`, `panel/package.json`, `.github/workflows/ci.yml`, `.github/workflows/publish-lint.yml`, `.github/workflows/publish-panel.yml`, `README.md`, `panel/README.md`, `docs/15-federation.md`, `docs/19-analysis-tools.md`, `docs/20-release-0.3.0.md`
- Test: `test/package-contract.test.js`

**Interfaces:**
- Consumes: 前 11 个任务的全部公开契约。
- Produces:
  - lint `0.4.0`、Panel `0.2.0`；根入口 10 个核心导出，`./experimental` 版本化导出，四个既有 CLI + `dsh-plugin-matrix`。
  - `npm run test:coverage`：行 ≥85%、分支 ≥80%、函数 ≥80%。
  - `node scripts/package-smoke.mjs`：从真实 tarball 安装并执行 CLI/API smoke。

- [ ] **Step 1: 写版本、导出、package files 与发布配置的失败测试**

```js
test('release versions and public surfaces are explicit', async () => {
  assert.equal(rootManifest.version, '0.4.0');
  assert.equal(panelManifest.version, '0.2.0');
  assert.deepEqual(Object.keys(await import('../src/index.js')).sort(), CORE_EXPORTS);
  assert.equal(rootManifest.dependencies, undefined);
  assert.equal(rootManifest.workspaces, undefined);
});
```

另断言 publish workflow 在当前版本已存在时停止并提示，而不是自动 patch bump；Node CI 同时含 22/24；Panel files 含 host/shared/aggregate 且不含 `data/matrix-index.json`。

- [ ] **Step 2: 运行 package contract 测试，确认发布面尚未对齐**

Run: `node --test test/package-contract.test.js`
Expected: FAIL，当前根版本 0.3.0、Panel 0.1.6，CI 只有 Node 22，publish 仍自动 patch bump。

- [ ] **Step 3: 对齐版本、覆盖率、文档和发布 workflow**

设置 `test:coverage` 使用 Node 内置 coverage 与 85/80/80 门槛，不排除难测文件。CI 加 Node 22/24、packlist 差分、官方 80 基线、Panel 自检、package smoke 和独立只读 Docker probe smoke。

publish workflow 保留现有 NPM_TOKEN 方式，发布前必须由仓库管理员配置有效 Automation token；`npm whoami` 失败即停止。当前版本已发布时失败并提示人工核对，禁止自动 patch 掩盖 0.4 发布错误。若要改 Trusted Publishing，另开明确变更，不在本任务静默切换认证体系。

文档更新实际行为；0.3 draft 标为被 0.4 取代，0.4 release notes 在 registry 对账前保持 draft。`scripts/package-smoke.mjs` 从两个真实 tarball 安装，验证所有 CLI `--help`、核心导出和 experimental 导出。

- [ ] **Step 4: 运行完整静态、动态与安装验收**

Run: `npm test && npm run test:coverage && node --test test/package-contract.test.js`
Expected: 全部 PASS，覆盖率行 ≥85%、分支 ≥80%、函数 ≥80%。

Run: `node scripts/fetch-official-from-npm.mjs --limit 80 && npm run e2e:official -- --expect 80 && node bin/dsh-plugin-lint.mjs panel test/probe-plugins --no-color --exit-code && node scripts/package-smoke.mjs`
Expected: 80 包 0 error；Panel 与 fixtures 0 error；真实 tarball 的所有 CLI/API smoke PASS。

Run: `node scripts/matrix/run.mjs --targets matrix/targets-top50.json --target-mode refresh-latest --mode both --concurrency 4 --out /tmp/dsh-matrix-cells-v2 --cache /tmp/dsh-matrix-cache-v2 && node scripts/matrix/conflicts.mjs --cells /tmp/dsh-matrix-cells-v2 --cache /tmp/dsh-matrix-cache-v2 --out /tmp/dsh-matrix-conflicts-v2.json`
Expected: 显式刷新后的同一组 resolved artifacts 在真实 Docker 后端生成 50 × 2 DSH × 2 composition = 200 个 v2 cells；无基础设施错误，`probe.isolation` 全为 docker，resolvedVersion 全等于 loadedVersion，manifest 记录 refresh-latest。冲突数据来自同一批 pinned artifacts。Docker 不存在或 preflight 失败时此验收未完成，禁止改用 unsafe-host 冒充。

Run: `node bin/dsh-plugin-matrix.mjs export --cells /tmp/dsh-matrix-cells-v2 --conflicts /tmp/dsh-matrix-conflicts-v2.json --out matrix/public --run-id local-acceptance --expected-cells 200 && node bin/dsh-plugin-matrix.mjs sync --source matrix/public --out /tmp/dsh-matrix-sync-check`
Expected: 200 cells 的 manifest/index/aggregate 校验通过，显式 sync 的 hash 对账通过；legacy 数据不作为 v2 发布。

Run: `node scripts/matrix/bundle-panel-data.mjs && git diff --check && npm pack --dry-run --json && npm pack ./panel --dry-run --json`
Expected: Panel aggregate 已由同一 v2 artifact 重新生成；无 whitespace 错误；版本和发布文件正确；Panel 不包含本地全量 index。

- [ ] **Step 5: 执行发布前外部检查并记录未决项**

由仓库管理员确认 NPM_TOKEN 已配置且有效；通过受信 CI 跑上述全部检查。没有有效 token、真实 Docker、200-cell 验收或浏览器验收时，明确保留对应发布阻塞，不发布，也不将文档改成“已完成”。

- [ ] **Step 6: Commit 发布候选，随后仅在明确发布授权后执行远端步骤**

```bash
git add package.json panel .github scripts README.md docs test/package-contract.test.js
git commit -m "chore: prepare 0.4.0 and panel 0.2.0 release"
```

获得明确发布授权后才可合并/推送和触发 publish。发布后执行：

```bash
npm view @shidesheng0218/dsh-plugin-lint@0.4.0 version dist.integrity dist.tarball
npm view @shidesheng0218/dsh-plugin-lint-panel@0.2.0 version dist.integrity dist.tarball
```

只有 registry 返回确切版本、workflow 成功且从 registry 再安装 smoke 通过后，才把 release notes 从 draft 改为已发布并记录对账值。

## Plan Self-Review

- **Spec coverage：** Tasks 1–2 对应契约与安全；3–4 对应核心/实验规则；5–7 对应 probe/matrix；8–9 对应同步、升级、联邦和数据 PR；10–11 对应 Panel；12 对应覆盖率、真实验收和发布。
- **接口一致性：** Cell 使用 `plugin/dsh/probe/run/result/evidence/reproduce`；Index 使用 `plugins[].versions[].cells[]`；Panel 使用 `schemaVersion: 2` 和 `matrix.ecosystem`；legacy 不进入 v2 发布。
- **错误边界：** registry、schema、隔离和版本漂移均为工具错误；插件自身 inactive/rejected 才是观察结果。任何基础设施错误不能转换成“兼容”或“不兼容”的插件结论。
- **Review Focus：** 五类高风险输入分别由 Tasks 2、3、5、6/8/9、10/11 的具体断言覆盖，没有留给实施者自行决定“异常时也 PASS”。
- **比例与范围：** 12 个任务按共享契约串行，未把方案写成产品代码；代码块只固定测试预期，函数体与一般实现选择留给实施者。
