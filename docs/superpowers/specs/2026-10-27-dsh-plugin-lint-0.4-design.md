# DSH Plugin Lint 0.4.0 系统性重构设计

> 状态：已确定方向的设计稿，尚未实施。
>
> 基线：`fix/v0.3-release-readiness` 的 `411d70c`。审计时 120 个单元测试通过、80 个官方包检查通过，但测试通过并未覆盖本文所列的数据可信度、隔离和 Panel 问题。
>
> 发布决策：不单独发布 0.3.x；lint 直接发布 `0.4.0`，Panel 因 payload 破坏性升级发布 `0.2.0`。

## 1. 目标与非目标

### 1.1 目标

1. **执行边界可信**：运行第三方插件时不继承宿主秘密，不在写权限 CI job 中执行插件；没有隔离后端就明确失败，绝不静默回退本机。
2. **证据可复现**：矩阵绑定实际下载版本、integrity、DSH、composition 和探针版本；记录版本必须等于实际加载版本。
3. **核心检查更少误判**：修复 E1、E5、兼容声明判定、web 状态分类和工具异常处理，同时保持核心 API 稳定。
4. **不丢失组合语义**：不得跨 headless/web 取“最优结果”；升级建议必须基于当前 profile 的 composition。
5. **Panel 说人话且离线可用**：展示聚合计数、快照日期、冲突和非阻塞更新提示；历史 active 不再被算作实时 healthy。
6. **发布链可验证**：测试、真实 tarball 安装、数据 PR、npm 发布和 registry 对账都有明确验收命令。

### 1.2 兼容承诺

- `dsh-plugin-lint` 的命令名、现有参数、退出码和 lint JSON `schemaVersion: 1` 保持不变。
- `lintPackage(dir, options = {})` 保持同步，返回顶层形状保持不变；不为 npm pack 差分检查引入异步调用。
- 非实验导出继续由 `src/index.js` 提供：`lintPackage`、`loadPackage`、`filesCover`、`maskSource`、`RULES`、`EVENT_TYPES`、`DOC`、`formatText`、`toSarif`、`toBadge`。
- conflicts、performance、security、matrix、upgrade 和 Panel payload 可以升级；新写统一使用 schema v2。实验函数移到 `./experimental` 子路径，不再承诺根入口的实验导出。
- v1 cell/index 只读迁移，标记 `legacy-unpinned`，保留展示价值；不得产生 `verified` 或升级推荐。
- 不拆 npm workspaces，不引入构建步骤，不增加外部运行时依赖，继续使用 Node 内置模块和 `node:test`。
- lint 与 Panel 仍是两个 npm 包；矩阵数据是独立 artifact，不塞进 lint 包。聚合数据继续随 Panel 发布。

### 1.3 非目标

- 不做完整 JavaScript AST 分析，不引入大型 parser；静态分析继续声明其字面量和启发式边界。
- 不声称测量真实启动时间、内存、浏览器性能或插件安全性。
- 不把 host-half probe 描述成浏览器 client-half 已验证。
- 不自动重装、移除或升级用户插件；写操作始终需要用户在 Panel 中确认。
- 不自动上传或下载本机 profile，不把 profile 当作公共矩阵输入。
- 0.4 不实现 VM 后端；先提供一种真实容器后端及可替换接口。缺少可用后端时，真实矩阵验收不能宣称完成。
- 不假设 `dsh-plugin-lint-data` 已有可用发布链，不为其预先引入凭据或自动上传。

## 2. 审计问题到设计的映射

