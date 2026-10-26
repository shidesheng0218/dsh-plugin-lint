# 19 · 分析工具（experimental）

## 0. 状态与范围

v0.3.0 新增四项分析能力：组合冲突检测、性能分析、安全深析、升级路径。四项都标记为 **experimental**：

- 全部是对磁盘文件的**静态启发式检查**——不执行插件、不做运行时测量、不做安全裁决；
- `analyze` 的结果对象带 `experimental: true` 与 `limits` 数组（`full` 的 `limits` 在 performance/security 子报告里），报告自己说明边界；`upgrade-plan` 的 JSON 不带这两个字段；
- 干净运行只代表没有模式命中，不代表插件安全、快速或可组合。

**发布状态：** 工作区版本 `@shidesheng0218/dsh-plugin-lint` 0.3.0，未发布；npm 最新发布是 0.1.0（2026-10-14），其中只有 `dsh-plugin-lint` 与 `dsh-plugin-probe` 两个 bin，没有本文的 `dsh-plugin-analyze` / `dsh-plugin-upgrade-plan`。因此本文的命令都要**从源码 checkout 运行**（`node bin/...`），不能通过 `npx` 获得。

代码位置：`src/composition.js`、`src/performance.js`、`src/security.js`、`bin/dsh-plugin-analyze.mjs`、`bin/dsh-plugin-upgrade-plan.mjs`；导出在 `src/index.js`。

## 1. CLI 契约

### 1.1 `dsh-plugin-analyze`

| 子命令 | 参数 | 作用 |
| --- | --- | --- |
| `conflicts <dir> <dir> [dir...]` | 至少两个插件目录 | 扫多个插件的静态资源声明，报告同名冲突 |
| `performance <dir>` | 恰好一个插件目录 | 静态体积/复杂度/网络指标与 0–100 启发式评分 |
| `security <dir>` | 恰好一个插件目录 | S1–S10 静态安全模式，全部 warn/info |
| `full <dir>` | 恰好一个插件目录 | `lintPackage` + `analyzePerformance` + `analyzeSecurityDeep` |

通用选项：

| 选项 | 行为 |
| --- | --- |
| `--json` | stdout 只输出 JSON；诊断/进度写 stderr |
| `--exit-code` | 启用门禁退出码（见下表）；不加时成功运行一律 0 |
| `-h`, `--help` | 输出 usage 到 stdout，退出 0 |

退出码：

| 码 | 含义 |
| --- | --- |
| 0 | 分析完成；或 `--exit-code` 门禁未触发 |
| 1 | 带 `--exit-code` 且门禁触发：`conflicts` 有冲突；`security` 有 warn/error 级 finding；`full` 的 lint 有 error 或 security 有 warn/error 级 finding。`performance` 与 info 级 finding 永不触发 |
| 2 | 用法错误、目录不存在、目录里没有 `package.json`、或分析过程失败 |

`full` 不包含冲突检测：单包没有可比较对象。`--json` 的顶层形状：

| 子命令 | JSON 顶层字段 |
| --- | --- |
| conflicts | `targets[]`、`slots`、`toolNames`、`routes`、`configKeys`、`eventListeners`、`summary`、`experimental: true`、`limits[]` |
| performance | `target`、`bundleSize`、`complexity`、`domImpact`、`networkCalls`、`heavyDependencies`、`score`、`rating`、`recommendations`、`experimental: true`、`limits[]` |
| security | `target`、`findings`、`byCategory`、`summary`、`riskLevel`、`experimental: true`、`limits[]` |
| full | `target`、`lint`、`performance`、`security`、`experimental: true` |

```bash
node bin/dsh-plugin-analyze.mjs conflicts ./plugin-a ./plugin-b
node bin/dsh-plugin-analyze.mjs performance ./my-plugin --json
node bin/dsh-plugin-analyze.mjs security ./my-plugin --exit-code
node bin/dsh-plugin-analyze.mjs full ./my-plugin --json
```

### 1.2 `dsh-plugin-upgrade-plan`

