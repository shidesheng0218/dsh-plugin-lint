# 09 · 生态测量结果（只含聚合数字）

**本文只发布聚合数字，不点名任何包。** 逐包结论（`reports/`、`notify/`、`matrix/cells/`）在本地生成、不进仓库，原因见 [README](../README.md#data-policy)。

两组快照，采集时间不同：

| 快照 | 时间 | 规模 |
| --- | --- | --- |
| 静态检查 | 2026-10-13 | Top 100 已发布社区插件，工具 `dsh-plugin-lint` 0.0.1，目录快照 `dsh-plugin-catalog@2026.1012.5076` |
| 兼容矩阵 | 2026-10-16（`generatedAt 2026-10-16T02:45:50Z`） | 50 个插件 × 2 个 DSH 版本 × 2 种组合 = 200 格 |

**所有原始产物都被 gitignore**：静态检查的 `reports/`、矩阵的 `matrix/cells/` 与 `matrix/index/` 都不在版本库里，干净 clone 无法重建。本文数字是本地跑批的聚合记录，不是"任何人都能原样复跑"的证明。版本库里的矩阵产物只有聚合计数 `panel/data/aggregate.json`（无包名）。

## 1. 静态检查：Top 100 已发布插件（2026-10-13）

| 结论 | 占比 |
| --- | --- |
| 与官方 Harness Client 包耦合（W1） | **62 / 100（62%）** |
| 声明了 DSH 兼容版本（I1） | 13%（13 / 100） |
| **没有声明兼容版本** | **87%（87 / 100）** |
| 声明了展示图标 | 31%（31 / 100） |
| 触发 error 级规则 | 1%（1 / 100，E1：白名单外的 append 类型） |

该轮共 327 条 finding，按严重度是 **1 error · 86 warn · 240 info**；按规则是 E1 1 · W1 86 · I1 87 · I2 136 · W3 17。info 的 240 条由 I1 87 + I2 136 + W3 17 组成。

被加载最多的官方 Client 包是 `@deepseek-ai/dsh-client-ui-primitives`：**去重后 48 个插件引用它**；71 是提及它的 W1 finding 条数（同一插件的代码与 manifest 依赖可以各产生一条），两者不是同一个数——早期文档把 finding 次数当成了插件数。

13% 的兼容声明率就是这个快照的直接结论：87% 的头部插件没有声明任何 DSH 兼容范围。测量工具是 0.0.1，早于当前工作区 0.3.0，数字是快照记录，不是用当前工具重跑的结果。

## 2. 兼容矩阵：50 个插件 × 2 个 DSH 版本 × 2 种组合 = 200 格（2026-10-16）

状态计数（来自 `panel/data/aggregate.json`，每个版本列 100 格 = 50 插件 × headless/web）：

| 状态 | 0.2.0-rc.2 | 0.2.1-alpha.2 |
| --- | --- | --- |
| active | 80 | 72 |
| awaiting-service | 16 | 20 |
| rejected-by-host | 2 | 8 |
| install-failed | 2 | 0 |

### 版本间的计数变化

同一批 cell 在两个固定 DSH 版本上的聚合变化：active 从 80 降到 72，rejected-by-host 从 2 升到 8，awaiting-service 从 16 升到 20，install-failed 从 2 降到 0。**这是 cell 级计数，不是插件级结论**：一个插件有两种组合，cell 变化不能直接换算成"多少个插件变差"。旧文档里的"逐插件结论变差"数字来自一次更大的跑批，那次数据无法从本仓库重建（cells 被 gitignore），本文不引用为当前结论。

### 数据质量限制（必须和数字一起读）

1. **记录版本 ≠ 实际加载版本。** cell 里的 `plugin.version` 是采集时从 registry 抓到的版本，但探针安装时用的是裸包名。**200 格中 23 格**的记录版本与 cell 自己记录的"实际装入版本"不一致（例如 `dsh-context` 记录 0.72.0、实际装 0.71.0）。cell 的 `reproduce` 命令不带版本，今天重跑可能测到另一个发布版本。
2. **干净 clone 不能重建。** `matrix/cells/` 与 `matrix/index/` 被 gitignore；版本库里只有目标清单（`matrix/targets*.json`）、版本钉（`matrix/versions.json`）与聚合计数（`panel/data/aggregate.json`）。
3. **版本覆盖旧。** 快照只钉 `0.2.0-rc.2` 与 `0.2.1-alpha.2` 两个 DSH 版本；更新宿主版本的 cell 不存在。
4. **逐 cell 的能力/成本数字不再单列。** 注册工具数、系统提示词字符数在 `matrix/cells` 里，属于被 gitignore 的逐包数据；需要时用本地快照重算，本文不发布这些数字的聚合极值。

## 3. 方法学：每一轮扩样都暴露一个系统性误判

这是本项目最有价值的部分，也是"先扩样再对外"这个顺序的理由。下表是**历史跑批**的记录；产生它们的 cell 不在版本库里，无法从干净 clone 重建。

| 轮次 | 规模 | 暴露的问题 | 修正 |
| --- | --- | --- | --- |
| 冒烟 | 22 格 | 把"等待服务"当成失败（headless 组合不提供 web 侧服务，插件根本没得到挂载机会） | 改名 awaiting-service + 新增 web 组合探针 |
| Top 50 | 200 格 | 把**退出码**当成安装结果（26 个 install-failed 里 23 个其实装成功了） | 改为**校验产物**：profile 的 package.json 是否变化 |
| 规则设计 | — | 初版 12 条规则里有 3 条按字面实现会误报官方包 | 规则按"可判定性"三级分级，官方包作为零误报基线 |

**结论：小样本发现不了系统性偏差，扩样本身就是验证手段。** 每条规则、每个状态判据都必须在真实数据上跑过才允许对外。

## 4. 可复现性

需要网络、npm 与 pnpm；产物默认写进被 gitignore 的目录：

```bash
node scripts/lint-npm-packages.mjs <包名...>                       # 静态检查任意已发布插件
node scripts/matrix/run.mjs --targets matrix/targets-top50.json   # 重跑矩阵（会安装并执行第三方包）
node scripts/matrix/site.mjs && node scripts/matrix/bundle-panel-data.mjs
node scripts/build-report.mjs --top 100                            # 静态检查报告
```

跑批结果属于跑探针的人：谁跑，数据就是谁的答案；本文的数字只对应上面标注的时间与快照。

## 5. 点名数据的处理

仓库里出现过的逐包结论已从 **git 历史**中移除（不只是工作区）。原因是这些内容会对具体维护者形成公开点名，而项目选择先不这么做。

需要时任何人都能在本地重建同样的数据（命令见 §4）。**数据属于跑探针的人，不属于这个仓库。**