| 优先级 | 已证实的问题 | 设计处理 |
| --- | --- | --- |
| P0 | probe 展开 `process.env`；写权限 workflow 运行第三方插件 | 环境白名单、一次性容器、只读 probe job 与独立 publish job |
| P0 | 矩阵读取 latest、裸包名安装，128/200 记录偏离 pin | ArtifactResolver 固定 resolvedVersion/integrity，按真实 artifact 缓存和复现 |
| P0 | 23/200 记录版本与加载版本不同 | 安装后无条件核对实际 manifest；不一致记基础设施错误，不记插件 verdict |
| P0 | `pending` 被当成 compatible 并退出 0 | 只接受明确兼容值；其余为 unknown，退出 2 |
| P1 | 任意 `.append` 都可能触发 E1 | 仅识别 `ctx.session.append` 与 `session.append` |
| P1 | E5 不符合 npm 的 main 和空 `files` 语义 | 独立同步 packlist；用真实 `npm pack --dry-run --json` 做差分回归 |
| P1 | web 仍按 `/Error/` 判失败，安装成功路径未校验产物 | headless/web 共用一个分类器；每次安装后都检查产物 |
| P1 | site/upgrade 跨 composition 取最优 | composition 成为查询键；未知或分歧时不给升级背书 |
| P1 | run 永远写 verified，复验未绑定 artifact | 默认 self-reported；复验比较完整 cache key 并保留双方证据 |
| P1 | Panel 聚合、更新和冲突数据算了却不显示 | payload v2、独立更新请求、合并 conflicts 到 Panel 数据 |
| P1 | 历史 `recorded-active` 无法进入 healthy 计数 | 改用 recorded / attention / unverified 三类，历史通过不是实时健康 |
| P1 | 纯 UI 插件漏扫 slot；不同 HTTP 方法被报冲突 | 按所有 pinned 插件扫描；路由按 method + path 判定 |
| P2 | performance 的 `**/*` 得 0 文件，字符串抬高嵌套 | 共享 glob 实现；结构复杂度只用 structural 视图 |
| P2 | probe、Panel action、SARIF 覆盖不足 | 重点补集成和契约测试；总行覆盖 ≥85%，分支 ≥80%，函数 ≥80% |

## 3. 目标结构与依赖方向

```text
src/
  index.js                 # 稳定门面，只暴露核心 API
  core/                    # load / mask / rules / packlist / report
  experimental/            # conflicts / performance / security，schema v2
  probe/                   # artifact、DSH adapter、环境、状态与编排
    environment/           # docker 与显式 unsafe-host 后端
  matrix/                  # cell schema、迁移、缓存、index、冲突、同步
  upgrade/                 # profile reader、composition 感知升级规划
  shared/                  # 状态、版本、错误、数据校验
bin/                       # 参数、输出、退出码；不承载领域逻辑
scripts/                   # 保留现有入口，调用 src 中的实现
panel/
  index.js                 # apply 与必要兼容导出
  host/                    # profile / matrix / payload / routes / actions / update
  client.js                # 独立浏览器入口与纯 view-model 函数
  shared/                  # payload v2 校验与共享状态常量
  data/                    # aggregate.json；本地全量数据不默认发布
matrix/
  public/                  # 经消毒和校验的 v2 manifest/index/conflicts/cells
```

依赖只能沿 `bin/scripts -> 领域模块 -> shared/core` 方向。core 不依赖 probe、matrix 或 Panel；Panel 不反向修改矩阵证据。

目标中的“client 状态映射与组件分离”不能靠新增浏览器 `import` 实现：本项目明确无构建步骤，DSH 对额外模块的解析不能靠猜。0.4 将纯 view-model 函数放在 `client.js` 顶层，组件放在工厂内；测试用 `vm` 执行真实入口并直接调用这些纯函数。Host 按文件拆分，浏览器发行入口保持单文件。

## 4. 核心 Lint 与实验分析

### 4.1 E1：限定 session 接收者

`appendCallSites(masked, strings)` 只返回以下字面调用形式：

- `ctx.session.append("event/type", ...)`
- `session.append("event/type", ...)`

继续允许空白字符，继续屏蔽注释。`FormData.append`、`this.form.append`、`foo.append` 不触发 E1。动态计算的事件名和接收者仍属于静态分析边界，不猜测。

### 4.2 E5：同步 packlist

新增：

```js
buildPacklist(dir, manifest) -> { paths: Set<string>, complete: boolean }
hasPackedFile(packlist, relPath) -> boolean
```

`buildPacklist` 同步读取目录，不调用 npm，不执行 package scripts。E5 和 performance 使用该模块；`filesCover(files, relPath)` 保留原签名，作为通用路径匹配助手，不再单独承担“是否随 npm 发布”的判断。

必须覆盖：

- `main` 指向的 host 文件即使不在 `files` 中也随包；config-only 包不凭空要求 host。
- `files` 缺省与 `files: []` 时，client、patch、icon、locale 仍需按实际目录规则判断；不能一律当作已发布。
- package.json、README、LICENSE 等 npm 固有文件及常见排除规则与 npm 对齐。
- `**/*`、目录、单文件和否定规则使用同一个 glob 实现；不发生连续替换把 `.*` 二次改写的问题。
- 无法完成必要目录判断时 `complete: false`；lint 不把“未知”误报成“缺失”。