两种模式，都要显式选择：

```bash
# 分析模式：读 profile 已装 bundle，与本地矩阵对照
node bin/dsh-plugin-upgrade-plan.mjs --from <版本> --to <版本> --installed <profile 目录> [--matrix <矩阵目录>] [--json]

# 兼容检查模式：只读单个插件自己的 dsh.compatibility 声明
node bin/dsh-plugin-upgrade-plan.mjs --check-compatibility <插件目录> --target <版本> [--json]
```

| 选项 | 行为 |
| --- | --- |
| `--matrix <dir>` | 矩阵 cell 目录，默认 `./matrix/cells`；目录不存在或没有 cell 时退出 2 |
| `--json` | stdout 只输出 JSON |
| `--auto-fix` | 人类可读输出额外打印 `npm install <pkg>@<version> ...` 建议；不执行安装 |
| `-h`, `--help` | 输出 usage，退出 0 |
| 未知选项 / 参数缺值 | 退出 2 |

分析模式退出码：`0` 无需动作 · `1` 至少一个社区插件需要更新（`needsUpdate`）或没有兼容的已测版本（`noCompatibleVersion`）· `2` 运行失败（参数错误、profile 不存在、矩阵目录不存在、矩阵里没有目标 DSH 版本的 cell）。

`--check-compatibility` 退出码：`0` 声明兼容 · `1` 声明不兼容 · `2` 未知（没声明 `dsh.compatibility.dshReleases`，或没声明目标版本）。

分析模式不访问网络：它只读 profile 的 `package.json`（`dsh.profile.bundles`，缺失时回退扫描 `node_modules`）与本地矩阵 cell。

## 2. 组合冲突（`conflicts`）

### 2.1 扫什么

只解析字面量注册点：

| 资源 | 识别的写法（示例） |
| --- | --- |
| UI slot | `ctx.slots.inject('<slot>', ...)`、`ctx.slots.register({ name: '<slot>' }, ...)`；兼容旧写法 `slot: '<name>'` 与 `ctx.provide('ui.slot.<name>')` |
| 工具名 | `ctx.tools.register(defineTool({ name: '<name>' }))`、`ctx.tools.register({ name: '<name>' })`、声明式 `tools: [{ name: '<name>' }]` |
| 路由 | `connection.fetch.register({ path: '/api/...' })`；兼容 `ctx.router.get` / `post` / `put` / `delete` / `patch` |
| 配置键 | `ctx.config.set('<key>', ...)` |
| waterfall 监听器 | 常见 waterfall 事件上多个监听器，且存在不返回/不调用 `next()` 的写法 |

同一插件重复声明同名资源不会被算作冲突；只有两个不同插件认领同一资源才进入报告。`summary` 给出 total/high/medium/low。

### 2.2 边界

```text
Static scan of literal call sites: dynamic resource names are not resolved.
The runtime matrix conflict check (scripts/matrix/conflicts.mjs) is the authority; this module is a pre-flight hint.
A missing conflict is not proof that two plugins compose.
```

**运行时权威是 `scripts/matrix/conflicts.mjs`**：它把插件真正装进同一个 profile，读宿主实际注册了什么（工具名、slot 名），并用两个故意撞名的夹具验证过。本文的 CLI 是安装前预检，命中要重视，漏报不能当成"可以共存"。

## 3. 性能分析（`performance`）

### 3.1 指标

| 字段 | 含义 |
| --- | --- |
| `bundleSize` | 按 npm 打包语义估算的发售体积：总字节/MB、JS 字节/MB、文件数、最大文件列表 |
| `complexity` | 行数、函数数、深嵌套文件数、maintainability 评级 |
| `domImpact` | 客户端 DOM 操作模式的风险等级（只分析客户端入口文件） |
| `networkCalls` | 字面量 `fetch`/`axios` 调用数、外部域名列表、风险等级 |
| `heavyDependencies` | 同步文件系统调用、循环内 JSON 等重模式 |
| `score` / `rating` | 0–100 启发式评分与档位（excellent/good/fair/poor；没有可分析 JS 时为 0/insufficient-data） |
| `recommendations[]` | 由指标生成的改进建议 |

