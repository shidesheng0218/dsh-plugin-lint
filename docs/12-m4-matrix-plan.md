# 12 · M4 兼容性与能力矩阵：具体怎么做

前置：[10](10-m4-verification.md)（宿主半边探针）、[11](11-m4-capability-probe.md)（能力探针）两条假设均已验证。

## 0. 目标与验收标准

**目标**：对每个「插件版本 × DSH 版本」组合，发布一条**可复现的验证结论**：能不能挂载、给模型加了什么、提示词涨了多少、组成了哪些包。

**M4 完成的验收标准**（缺一不可）：

1. 跑出 **50 个插件 × 2 个 DSH 版本 = 100 个 cell**，每格都有结论与复现命令；
2. 从零重跑得到**相同结论**（允许列出的少数不稳定格）；
3. 站点能渲染，聚合 JSON 能以 npm 包形式发布（先 dry-run）；
4. **至少有一位第三方作者在自己的 CI 里跑通探针**（证明联邦式成立，而不是我们自说自话）。

## 1. 已确定的技术底座

| 事项 | 结论 | 来源 |
| --- | --- | --- |
| 隔离 | `DSH_HOME` 指向临时目录即可 | [10](10-m4-verification.md) |
| 判定信号 | **必须解析 stderr**；挂载失败只是 warning，退出码仍 0 | [10](10-m4-verification.md) |
| 能力读取 | 桩 provider 截获宿主真实请求：`tools` / `system` / `dsh_plugin_packages` | [11](11-m4-capability-probe.md) |
| 单格成本 | 1.8 – 3.9 秒（大包 29 秒） | 实测 |
| 客户端半边 | **不在覆盖范围**，结论必须分两栏 | [10](10-m4-verification.md) §5 |

## 2. 关键设计决策

### 2.1 DSH 版本从 npm 取，不用本机桌面端

这是矩阵能规模化的前提：本机只装了一个桌面版 DSH，而矩阵要覆盖多个版本。

`npx --yes @deepseek-ai/dsh@<version>` 已验证可用（纯 Node，无需 Electron）。因此：

- 每格用 `@deepseek-ai/dsh@<version>` 自带的 CLI 启动；
- 版本集合显式钉死（例如 `0.2.0-rc.2`、`0.2.1-alpha.2`），**不追 latest**，否则历史结论不可比；
- CI 可跑在 **ubuntu-latest**（不需要 macOS 桌面端），联邦式才有意义。

✅ **已验证（2026-10-13）**：`npx @deepseek-ai/dsh@0.2.0-rc.2` 在全新 `DSH_HOME` 里用**纯 Node** 完成 profile 初始化并启动，直达 `MISSING_CREDENTIAL`——即"合成成功、全部挂载"的哨兵。**无需 Electron、无需桌面端**，因此矩阵可以跑在 ubuntu-latest 上。

附带实测：官方 bundle 由 dsh 安装处解析，**profile 目录只有 40 KB**；一个 DSH 版本缓存约 280 MB。

### 2.2 每格一个一次性环境

```
cell = 一次性 DSH_HOME + 随机端口桩服务 + 装一个插件 + 两次启动（基线 / 复测）
```

- 环境用完即删（`probe-boot.mjs` 已这么做）；
- 桩服务端口用 `listen(0)` 取随机端口，避免并发冲突；
- **必须异步执行子进程**：桩服务与启动同进程时，同步调用会阻塞事件循环（已踩，见 [11](11-m4-capability-probe.md) §3）。

### 2.3 存储：一格一个文件，可断点续跑

```
matrix/cells/<sanitized-plugin-name>/<dsh-version>.json
```

跑批崩溃或超时后重跑时**跳过已存在的格**（`--force` 覆盖）。这样 300 格的跑批可以分多次完成，也方便作者只提交自己那一格。

### 2.4 发布：静态站点 + npm 聚合包

沿用生态里已验证的分发方式（`dsh-plugin-catalog` 就是把 `plugins.json` 发到 npm，市场直接消费）：

- `site/index.html`：插件 × 版本 的表格，带状态徽章与复现命令；
- `matrix/index/latest.json`：聚合索引（站点、面板、市场都消费它）；
- 可选发布成 npm 包 `dsh-plugin-matrix`，让 M5 面板一键查询。

**不需要服务器。**

### 2.5 联邦式：自报与已复验永不混