测试分两层：纯函数 fixture 验证规则；真实 `npm pack --dry-run --json` 对代表性 fixture 做差分。npm 只存在于测试与验收路径，不是运行时依赖。Node 22 与 24 都执行，差异若来自 npm 版本本身，应收紧实现或声明边界，不能删除失败用例。

### 4.3 工具错误与官方基线

规则内部异常表示 linter 自身失败。`lintPackage` 用带 rule id 和 cause 的工具错误向上抛出；CLI 打印不含秘密的诊断并退出 2。不得降级成 info finding 后让 `--exit-code` 通过。lint JSON v1 不新增“伪 finding”。

`e2e-official.mjs` 增加 `--expect <count>`：目标数必须非零、每个目标都成功产生报告、实际检查数等于期望值，任一加载异常都失败。CI 在抓取 80 个官方包后使用 `--expect 80`，不允许“0 包 PASS”。

### 4.4 兼容声明

`classifyCompatibilityDeclaration(value)` 返回 `compatible | incompatible | unknown`：

- 字符串 `compatible`、`true`、`{ compatible: true }`：compatible。
- 字符串 `incompatible`、`false`、`{ compatible: false }` 及已有明确否定状态：incompatible。
- `pending`、缺省、任意未识别字符串或对象：unknown。

`--check-compatibility` 的退出码继续是 0 / 1 / 2，对应 compatible / incompatible / unknown。

### 4.5 实验静态分析

实验报告顶层增加 `schemaVersion: 2`；`full` 内嵌的 lint 报告仍是 v1。

- conflicts：路由按 method + path 比较，不同方法不冲突；缺少方法信息时只记录未知，不报确定冲突。waterfall 将显式 `return`（包括 `{ kind: 'reject' }`）或 `throw` 视为已有决策，只有可能静默掉出函数的监听器进入提示。
- performance：bundleSize 复用 packlist；函数、嵌套、复杂度和长函数使用 `structural`，字符串中的大括号不计入代码结构。
- security：保持 warn/info 和“线索而非裁决”的语义，不把静态模式升级为安全背书。
- `src/experimental/index.js` 是实验入口；`dsh-plugin-analyze` 保留现有命令和门禁语义。

## 5. Probe：隔离、artifact 与状态

### 5.1 环境接口

```js
createProbeEnvironment(options) -> Promise<ProbeEnvironment>
// options: { backend, workDir, timeoutMs, network }

ProbeEnvironment = {
  materialize(artifact) -> Promise<MaterializedArtifact>,
  install(input) -> Promise<InstallObservation>,
  boot(input) -> Promise<BootObservation>,
  destroy() -> Promise<void>
}
```

`backend: 'auto'` 只选择受支持且通过预检的隔离后端；0.4 实现 `docker`。`docker` 通过 Docker CLI 驱动，不增加 npm 依赖。`host-unsafe` 仅用于单元测试、受信 fixture 和用户显式 `--unsafe-host`，输出必须带醒目警告。自动模式检测不到 Docker 时抛出 `ISOLATION_UNAVAILABLE`，不调用 unsafe-host。

Docker 后端覆盖从 npm 安装的 DSH。安装在 macOS 应用中的 desktop DSH 不能假装可在该容器中运行：0.4 对此返回 `ISOLATION_UNSUPPORTED`；用户显式选择 unsafe-host 才能本机运行，且结果只能是 self-reported，不能由项目流程提升为 verified。

容器要求：非 root、只读源码和 root filesystem、独立可写临时 profile、drop capabilities、no-new-privileges、PID/CPU/内存限制。`destroy` 在 `finally` 中执行；超时清理整个容器或进程组，不只杀父进程。

环境变量采用白名单，不展开 `process.env`。仅传递 `PATH`、`HOME`、`DSH_HOME`、必要的 `ELECTRON_RUN_AS_NODE`、`NO_COLOR` 和 stub 专用的 `PROBE_API_KEY`；按需加入明确列出的 locale 变量。token、代理凭据、npm 凭据、CI secret 和任意 `*KEY*`/`*TOKEN*` 不得透传。

