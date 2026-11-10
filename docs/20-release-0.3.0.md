# 20 · v0.3.0 release notes（draft，被 0.4.0 取代）

> **状态：历史草稿。** 0.3.x 从未发布；v0.3 的分析能力与 v0.4 的矩阵/面板重写一起进入 lint `0.4.0` 与 panel `0.2.0`。当前发布候选见 [docs/21](21-release-0.4.0.md)，发布对账见 [docs/17](17-release.md)。本文件保留为当时的实现记录，不再作为发布公告。

> **状态：draft。** 工作区版本是 0.3.0，**没有发布**。npm 上 `@shidesheng0218/dsh-plugin-lint` 最新是 0.1.0（2026-10-14），`@shidesheng0218/dsh-plugin-lint-panel` 最新是 0.1.5。本文件是发布前的工作草稿，不是发布公告；发布对账状态见 [docs/17](17-release.md)。

## 1. 本次新增（全部 experimental）

v0.3.0 新增四项分析能力。四项都是**静态启发式**：读磁盘文件，不执行插件，不做运行时测量，也不做安全裁决。`analyze` 的结果对象带 `experimental: true` 与 `limits` 数组（`full` 的 `limits` 在各子报告里）；`upgrade-plan` 的 JSON 不带这两个字段。

### 1.1 组合冲突检测

- CLI：`dsh-plugin-analyze conflicts <dir...>`（至少两个插件目录）。
- 静态解析字面量注册点：`ctx.slots.inject` / `ctx.slots.register`、`ctx.tools.register(defineTool(...))`、`connection.fetch.register`、`ctx.config.set`、waterfall 监听器。
- 两个不同插件认领同名资源才报告；同一插件重复声明不再自冲突。
- **运行时权威不是它**：`scripts/matrix/conflicts.mjs` 把插件装进同一个 profile、读宿主实际注册结果；CLI 只是安装前预检，漏报不等于可以共存。

### 1.2 性能分析

- CLI：`dsh-plugin-analyze performance <dir>`。
- 静态指标：bundle 体积、文件、复杂度（长函数按 >100 行）、DOM 访问模式、字面量网络调用、重模式。
- 0–100 评分是按固定阈值扣分的启发式指标，**不是启动时间/内存测量**；注释不参与计数；没有可分析 JS 时 `score = 0`、`rating = 'insufficient-data'`。

### 1.3 安全深析

- CLI：`dsh-plugin-analyze security <dir>`；API：`analyzeSecurityDeep(pkg)`。
- S1–S10 共 10 条规则，**全部 warn/info，没有 error 级**。
- 读 mask 后源码，注释不误报；S4 只报非静态的 `innerHTML`（静态字符串与无插值模板字符串不报）；S5 是字面量外部域名清单，不做 capability 声明比对（DSH manifest 没有 `dsh.capabilities` 字段）。
- `riskLevel` 只由 warn 数量概括（minimal/low/medium/high，**没有 critical**），是线索优先级，不是安全结论。

### 1.4 升级路径

- CLI：`dsh-plugin-upgrade-plan --from <a> --to <b> --installed <profile> [--matrix <dir>]`，或 `--check-compatibility <dir> --target <version>`。
- 读 profile 的 `dsh.profile.bundles`（缺失时回退 `node_modules`），与本地 `matrix/cells` join，把插件分为 compatible / untested / needsUpdate / noCompatibleVersion / unknown / firstParty。
- 不访问网络；矩阵不随 npm 包发布，`matrix/cells/` 被 gitignore，因此没有本地快照时明确报错退出 2，而不是给出"安全升级"的假结论。

## 2. CLI 变更

| 命令 | 新增/变更 |
| --- | --- |
| `dsh-plugin-analyze conflicts\|performance\|security\|full` | 新 bin；`--json` 为纯 JSON stdout；`--exit-code` 门禁；`--help` 退出 0；未知选项退出 2 |
| `full` | `lintPackage` + `analyzePerformance` + `analyzeSecurityDeep`（不含 conflicts：单包无可比对象） |
| `dsh-plugin-upgrade-plan` | 新增 `--matrix <dir>`、真正的 `--json`；退出码 0 无需动作 / 1 需动作或无兼容 / 2 运行失败（含无矩阵数据）；`--check-compatibility` 0 兼容 / 1 不兼容 / 2 未知或无数据 |