| 级别 | 来源 | 站点标记 |
| --- | --- | --- |
| `verified` | 本项目跑批 | ✅ |
| `self-reported` | 作者 CI 上传 | 🟡 |
| `stale` | 超过 N 天或 DSH 已发新版 | ⏳ 灰 |

抽检规则：每周对 `self-reported` 随机抽 10% 复验；**不一致就降级为 `disputed` 并公开差异**。

## 3. 目录与模块

```text
scripts/
  lib/probe.mjs          共享内核：桩服务、临时 HOME、安装、启动、解析、差集
  probe-boot.mjs         CLI（已有，改为调用 lib）
  matrix/
    targets.mjs          目标清单：目录 Top N / 显式包名 / 本地目录
    run.mjs              跑批编排：版本 × 目标，并发、续跑、写 cell
    site.mjs             站点与聚合 JSON 生成
    verify.mjs           抽检复验
matrix/
  cells/<plugin>/<dsh>.json
  index/latest.json
site/index.html
.github/workflows/
  probe.yml              给作者：PR 上跑本插件探针并评论结论
  matrix-refresh.yml     给项目：定时刷新 Top N
```

**先做的重构**：把 `probe-boot.mjs` 里的桩服务、HOME 管理、解析逻辑抽到 `scripts/lib/probe.mjs`，CLI 与跑批共用一份实现（避免两套逻辑漂移）。

## 4. Cell 数据模型

```json
{
  "schemaVersion": 1,
  "plugin": { "name": "dsh-mnemon", "version": "0.5.28", "integrity": "sha512-…" },
  "dsh":    { "version": "0.2.0-rc.2", "source": "npm", "cliIntegrity": "sha512-…" },
  "probe":  { "tool": "dsh-plugin-lint/probe", "version": "0.1.0", "commit": "a68fa3b" },
  "run":    { "at": "2026-10-14T02:11:03Z", "durationMs": 3732, "os": "darwin-arm64", "node": "24.18.0", "trust": "verified" },
  "result": {
    "status": "active",
    "entries": [],
    "tools": { "baseline": 24, "total": 41, "added": ["mnemon_remember", "…"], "removed": [] },
    "systemPrompt": { "baselineChars": 2640, "chars": 7153 },
    "packagesAdded": ["dsh-mnemon@0.5.28", "…"],
    "clientHalf": "not-covered"
  },
  "evidence": { "stderrExcerpt": "…", "note": "ok" },
  "reproduce": { "command": "node scripts/probe-boot.mjs dsh-mnemon --tools --dsh 0.2.0-rc.2" }
}
```

**状态机**（互斥，全部实测过）：`active` · `inactive-error` · `inactive-pending` · `install-failed` · `boot-failed` · `template-failed`。

> 关键纪律：`install-failed`（网络/包不存在）**绝不能**和 `inactive`（真不兼容）混为一谈——前者是我们的环境问题，后者才是插件的结论。

## 5. 跑批编排

```bash
node scripts/matrix/run.mjs --top 50 --dsh 0.2.0-rc.2,0.2.1-alpha.2 --concurrency 4
node scripts/matrix/run.mjs --plugins dsh-mnemon,dsh-context --dsh 0.2.0-rc.2 --force
```

- **并发 4**：每格要起子进程 + pnpm，再高会争抢网络与磁盘；
- **单格超时 180 秒**，超时记 `boot-failed` 并保留证据，不重试超过 1 次；
- 每格结束立即删临时 HOME（大包会吃掉几百 MB）；
- 跑批产物分片提交：一次 PR 只提交新增/变化的 cell，便于 review 与回滚。

**成本**（按实测外推）：

| 项 | 实测/外推 |
| --- | --- |
| 时间 | 50 插件 × 2 版本 = 100 格 ≈ 5–20 分钟；300 格 ≈ 15–60 分钟 |
| **单格磁盘** | **40 KB**（官方 bundle 从 dsh 安装处解析，不进 profile） |
| 每个 DSH 版本缓存 | ~280 MB（npx 缓存，一次性） |
| 网络 | 只在装插件时用；bundle 不需要重复下载 |

## 6. 站点与分发

`site/index.html` 三块：