网络分阶段：解析/安装只允许显式 registry 来源；boot 默认无外部网络，只允许本地 stub。不得为了“让插件工作”开放全网。CI 不挂载 checkout 凭证、SSH socket、Docker socket 或用户 profile 给不受信代码。

### 5.2 ArtifactResolver

```js
resolveArtifact(target, options) -> Promise<Artifact>
// Artifact: {
//   name, requestedVersion, resolvedVersion, integrity,
//   tarballUrl, installTarget, local, sourceDigest
// }
```

registry target 可以是字符串或 `{ name, version?, integrity? }`。`requestedVersion` 只接受 latest/明确 dist-tag/确切版本；版本范围（如 `^`、`~`、`*`）以 `ARTIFACT_SPEC_UNSUPPORTED` 拒绝，不用自写的宽松 semver 逻辑猜测。目标对象带有 version 时必须解析该版本，integrity 同时作为期望值与 registry 元数据核对；任何不匹配都失败，不能回退 latest。字符串裸包名表示显式请求 latest。

`runMatrix` 默认 `targetMode: 'pinned'`，严格遵守目标文件中的 version/integrity。只有显式 `targetMode: 'refresh-latest'` 才把目标文件当作名称种子并重新解析 latest；该选择和解析后的输入必须进入 run manifest，不能把忽略 pin 变成默认行为。所有 target 在安装任务展开前只解析一次，`resolvedVersion` 必须是确切版本，`installTarget` 必须是 `name@resolvedVersion`，并记录 tarball URL 和 integrity。下载后使用 Node crypto 验证 SRI，再允许 materialize。

local target 记录 manifest 版本与排序后的 `path + bytes` sourceDigest，默认 `self-reported`，没有 registry integrity，不进入公共 verified 或升级推荐。

缓存键为规范化 JSON 的 SHA-256，输入恰好包含：

```text
name + resolvedVersion + integrity/sourceDigest + dshVersion
+ composition + probeVersion + cellSchemaVersion
```

同一次运行不能因并发重复解析出不同 latest。缓存文件存在但 schema、hash 或关键字段不匹配时，视为无效缓存，而不是可直接复用的证据。

### 5.3 安装与加载版本核对

无论 install 进程退出码是什么，都读取 profile 中实际的 `node_modules/<name>/package.json` 和安装锁定信息：

- 退出失败但 artifact 已落地：记录 `ok-with-warnings`，仍必须完成版本核对。
- 退出成功但 artifact 缺失：基础设施错误，不输出 active。
- `resolvedVersion !== loadedVersion`：`VERSION_MISMATCH` 基础设施错误，不输出插件 verdict。
- 明确的 DSH 拒绝：保留 `rejected-by-host` 与原始原因。
- 原始 reproduce 命令包含确切 `name@resolvedVersion`、DSH 和 composition，不再使用裸包名。

### 5.4 状态和错误分层

`classify(bootText, entries, completionSignal)` 同时服务 headless 与 web：任何非 waiting 的 inactive entry 都是 `inactive-error`；纯 waiting 是 `awaiting-service`；无 entry 时再检查完成信号。web 以 readiness 作为完成信号，headless 以 MISSING_CREDENTIAL 或工具请求作为完成信号。

`run.outcome` 区分 `completed` 与 `error`。隔离不可用、registry/integrity 失败、模板失败、超时、加载版本不一致和 schema 错误属于工具/基础设施错误；不能包装成某个插件不兼容。`install-failed`、`boot-failed` 只保留给有对应宿主证据的观察结果，升级规划也不得把它们与等待服务混为一谈。

错误对象包含稳定 `code`、可展示的安全消息和可选 cause；公共 artifact 不写入秘密、完整环境或未消毒日志。

单次 probe 或矩阵运行只有在全部请求的 cell 都完成时才退出 0；active、awaiting-service、inactive-error 等插件观察结果本身不使矩阵失败。任一隔离、registry、schema 或基础设施错误使命令退出 2，同时保留错误 cell 供诊断；空目标、无法生成 manifest 或部分 cell 缺失也算失败，不能用已完成部分冒充完整矩阵。

## 6. Matrix v2、迁移与冲突

### 6.1 Cell v2