`--exit-code` 的触发条件：`conflicts` 有冲突 → 1；`security` 有 warn/error 级 finding → 1（info 级清单不触发）；`full` 的 lint 有 error 或 security 有 warn/error 级 finding → 1；`performance` 始终 0。详细契约见 [docs/19](19-analysis-tools.md)。

**发布状态提醒：** 这两个 bin 只存在于工作区。npm 0.1.0 只有 `dsh-plugin-lint` 与 `dsh-plugin-probe`，所以上面的命令不能通过 `npx` 获得，必须从源码运行。

## 3. API 变更（新增，不改变既有导出）

`src/experimental/index.js` 新增导出（安装后通过 `@shidesheng0218/dsh-plugin-lint/experimental` 访问；包入口 `src/index.js` 保持十个稳定导出不变）：

- `detectConflicts(packages)`
- `analyzePerformance(pkg)`
- `analyzeSecurityDeep(pkg)`
- `SECURITY_RULES`
- `SECURITY_LIMITS`

既有导出（`lintPackage`、`loadPackage`、`RULES`、`formatText`、`toSarif` 等）保留。以上变更针对工作区；0.1.0 的 API 面较小。

## 4. 测试

测试是 `node:test`，无运行时依赖：

```bash
npm test    # node --test test/*.test.js
```

v0.3 的修复轮补充了组合冲突、性能、安全的测试，并把 panel 测试从 ambient 环境隔离（`DSH_PROFILE_DIR`、`DSH_PLUGIN_LINT_INDEX`、`ELECTRON_RUN_AS_NODE`），现在在普通 shell 与 DSH shell 里都能跑完。用例数以实际输出为准，本文件不写死。

## 5. 已知问题与边界

1. **版本对账未完成。** 工作区 0.3.0 未发布；npm lint 仍是 0.1.0。panel 的 0.1.6 bump 已进 main（`49b21b4`），但 registry 没有 0.1.6（最新 0.1.5）——那次自动发布在 bump 之后失败。发布前必须人工对账，见 [docs/17](17-release.md)。
2. **自动发布没有被证明可靠。** 两个 publish workflow 依赖 `NPM_TOKEN` 且显式检查 token；main 上的最近一次 publish-lint / publish-panel 运行均失败（2026-10-26），仓库里没有发布成功记录。不要把"合入 main 即发布"当成事实。
3. **panel npm 包只有聚合数据。** `files` 只含 `data/aggregate.json`（每版本计数，无包名），不含逐插件 `data/matrix-index.json`。从 npm 安装的 panel 只显示生态计数，逐插件矩阵列需要本地快照（`DSH_PLUGIN_LINT_INDEX` 或 checkout 里的 `panel/data/matrix-index.json`）。
4. **矩阵快照不能精确复现。** 当前快照 50 插件 × 2 DSH 版本 × 2 组合 = 200 格，采集于 2026-10-16；其中 23 格记录的 `plugin.version` 与实际加载版本不一致，cell 的 `reproduce` 命令不带版本。`matrix/cells/` 与 `matrix/index/` 被 gitignore，干净 clone 无法重建。
5. **矩阵版本覆盖旧。** 快照只钉 0.2.0-rc.2 与 0.2.1-alpha.2 两个 DSH 版本；更新的宿主版本没有测过。
6. **实验性能力的误报/漏报。** 冲突检测只认字面量；性能评分没有运行时依据；安全规则是模式匹配，单条误报就能抬高 `riskLevel`。三项都不能当作发布门禁的最终裁决。
7. **e2e 验收依赖网络。** `npm run e2e:official` 需要先从 npm 抓取官方包；本轮修复的本地验证没有重跑它（CI 的 `ci.yml` 会在联网 runner 上跑）。

## 6. 不包含

- 不做运行时性能测量、不做安全裁决、不替代 `dsh-trust-check` 等能力披露工具；
- 不自动修复冲突，只给候选与建议；
- 不承诺"装上即安全/即兼容"；干净运行只代表没有模式命中。

## 7. 发布前人工检查清单（draft）

1. `npm test` 全绿（以实际输出为准）。
2. 确认 registry 与工作区版本：lint 0.3.0 未发布（registry 0.1.0）；panel 工作区 0.1.6、registry 0.1.5，先决定 0.1.6 是发布还是回滚。
3. 确认 `NPM_TOKEN` 有效；确认 publish workflow 的最近失败已处理。
4. 需要的话重新生成矩阵（网络 + npm + pnpm），再跑 `node scripts/matrix/bundle-panel-data.mjs`。
5. 复核 README / docs 里没有"已发布/可 npx 获得"的表述，再改本文件状态。