评分从 100 起按固定阈值扣分（bundle 体积 >1/>2/>5 MB、maintainability fair/poor、DOM/网络风险、每条重模式 -5）。阈值写在代码里，没有运行时权重。

若包里没有任何可分析的 JS，`score = 0`、`rating = 'insufficient-data'`：没有可判断的对象时不给满分。长函数指**超过 100 行**；注释不参与计数（读 mask 后源码）。

### 3.2 边界

```text
Static analysis of the files on disk: no startup time, memory, or runtime measurement is performed.
Bundle size approximates npm packing but does not resolve every npm files[] rule.
The 0-100 score is a heuristic summary; a high score is not proof of a fast plugin.
```

它回答的是"包里有什么静态指标"，不是"装上后 DSH 会不会变慢"。评分适合做同一插件不同版本间的相对比较，不适合当作性能验收线。

## 4. 安全深析（`security`）

### 4.1 规则

10 条规则，**没有 error 级**（全部 warn/info）：

| 规则 | 级别 | 类别 | 检测 |
| --- | --- | --- | --- |
| S1 | warn | data-exfiltration | 会话/agent 数据发往外部域名 |
| S2 | warn | credential-handling | 凭据写入 localStorage/sessionStorage |
| S3 | warn | code-injection | `eval()` / `Function()` |
| S4 | warn | xss | 客户端入口把非静态字符串赋给 `innerHTML` |
| S5 | info | network-integrity | 代码里的字面量外部域名清单（inventory，不是声明比对） |
| S6 | warn | command-injection | 字符串插值拼 shell 命令 |
| S7 | warn | fs-access | 工作区外绝对路径文件操作 |
| S8 | info | crypto-usage | 使用 crypto 函数 |
| S9 | warn | environment-access | 读取 `process.env` |
| S10 | warn | transport-security | 生产代码使用明文 HTTP |

几条实现口径值得写清楚：

- 规则读 **mask 后源码**：注释被清空，所以注释里的 URL、`eval` 不会误报；字符串字面量保留，因为 URL/存储键本身就是证据。
- **S4 只报非静态值**：静态字符串、无插值的模板字符串、经 `DOMPurify` / `sanitize` / `escapeHtml` 处理的不报；带模板插值的 `innerHTML` 赋值会报。只检查 `entries.client` 指向的客户端入口文件。
- **S5 是清单不是判定**：DSH manifest 没有 `dsh.capabilities` 字段，规则无法做"声明 vs 实践"比对，只列出代码里出现的字面量外部域名，单包最多 10 个。
- `riskLevel` 只由 warn 数量决定：0 = minimal、1–3 = low、4–9 = medium、≥10 = high；**没有 critical**，且它是对警告数量的概括，不是裁决。

```javascript
const result = analyzeSecurityDeep(pkg);
// {
//   experimental: true,
//   findings: [{ rule, level, title, category, file, line, message, evidence, hint, experimental }],
//   byCategory: { ... },
//   summary: { total, error: 0, warn, info },
//   riskLevel: 'minimal' | 'low' | 'medium' | 'high',
//   limits: [ ... ]
// }
```

### 4.2 边界

```text
Experimental static heuristics over source text: a finding describes a pattern, not observed behaviour, and is not a security verdict.
Rules read the masked source: comments are blanked; string literals stay intact where a URL or storage key is itself the evidence.
No rule in this module is error-level, and a clean run does not mean the plugin is safe.
```

这是给 reviewer 的线索清单，不是安全扫描结论；与 `dsh-trust-check`（能力披露）是互补关系，不能互相替代。

## 5. 升级路径（`dsh-plugin-upgrade-plan`）

### 5.1 分析模式

读 profile 已装 bundle，与本地矩阵 join，按目标 DSH 版本把每个插件归入：