```json
{
  "schemaVersion": 2,
  "cacheKey": "<sha256>",
  "plugin": {
    "name": "example-plugin",
    "requestedVersion": "latest",
    "resolvedVersion": "1.2.3",
    "loadedVersion": "1.2.3",
    "integrity": "sha512-...",
    "local": false
  },
  "dsh": { "version": "0.2.1-alpha.2", "source": "npm", "composition": "web" },
  "probe": {
    "version": "0.4.0",
    "isolation": "docker",
    "host": { "os": "linux-x64", "node": "v22.x" }
  },
  "run": {
    "outcome": "completed",
    "at": "<iso-time>",
    "durationMs": 1234,
    "trust": "self-reported"
  },
  "result": {
    "status": "active",
    "awaitedServices": [],
    "entries": [],
    "clientHalf": "not-covered"
  },
  "evidence": { "note": "<redacted>", "outputSha256": "<sha256>" },
  "reproduce": { "command": "... example-plugin@1.2.3 ... --mode web" }
}
```

`run.outcome: error` 时以 `run.error.code` 表达基础设施问题，不伪造 `result.status`。新写的 trust 只能是 self-reported / verified / disputed；stale 是展示时按时间计算的状态，不回写成新的观测事实。

### 6.2 v1 只读迁移

`migrateCellV1(value)` 接受旧字段并生成统一读取视图，标记 `run.trust: 'legacy-unpinned'` 和 `recommendationEligible: false`，同时保留原始 trust 作为 migration 元数据。它不能把旧 version/integrity 空白“补全”为事实，不能升级为 verified，不能参与新版本推荐。

损坏 JSON、未知 schema、关键字段缺失和 hash 不匹配都计入拒绝清单；发布或同步遇到它们必须失败，不能悄悄跳过形成“样本变少但 PASS”。

### 6.3 Index v2 与 manifest

Index 按插件多个版本组织，不再只保留 latest：

```text
plugins[] = {
  name,
  versions[] = { version, integrity, cells[] }
}
cells[] = { cacheKey, dsh, composition, status, trust, at,
            toolsAdded, audit, systemPromptChars, clientHalf, reproduce }
```

`index.conflicts` 同时携带 tools、slots、routes。Panel 从该位置读取，不再期待生成器从未写出的 `index.slots`。

`manifest.json` 包含 `schemaVersion: 2`、`runId`、`generatedAt`、`probeVersion`、`inputsSha256` 和 `artifacts[]`。每个 artifact 记录相对 path、bytes 和 sha256。`inputsSha256` 来自 targets、DSH、compositions、probeVersion 的规范化 JSON，避免自引用 hash。

聚合文件只包含版本计数、distinct 插件数、DSH 列表、生成时间和来源 run，不含包名或本机 profile。快照日期与来源必须随 aggregate 进入 Panel。

### 6.4 不再取跨组合最优

`selectCells(cells, { dshVersion, composition })` 只选择精确组合。缺 composition 时：

- 只有一种已测 composition：返回 `unknown`，因为当前 profile 是否匹配仍未知。
- 多种 composition 有结果：返回 `mixed`，逐项展示，不合并成 active。
- 明确 composition 无对应 cell：返回 `untested`。

只有 v2、cache key 完整、resolvedVersion 等于 loadedVersion、registry integrity 存在、trusted verification 通过、未过期且 status 为 active 的 cell 才可产生升级推荐。

### 6.5 冲突扫描

静态 conflicts 与 runtime conflicts 都使用 pinned artifact，不再回查 latest。slot 扫描遍历所有有 cell 的唯一插件版本，包括没有注册工具的纯 UI 插件。tool 冲突按 DSH 和 composition 分组；路由按 method + path；冲突复验使用同一 artifact 组合和同一隔离接口。

`matrix/index/conflicts.json` 与 index 使用相同 v2 词汇，并合并进 Panel 的本地快照。静态候选与运行时确认保持不同字段，不能将候选写成宿主已拒绝。

## 7. 数据导出、同步与联邦

### 7.1 显式命令

新增实验 `dsh-plugin-matrix` 入口，保留原有脚本作为薄 wrapper：

```bash
dsh-plugin-matrix export --cells <dir> --out matrix/public
dsh-plugin-matrix sync --source <https-url-or-dir> --out <dir>
dsh-plugin-matrix verify --cells <dir> --sample 0.2 --seed <n>
```

