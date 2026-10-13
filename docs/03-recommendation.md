# 03 · 推荐方案

**推荐：方向 A（插件合规与兼容性公共设施），把方向 B 作为第二阶段模块。**

理由：这是本次调研中唯一同时满足「痛点随生态增长而增长」+「竞品只覆盖了相邻格子」+「开源是必要条件而非情怀」+「一个人能在 2–4 周做出可用版本」的方向。生态已有 4,508 个插件、每月新增近千个，而"这个插件写得对不对、在我的 DSH 上还能不能用"目前**没有任何工具回答**。

---

## 1. 产品形态

一个 monorepo，三个交付物（先做①）：

1. **`dsh-plugin-lint`（核心）** — 对插件源码跑规则集，输出人类可读 + JSON/SARIF 报告，可作 CI 门禁。
2. **`dsh-compat-matrix`（数据）** — 用真实 DSH 版本安装并探测插件，生成"插件版本 × DSH 版本"的验证结果，公开成站点 + JSON API（联邦式：作者自己的 CI 跑验证并上传结果，签名可验）。
3. **DSH 内面板（分发）** — 一个 DSH 插件，在设置页显示"我装的插件有没有踩雷 / 有没有更新 / 是否兼容当前版本"。

## 2. 规则集（v1，全部可机检，逐条有官方出处）

规则来自官方 `cordis-plugin-development` 的 practices 文档（已归档在 `reference/official-skill/references/practices.md`）：

| # | 规则 | 为什么（官方原文要点） | 严重度 |
| --- | --- | --- | --- |
| 1 | waterfall 监听器必须 `return next()` | 不 next 会截断其它插件的决策（agent/pre-step、agent/request、llm/stream、tools/pre-execute、tools/execute、tools/post-execute） | error |
| 2 | 改写 pre-step decision 必须展开 `{ ...decision }` | 否则丢掉 `startsRequestSeries` 等字段 | error |
| 3 | 禁止 append 自定义 session event type | 未知事件缺 `ignorable: true` 会导致会话无法重开 | error |
| 4 | 硬性拒绝应使用 `ctx.tools.guard()`，不要靠 system-prompt | guard 与顺序无关；system-prompt 会被他人改写 | warn |
| 5 | 不要监听 `system-prompt/assemble` 来增删工具或文本 | 应使用 `ctx.systemPrompt.section()` / `ctx.tools.restrict()` | error |
| 6 | 不要订阅 `session/event` 全量重扫 | 应使用 `ctx.sessionProjections`（`apply` 纯函数 + 同引用返回） | warn |
| 7 | 不要轮询 `agent/status`；不要假设 `whenIdle()` 只对应一次 follow-up | 官方明确的反模式 | warn |
| 8 | 定时器/监听器/DOM 资源必须包在 `ctx.effect`/`ctx.on` 并返回清理 | 卸载与热更新依赖它 | error |
| 9 | `agent.ctx` 上的注册必须包 `effect` 且 disposer 由插件自己持有 | 卸载插件不会自动释放 agent.ctx | warn |
| 10 | 客户端代码禁止 import 任何官方 Client 包（如 `dsh-client-ui-primitives`） | 它们会无预警变更，且抛错会直接白屏该 slot | error |
| 11 | 客户端不要操作宿主 DOM / `document.body`；样式只用 `--dsw-alias-*` token | 插件 UI 属于宿主 UI 的一部分 | warn |
| 12 | 清单完整性：`dsh.bundle.patch`、`dsh.client.platform`、`locale/<lang>.json` 的 `meta`、`icon`、`dsh.compatibility.dshReleases`、可选服务声明在 `inject` | 缺 meta/icon 会让插件在管理页显示为默认图；不可选服务会抛错 | info/warn |

> **2026-10-13 实测修正**：本规则集已按真实插件实测结果重做分级，见 [06-detailed-design.md](06-detailed-design.md)。其中"waterfall 必须 return next()"等规则**不能**按字面实现，否则会对写得正确的插件误报。

> 差异化：**dsh-plugin-doctor 看"包结构"，dsh-testkit 看"能不能装/卸"，dsh-trust-check 看"能碰什么"，本项目看"代码写得对不对、能不能跨版本活下来"。** 四者是互补关系，README 里要明确列出这张分工表（生态里已经有互相引用的先例）。

## 3. 明确不做（v1）

- 不做安全背书 / 不做拦截决策（那是 dsh-trust-check 与 my-guardian 的边界）。
- 不做 Docker 生命周期测试（dsh-testkit 的地盘）——矩阵只做"安装 + 启动 + 关键注册探测"。
- 不做市场、不做榜单推荐排序（只发布事实）。

## 4. 里程碑

| 阶段 | 交付 | 验收标准 |
| --- | --- | --- |
| M0 规则验证（2–3 天） | 拿 10 个真实社区插件跑手工规则，确认规则 1–12 的命中率与误报率 | 至少 3 个插件被命中真实问题，误报可控 |
| M1 CLI（1–2 周） | `npx dsh-plugin-lint <dir>` + JSON 输出 + GitHub Action | 在 20 个热门插件上跑通，产出"踩雷榜"文章 |
| M2 矩阵（2–3 周） | 真实 DSH 版本探测 + 静态站点 + JSON API | 覆盖 2 个 DSH 版本 × 50 个插件 |
| M3 面板（1–2 周） | DSH 设置页面板（读本地 report + 远程矩阵） | 本机安装验证通过，light/dark 主题一致 |

## 5. 验证方式（怎么证明有用，而不是自嗨）

- **规则有效性**：对目录里下载量 Top 50 的插件跑一遍 → 公布命中数与典型问题（这是最有说服力的传播内容）。
- **不误报**：对官方 @deepseek-ai/* 包跑一遍，**必须零 error**；任何 error 都视为规则 bug（官方代码是规则的基准实现）。
- **矩阵可信度**：每个结论附证据（安装日志、注册探测结果、失败原因分类）。
- **安装验证**：走官方 `plugin_manager` 的 `install_bundle`，看返回的 `application`/`warnings`，而不是看日志猜。

## 6. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 误报损害可信度 | 官方包作为零误报基准；规则分级（error/warn/info）；每条规则给官方出处链接 |
| 静态分析对动态写法无能为力 | 明确声明边界（"只报告检测到的事实，不做安全背书"），并提供动态探测作为补充 |
| DSH 版本演进使规则过期 | 规则集版本化，跟 `dsh.compatibility.dshReleases` 对齐；CI 定时跑官方包回归 |
| 受众小（插件作者） | 用"踩雷榜"+ 矩阵数据触达**用户**，用户会给作者压力；同时提供一键在 CI 使用的 action |
| 与现有工具重复的观感 | README 第一屏就放"与 doctor/testkit/trust-check 的分工表"，主动互链 |

## 7. 命名建议（ns 未定）

`dsh-plugin-lint`（包名直白、可搜索）→ 若做整体设施可叫 `dsh-plugin-health` / `dsh-conformance`。
GitHub 仓库名建议 `dsh-plugin-lint`，中文名"DSH 插件体检/合规检查"。