1. **矩阵表**：行=插件，列=DSH 版本，格=状态色块 + 工具增量；
2. **趋势**：某插件在新版本上从 `active` 变 `inactive` 的时间点（升级预警的直接答案）；
3. **每格详情**：结论、证据、复现命令、以及"客户端半边未覆盖"的明确标注。

另外产出**徽章**（`badge.svg`）：作者可以贴进 README——这是联邦式最便宜的推广方式。

## 7. 联邦式：作者怎么用

```yaml
# 插件仓库里的 .github/workflows/dsh-probe.yml（我们生成，作者提交）
- uses: <owner>/dsh-plugin-lint/.github/actions/probe@v1
  with:
    dsh-version: 0.2.0-rc.2
    tools: true
# → 产出 cell JSON + PR 评论 + README 徽章
```

作者把 cell 提交进本仓库（或上传到数据仓库），标记为 `self-reported`。

## 8. CI 工作流骨架

| 工作流 | 触发 | 做什么 |
| --- | --- | --- |
| `probe.yml` | 插件仓库 PR | 跑本插件探针，PR 评论结论（不阻塞合并） |
| `matrix-refresh.yml` | 每周 / 手动 | 刷新 Top 50 × 当前版本集合，开 PR 提交 cell 差异 |
| `verify-sample.yml` | 每周 | 抽检 10% 自报 cell，产出不一致清单 |

## 9. 与既有产物的关系

| 产物 | 关系 |
| --- | --- |
| linter（M1/M2） | 静态规则管"写得对不对"；矩阵管"在这个版本上能不能用"——两者互补，站点互相引用 |
| M2 报告 | 静态现状（耦合 62%、无兼容声明 87%）解释了**为什么需要**矩阵 |
| M5 面板 | 读 `matrix/index/latest.json`，在设置页显示"我装的插件在最新 DSH 上的状态" |
| 方向 B（构成冲突） | 复用同一套探针：多装几个插件跑一次，比较工具名/路由/slot 冲突 |

## 10. 里程碑

| 阶段 | 内容 | 预估 | 验收 |
| --- | --- | --- | --- |
| M4.0 | 抽出 `lib/probe.mjs`；确认 npm 版 DSH 独立可用；cell schema 定稿 | 0.5–1 天 | 现有探针行为不变（回归通过） |
| M4.1 | `matrix/run.mjs` 跑批（并发、续跑、超时、证据） | 1–2 天 | 10 插件 × 2 版本 = 20 格跑通 |
| M4.2 | `matrix/site.mjs` + 聚合 JSON + 徽章 | 1–2 天 | 站点本地可开，`latest.json` 通过 schema 校验 |
| M4.3 | 两个 workflow + 作者 action | 1 天 | 在测试仓库跑通一次 PR 评论 |
| M4.4 | 首次公开矩阵（50 × 2） | 1 天 | 四项验收标准全过 |

## 11. 风险与对策

| 风险 | 后果 | 对策 |
| --- | --- | --- |
| npm 版 DSH 需要额外启动器配置 | 矩阵无法上 Linux CI | M4.0 先验；必要时显式配 `pnpmCommand` |
| 把环境问题当成插件结论 | 冤枉作者 | `install-failed` 与 `inactive` 严格分开；网络失败重试两次后标记为"未测" |
| 结论随时间过期 | 误导用户 | cell 带 `probesAt`；超过 30 天或 DSH 发新版标 `stale` |
| 大插件超时 | 覆盖不全 | 单格 180s 上限；超时如实记录，不猜测 |
| 负面结论的伦理 | 与 M2 同样的风险 | **沿用 D-001：点名 + 只陈述事实 + 发布前通知作者**；矩阵的 `inactive` 结论同样适用 |
| 磁盘占用 | ~~跑批中途爆盘~~ | **实测非风险**：每格 40 KB，每版本缓存 280 MB；跑批仍即时删临时 HOME |

## 12. 需要你定的三件事

1. **版本集合**：先覆盖哪两个 DSH 版本？（建议 `0.2.0-rc.2`（当前主线）+ `0.2.1-alpha.2`（最新前沿））
2. **首批范围**：Top 50 已发布插件，还是只做"已声明兼容 0.2.0-rc.2 的那 13 个"（先易后难，能快速验证矩阵本身）？
3. **数据放哪**：与本仓库同仓（简单、PR 可审），还是单独的 `dsh-plugin-matrix` 数据仓（作者提交更轻，但要维护两个仓库）？