- export：校验 v2、重新生成 index/aggregate/conflicts、消毒公开证据、计算 manifest 和 hash。公开文件保留结构化事实；原始输出不发布，只留 hash 和消毒 note。
- sync：只读取显式 source 的 manifest 及其声明文件，限制路径、文件数与大小，下载后核对 sha256，再原子写入临时目录并替换。不得执行 artifact 中的 JS、shell、Frontmatter 命令或 package scripts。
- 默认没有隐式远端，不在 Panel 打开时自动同步，不上传 profile。URL 的跳转、超时和 TLS 由显式 fetch 策略控制；文件写入不能逃出 out。
- 本地 v1 仍可由 upgrade/panel 以 legacy-unpinned 读取；远端发布只接受 v2。

### 7.2 当前仓库的数据 PR 链

0.4 选择当前仓库 `matrix/public/` 作为可审查的数据 artifact，不把外部数据仓库当成前置条件。

`matrix-refresh.yml` 拆成：

1. `probe` job：`contents: read`、无秘密、`persist-credentials: false`，在隔离环境运行第三方插件，上传消毒后的 candidate artifact。
2. `publish` job：仅在受信分支的 schedule/workflow_dispatch 成功后运行，拥有必要的 contents/pull-requests 写权限；下载 JSON，重新执行 schema、路径、hash、计数和转义校验，然后只对 `matrix/public/` 生成 PR。

publish job 不运行插件、DSH、npm install 或 artifact 中提供的任何命令。两个职责不能重新合并。manifest hash 证明下载内容未损坏或被替换，不证明发布者身份；source 的真实性与 trusted verifier 的 workflow provenance 必须分别展示。数据 PR 不自动合并，继续沿用现有作者通知与人工复核流程。后续若迁移到 `dsh-plugin-lint-data`，沿用同一 manifest 与 sync，不改变 cell schema。

### 7.3 复验与信任

生产者始终写 self-reported，包括本项目自己的首次跑批。

复验输出独立 VerificationReport v2：`verifier` 记录 workflow、runId、URL 和 probeVersion；每项检查包含 cacheKey、reported、observed 和 confirmed/disputed。原始 cell 不覆盖。

只有受信的项目复验 workflow、且 resolvedVersion、integrity、DSH、composition、probe/schema 关键项完全一致时，confirmed 才可在发布物中提升为 verified，并附复验 provenance。cacheKey 不一致表示复验输入不可比较，拒绝该记录并报 `VERIFICATION_KEY_MISMATCH`，不能包装成 confirmed 或 disputed。只有同一 artifact 的观测状态分歧才保留原观测与复验观测并标 disputed；本地用户运行 verify 不得自签成项目 verified。

这里的 verified 表示“由项目独立流程复跑一致”，不是密码学签名，也不是安全或兼容保证。

### 7.4 作者 action

composite action 使用 `${{ github.action_path }}/../../scripts/matrix/run.mjs` 定位仓库脚本，并在 `tee` 前创建输出目录。它输出 v2 self-reported cells；不能在作者仓库里直接生成项目 verified。路径与步骤顺序加入静态契约测试。

## 8. Upgrade planner

`src/upgrade/profile.js` 统一读取 bundles、实际安装版本和 composition；`src/upgrade/planner.js` 统一 v2 查询与分类；CLI 只负责呈现。

分析模式增加 `--composition headless|web`；若未提供，则读取 profile 中明确的 composition。仍无法确定时按 6.4 返回 mixed/unknown，不取最优。

- compatible：当前确切版本在目标 DSH + 当前 composition 下具有推荐资格的 active cell。
- needsUpdate：当前版本不满足，但另一个确切版本满足全部推荐条件。
- noCompatibleVersion：有适用于当前组合的可信证据，但没有可用版本。
- untested / unknown / mixed：数据不足、legacy、self-reported、版本或 composition 不确定；不能写成“安全升级”。
- firstParty：继续单列，不由社区矩阵推断。

`--check-compatibility` 仅使用 4.4 的声明分类，不依赖矩阵。分析模式继续离线，退出码语义不变；`--auto-fix` 只打印命令，不执行。

## 9. Panel 0.2.0

### 9.1 Host 拆分与 payload v2