| 分类 | 含义 |
| --- | --- |
| `compatible` | 矩阵在目标版本上是 `active` |
| `untested` | 矩阵记录 `awaiting-service`：该组合没提供它等待的服务，不算失败 |
| `needsUpdate` | 目标版本上不是 active，但矩阵里有另一个 active 的已测版本 → 建议版本 |
| `noCompatibleVersion` | 矩阵测过的版本没有一个在目标版本上 active |
| `unknown` | 矩阵没有覆盖该插件/版本，或没有目标版本的 cell |
| `firstParty` | 官方 `@deepseek-ai/*` bundle，矩阵不覆盖，单独列出 |

`summary.needAction = needsUpdate + noCompatibleVersion`，决定退出码 0/1。官方 bundle 只计数、不预览。矩阵没覆盖的插件报 unknown，不当作裁决。

### 5.2 边界

- **矩阵数据不在 npm 包里**：`matrix/cells/` 被 gitignore，且没有随 `files` 发布。npm 安装版没有矩阵，必须用 `--matrix` 指向本地快照，否则退出 2。
- **覆盖范围是快照里的 50 个插件**，不是整个生态；版本与状态口径见 [docs/09](09-ecosystem-measurements.md)（包括"记录版本 ≠ 实际加载版本"的 23/200 限制）。
- **哪边是权威**：矩阵是探针实测结果，本命令只做 join 与分类；它不重新探测，也不联网查新版本。

## 6. 编程 API

v0.3 的导出（`src/index.js`）：

```javascript
import {
  loadPackage,
  detectConflicts,
  analyzePerformance,
  analyzeSecurityDeep
} from './src/index.js';

const pkg = loadPackage('./my-plugin');
// loadPackage(dir) → { manifest, jsFiles, entries, ... }

const conflicts = detectConflicts([
  { name: pkg.manifest.name, manifest: pkg.manifest, jsFiles: pkg.jsFiles }
]);
// { slots, toolNames, routes, configKeys, eventListeners, summary, experimental: true, limits }

const perf = analyzePerformance(pkg);
// { bundleSize, complexity, domImpact, networkCalls, heavyDependencies,
//   score, rating, recommendations, experimental: true, limits }

const security = analyzeSecurityDeep(pkg);
// { findings, byCategory, summary, riskLevel, experimental: true, limits }
```

这些导出只在未发布的工作区里存在；npm 0.1.0 的 API 面比它小。

## 7. 测试

分析模块的测试在：

- `test/composition.test.js`
- `test/performance.test.js`
- `test/security.test.js`
- `test/upgrade-preview.test.js`（覆盖 `scripts/upgrade-preview.mjs`，不是本文的 upgrade-plan CLI）

它们随 `npm test`（`node --test test/*.test.js`）一起跑，用例数以实际运行输出为准，不在文档里写死。

## 8. 实现位置

| 文件 | 内容 |
| --- | --- |
| `src/composition.js` | 字面量提取与冲突汇总（slot/tool/route/config/waterfall） |
| `src/performance.js` | 体积、复杂度、DOM、网络、重模式与评分 |
| `src/security.js` | S1–S10 规则、分类、风险等级 |
| `bin/dsh-plugin-analyze.mjs` | `conflicts`/`performance`/`security`/`full` CLI 与 JSON |
| `bin/dsh-plugin-upgrade-plan.mjs` | 矩阵 join、profile 解析、`--check-compatibility` |
| `examples/comprehensive-analysis.mjs` | 组合调用的演示脚本（不是 API 契约） |

## 9. 与旧版文档的差异

早期草稿把 v0.3 分析写成已完成的能力，并把安全规则写成有 error 级。当前口径以本文为准：

- 四项能力都是 experimental，静态启发式；
- 安全规则没有 error 级，S5 不再是"未声明 capability"判定；
- 性能评分不是运行时测量，空分析给 `insufficient-data`；
- 冲突检测的运行时权威是 `scripts/matrix/conflicts.mjs`，CLI 只是预检。