- `host/profile.js`：profile、安装版本、运行 DSH 与 composition。
- `host/matrix.js`：v2 index/aggregate 读取、v1 legacy 视图、30 天 stale 派生。
- `host/payload.js`：纯数据拼装，不访问 npm registry。
- `host/update.js`：独立更新检查，4 秒超时和 6 小时缓存。
- `host/actions.js`：actionCommand、保护名单、profile lock、executor 和审计。
- `host/routes.js`：注册 payload/action/update 路由，统一错误响应。

主 payload 包含 `schemaVersion: 2`、checkedAt、profile、matrix、summary、rows、conflicts 和 ecosystem。即使 `hasPerPluginData: false`，也必须携带 aggregate 的版本计数、distinct 插件数、generatedAt 和 sourceRunId。

更新改为 `POST ROUTE/update` 的独立请求；主 payload 不等待 registry。更新失败只影响更新提示，不清空主页面，不在主路径重复打网络请求。

### 9.2 统一状态语言

client 的纯函数 `healthBucket`、`buildPanelModel`、`summarizeEcosystem` 使用三类桶：

- `recorded`：recorded-active；文案为“历史检查通过”，不是“当前健康”。
- `attention`：recorded-failure、missing-install，以及明确需要用户处理的状态。
- `unverified`：waiting、stale、mixed、unknown、installed 和无精确匹配。

后端不再把历史 probe 当实时健康检查；`verified` 也只是证据来源与复验状态。每行优先展示版本、composition、日期和 trust，而不是一个绿灯。

矩阵表格逐格展示 composition，不按最优状态压平。conflicts 展示 tools/slots/routes 的候选和验证状态。生态区块在无逐插件数据时仍显示计数和快照日期，插件行显示 uncovered，不伪造成 0 个插件。

### 9.3 Action 与路由安全

保留 execFile、确切安装版本、profile lock 和用户确认；服务端同时拒绝 first-party 与 Panel 自身的 fix/isolate，不能只靠 client 隐藏按钮。

所有 action 校验 `content-type: application/json`、自定义头 `x-dsh-plugin-lint-action: 1`、合法包名、action、confirmed 和当前 profile 安装状态。错误响应使用稳定 code 和通用消息；审计只记录 action/plugin/version/profile/outcome/duration，不记录 env、argv、stdout、stderr 或 token。

项目内 reference 没有给出完整 Origin/CSRF 官方语义，因此不能把“缺 Origin”直接定性为漏洞。实施 action 路由前必须核对当前支持 DSH 版本的 connection.fetch 鉴权实现或官方文档：

- 若已有不可猜测 URL token 等独立鉴权，记录证据，不把缺 Origin 当漏洞。
- 若依赖浏览器 ambient credential，写路由必须增加与该模型匹配的 CSRF 防线。
- 无论结论如何，保留“Origin 存在时必须同源”、JSON 自定义头和显式确认；缺 Origin 是否接受必须按上述证据决定并固定测试。

### 9.4 Panel 测试

Host 用 fake connection 捕获真实路由注册，并调用 handler 覆盖 payload、update、action 成功与失败。重点包括自保护、非法输入、并发 409、锁释放、executor 失败消毒、离线 update 和 aggregate-only。

client 用 `vm` 执行真实 `client.js`，直接测试顶层纯函数，验证 recorded-active 不进入 healthy、aggregate-only 仍有生态视图、不同 composition 不合并、冲突与更新提示可见。最后再用一次性 web profile 做真实浏览器验收，不能用 mock 截图代替。

## 10. CI、覆盖率与发布

### 10.1 CI 分层

- `ci.yml`：Node 22、24 矩阵；单测、覆盖率、官方包 80 个基线、panel 自检、packlist 差分、真实 tarball 安装与 CLI/API smoke。
- probe jobs：只读、无秘密、隔离执行，产 JSON artifact。
- publish jobs：独立高权限，只做离线校验、聚合、PR 或 npm publish，不执行第三方插件。
- pull_request 来自 fork 时不得获得写权限或发布秘密；发布条件不能只看 `github.event_name`。

### 10.2 测试策略

继续使用 `node:test`，不为测试引入新框架。每阶段先写失败回归，再实现最小代码，再运行对应文件和总测试。

重点覆盖：

- probe env 白名单、backend 缺失、超时和进程组清理、artifact 完整性、安装版本不一致。
- packlist 的 main、空 files、config-only、glob、npm 差分。
- headless/web 同分类、成功退出但安装缺失、registry 失败。
- v1 legacy、损坏/篡改 artifact、composition 缺失和分歧、复验身份与 cache key。
- Panel action 全路由、client 纯状态、aggregate-only、更新失败。
- JSON v1、experimental v2、SARIF、所有 CLI 的 stdout/stderr 与退出码。

总覆盖率门槛为行 ≥85%、分支 ≥80%、函数 ≥80%。不能用排除难测文件的方式达标；容器测试用 fake runner 覆盖参数与生命周期，另以真实隔离 smoke 验证实际后端。

### 10.3 阶段退出条件

| 阶段 | 内容 | 退出条件 |
| --- | --- | --- |
| 1 | 契约与安全底座 | 核心导出/JSON v1 不变；无 secret 继承；无 backend 时 fail closed；probe CI 无写权限 |
| 2 | 核心与实验规则 | E1/E5/compat 回归通过；80 官方包非空且 0 error；packlist 差分通过 |
| 3 | Probe 与 Matrix v2 | pinned 安装与完整性验证通过；web 非 Error 失败正确；缓存/迁移/组合测试通过 |
| 4 | 数据、升级与联邦 | 篡改数据被拒绝；v1 不推荐；复验不覆盖原证据；数据 PR 只经离线校验 |
| 5 | Panel | host/action/client 测试通过；aggregate-only 有内容；真实一次性 web profile 页面可用 |
| 6 | 发布 | Node 22/24 CI 全绿；覆盖率达门槛；真实包安装成功；registry 版本和文件对账完成 |

每个阶段可以独立审查和验证，但不得把中间阶段当作已发布版本。全部阶段完成后才发布 0.4.0 / Panel 0.2.0。

### 10.4 发布验收

1. 根 package 改为 `0.4.0`，Panel 改为 `0.2.0`；不再发布 0.3.x。
2. README、Panel README、experimental 文档和 federation 文档同步，旧 0.3 draft 标为被 0.4 取代；修改相关代码注释，删除“无沙箱默认可接受”等旧行为描述。
3. 对 lint 与 Panel 执行 `npm pack --dry-run --json`，核对 files、版本和聚合数据；全量本地 matrix-index 不进入 npm Panel。
4. 从真实 tarball 安装，验证四个既有 CLI、新 matrix CLI、核心导出和 `./experimental`。
5. 修复发布认证：配置有效 npm Automation token，或改用 npm Trusted Publishing；二选一，以仓库实际配置为准，不在文档或日志暴露秘密。
6. publish workflow 在发布前运行 Node 22 全套检查；禁止自动 patch bump 掩盖“本次应是 0.4.0/0.2.0”的版本错误。
7. 发布后执行 `npm view <name>@<version> version dist.integrity dist.tarball` 与真实安装对账；workflow 未成功或 registry 不存在时不得写“已发布”。

真实隔离矩阵要求至少一个受支持后端上的端到端 probe 通过；无法提供后端时必须保留发布阻塞，不能用 unsafe-host 结果替代。80 官方包静态基线与矩阵动态验收是两项不同检查，不能互相替代。

## 11. 设计自审结论

- **范围**：这些模块共享同一 v2 cell/index/panel 契约，不适合拆成互不依赖的发布；采用一个计划内六阶段，而非并行修改无契约的子系统。
- **兼容性**：稳定范围只包括核心 lint 与既有 CLI；实验 schema、Panel payload 和数据 artifact 均有明确版本迁移，未暗中扩大“稳定”承诺。
- **安全**：没有把缺 Docker、缺 Origin、缺 token 或缺数据仓库硬说成相同问题；每一项都有 fail-closed 或证据前置的处理。
- **可实现性**：packlist 保持同步；npm pack 只用于测试；client 不依赖未经证实的浏览器模块加载；数据发布不依赖尚不存在的外部自动化。
- **歧义**：verified、active、healthy、compatible、unknown、self-reported、legacy-unpinned 的含义分开；跨 composition 的最优合并被明确禁止。
- **验收**：所有“通过”均有对应命令或真实场景；文档中的当前审计结果不是未来实现的验证结果。
