# 06 · 详细设计（含 2026-10-13 实测修正）

> 本文是 [03-推荐方案](03-recommendation.md) 的展开版。**第 2 节是实测结果，它推翻了初版规则集里的一部分设计**——先看实测，再看方案。

## 0. 一句话

给 DSH 插件生态做一层**体检 + 兼容性公证**：静态查出"声明缺失"和"踩官方明令的坑"，动态验证"这个插件版本在你当前的 DSH 上到底还能不能用"，并把结果公开成可复核的数据。

---

## 1. 问题定义：三件目前没人回答的事

| # | 用户的问题 | 现状 |
| --- | --- | --- |
| **P1** | 我装的插件，在管理页为什么是灰图标、没描述？它声明了自己要什么权限、支持哪个 DSH 版本吗？ | 管理页只显示结果，不告诉你缺了什么；目录里的 capability 是作者自报 |
| **P2** | 这个插件的代码写得符合官方规范吗？会不会拖慢我的会话、或者哪天升级就崩？ | 只有包结构检查（doctor）与能力披露（trust-check），**没人检查代码是否符合官方 practices** |
| **P3** | 我升级 DSH 之后，这 20 个插件还有几个能用？ | 官方 `dsh.compatibility.dshReleases` 靠作者手填，**实测 Top 40 插件里只有 13% 填了** |

P3 是痛点最深、也最容易被验证的一环：**生态里"升级安全"已经是一个被市场验证过的品类**（my-guardian 31K/月、plugin-console 19.6K/月、update-checker 8.3K/月），但它们全是**事后补救**（装完崩了再回滚），没有人做**事前公证**。

---

## 2. 实测：本机两个真实插件（M0-lite）

**样本**（你本机 profile `desktop` 里已装的两个第三方插件）：

| 插件 | 版本 | 月下载 | 形态 |
| --- | --- | --- | --- |
| `dsh-context` | 0.69.1 | ~140K | 只发打包产物 `lib/*.js`（压缩） |
| `ds-bot` | 0.1.3 | — | 直接发源码 `src/host/*.js`（可读，12K 行） |

**方法**：对瀑布监听器、事件订阅、资源释放、客户端依赖、清单字段逐条扫描。

### 发现 1：官方明令禁止的客户端依赖，在头部插件里占 40%

官方 practices 原文：*"Do not `require('@deepseek-ai/dsh-client-ui-primitives')` or load any other Harness Client package as a module… a throwing component blanks your slot entry"*。

实测证据（`dsh-context/lib/client.js`，浏览器模块表的加载调用）：

```js
let f = e("@deepseek-ai/dsh-client-ui-primitives");   // e = 浏览器模块表加载器
```

抽样 **Top 40 已发布插件**（读 npm 上的真实 manifest）：

| 指标 | 结果 |
| --- | --- |
| `peerDependencies` 里依赖官方 Client 包 | **16 / 40（40%）** |
| 声明了 `dsh.compatibility.dshReleases` | **5 / 40（13%）** |
| 声明了 `icon` | 16 / 40（40%） |

> 注意分寸：这不是"这些插件是坏的"。`dsh-context` 是把 primitives 声明为**可选** peer dep 的有意识选择，还自己标了兼容版本。但**它正是升级时最容易碎的那一类插件**——而这恰恰是用户最需要提前知道的事。工具要**陈述事实 + 引用官方原文**，不做道德审判。

### 发现 2：初版的"规则"有一半会误报

初版我写了 12 条规则，实测发现其中几条**按字面实现会对写得正确的代码报错**：

| 初版规则 | 真实代码怎么写 | 结论 |
| --- | --- | --- |
| "waterfall 监听器必须 `return next()`" | `ds-bot/parts.js:788` 在 3 个分支里 `return { kind: 'reject' }` **故意不调 next**（它拥有该决策）；`secrets.js:457` 在改写请求时 **重新进入 `ctx.llm.stream()` 而不是 next()**，还写了 6 行注释解释为什么 | ❌ 字面实现会误报。真正的 bug 是**什么都没返回就掉出函数**（静默截断链路） |
| "禁止订阅 `session/event`" | `ds-bot/turns.js:189` 订阅它做**增量**状态更新，不是全量重扫 | ❌ 官方禁止的是"订阅并重扫"，不是订阅本身 |
| "禁止 `agent/status`" | 官方禁止的是**轮询**，`ctx.on('agent/status')` 是事件订阅 | ❌ 规则写错了对象 |
| "`meta` 放 package.json" | `dsh-context/locale/en.json` = `{"meta":{"title":…}}` | ❌ 我理解错了位置，已修正 [04](04-dsh-plugin-dev-notes.md) |

**这是本项目最重要的一条设计输入**：规则必须**按可判定性分级**，而不是按"看起来对不对"。

### 发现 3：插件作者已经在手工打补丁解决"插件之间互相干扰"

`ds-bot/src/host/time-context.js:23-26`：

```js
// A loaded DSH clock covers every step itself. Its listener may run before or
// after this one (a reload reorders them), so its presence is read from its
// projection, not from the messages added so far.
if (ctx.get?.('sessionProjections')?.stateOf(agent.session, 'timeContext') !== undefined) return decision
```

作者必须**读另一个官方插件的 projection 来猜测它是否在场**，因为监听器顺序在热重载后会变。这说明"插件构成"的语义在实践中是**靠踩坑总结的**——这正是方向 B（构成冲突检查）的真实需求证据，也说明这个生态需要有地方把这类知识沉淀下来。

---

## 3. 规则集 v2：按可判定性分三级

**A 级 = 确定性**：纯语法/清单层面即可判定，零误报，可作 CI 的 `error`。
**B 级 = 半确定性**：需要轻量数据流或作用域分析，可能误报，作 `warn`，每条附官方出处。
**C 级 = 启发式**：只能给线索，作 `info`，明确标注"需人工复核"。

### A 级（先做这 6 条，零误报是底线）

| # | 规则 | 检测方法 | 官方出处 |
| --- | --- | --- | --- |
| A1 | 客户端代码不得加载官方 Client 包 | 扫描 client 入口的模块加载调用 + `peerDependencies`/`dependencies` 里的 `@deepseek-ai/dsh-client-*`（`react`/`react-dom`/`react/jsx-runtime` 白名单） | ui-plugin.md 明令 |
| A2 | 不得追加自定义 session event `type` | 找 `session.append(`/`.append({` 且对象字面量含 `type:`；白名单已存在的官方 type | practices「会话日志是唯一真相」 |
| A3 | 不得监听 `system-prompt/assemble` | 事件名字面量匹配 | practices 明令 |
| A4 | 清单完整性 | 检查 `dsh.bundle.patch` / `dsh.client.platform` / `icon` / `locale/<lang>.json` 的 `meta` / `exports` 是否含 `./package.json`；检查 `files[]` 是否漏掉运行时必需文件 | host-plugin.md |
| A5 | 兼容性声明 | 检查 `dsh.compatibility.dshReleases` 是否存在、是否覆盖当前 DSH 版本 | host-plugin.md |
| A6 | 可选服务必须声明 | 代码里 `ctx.get('x')` / 直接用某服务，但 `inject` 未列该服务且无存在性判断 → 在缺该服务的 profile 会抛错 | practices「把可选服务放进 inject」 |

### B 级（第二批，必须做误报控制）

| # | 规则 | 检测方法 | 为什么危险 |
| --- | --- | --- | --- |
| B1 | waterfall 监听器"掉出函数" | 只报**所有代码路径都不返回值**的 handler（不报主动 `reject`）；有 `return next()` / `return ctx.llm.stream()` / `return undefined` 的路径都算已决策 | 静默截断后续插件 |
| B2 | 改写决策未展开 | 返回对象字面量含 `kind:` 但缺 `...decision` 展开 | 丢 `startsRequestSeries` 等字段 |
| B3 | 资源未纳入 effect | `setInterval/setTimeout/addEventListener` 出现在 `apply` 作用域但不在 `ctx.effect`/`ctx.on` 内 | 卸载/热重载泄漏 |
| B4 | `agent.ctx` 注册未持有 disposer | `agent.ctx.*` 注册未包在 `agent.ctx.effect()` 中且插件未保存 disposer | 卸载插件不释放 agent |
| B5 | 订阅 `session/event` 且全量读日志 | handler 内出现 `session.events` 遍历 / `eventsBackwards(...Infinity)`，且无 `sessionProjections` | 每事件重扫，长会话拖垮 |
| B6 | 硬拒绝走错了扩展点 | 用 `system-prompt` 增删工具或文本，而非 `ctx.tools.guard()`/`restrict()`/`systemPrompt.section()` | 与顺序耦合、可被他人改写 |

### C 级（只给线索）

| # | 规则 | 说明 |
| --- | --- | --- |
| C1 | 轮询 `agent.status()`（定时器内） | 官方推荐等持久事件；需人工确认 |
| C2 | 客户端直接操作宿主 DOM | `document.body` / `querySelector` 出现在组件外 |
| C3 | 字面色值用于宿主 UI | 非 `--dsw-alias-*` 的颜色，可能是刻意美术，需人工判断 |
| C4 | 大依赖进宿主 | 宿主插件里 import 重库，影响启动 |

**验收底线（极重要）**：把 `@deepseek-ai/*` 官方包当作**零误报基准**——对官方包跑 A/B 级规则，**出现任何 error 都算规则 bug**，必须先修规则。这条写进 CI。

---

## 4. 兼容矩阵：本项目的旗舰

**为什么是旗舰**：13% 的声明率意味着"作者自报"这条路走不通，用户只能靠实测。而且它产出的是**数据**，数据会随时间增值、被引用、被集成——这是最难被抄走的部分。

**验证动作**（对每个 插件版本 × DSH 版本 组合）：

1. 在隔离目录用该 DSH 版本创建临时 profile
2. 安装该插件（等价于 `plugin_manager` 的 `install_bundle`，记录完整日志）
3. 启动宿主，读取 Loader 的插件状态与注册结果（**启动失败 / 注册为空 / 部分注册**要区分开）
4. 探测声明的产物：工具是否出现在工具表、路由是否响应、客户端 slot 是否注册成功
5. 卸载 + 重启，检查是否留下残留
6. 产出结构化结论：`works` / `partial` / `boot-fails` / `install-fails` / `uninstall-residue` + 日志证据

**规模问题怎么解（联邦式）**：全量 4,508 个插件 × N 个版本自己跑不现实。设计成：

- **自测**：插件作者在自己的 CI 里跑 official 校验工具，产出**签名结果**上传（数据来源透明可审计）
- **抽检**：本项目对下载量 Top N + 新版本 DSH 做独立复验，标记"已复验 / 仅自报"
- **榜单**：站点按"最近一次 DSH 版本"排列，显示哪些插件**尚未在最新版上验证过**

**防伪**：结果带签名与证据摘要（日志 hash）；"仅自报"与"已复验"在 UI 上用不同颜色，绝不混为一谈。

---

## 5. 产品形态

```text
dsh-plugin-lab/                    # monorepo
├─ packages/
│  ├─ core/          # 规则引擎 + 报告 schema（纯函数，可单测）
│  ├─ cli/           # npx dsh-plugin-lint <dir> --json --sarif
│  ├─ action/        # GitHub Action 封装
│  ├─ matrix/        # 兼容性验证跑批 + 站点数据生成
│  └─ panel/         # DSH 插件：设置页展示本机体检 + 矩阵查询
└─ data/             # 公开矩阵数据（JSON）
```

**报告 schema**（对外契约，先定死再写代码）：

```json
{
  "schemaVersion": 1,
  "target": { "name": "@you/plugin", "version": "1.0.0" },
  "dsh": { "declared": ["0.2.0-rc.2"], "verified": [] },
  "findings": [
    { "rule": "A1", "level": "error", "file": "lib/client.js", "line": 12,
      "message": "loads @deepseek-ai/dsh-client-ui-primitives",
      "evidence": "e(\"@deepseek-ai/dsh-client-ui-primitives\")",
      "doc": "ui-plugin.md#client-module" }
  ],
  "limits": ["静态分析，不构成安全背书", "打包产物可能影响行号精度"]
}
```

**CLI 体验**（目标是一眼能看懂）：

```text
$ npx dsh-plugin-lint .
@you/plugin@1.0.0  ·  DSH 0.2.0-rc.2

  A1  error  客户端加载官方 Client 包          lib/client.js:12
  A5  warn   未声明 dsh.compatibility          package.json
  A4  info   缺 locale/<lang>.json 的 meta     —

  6 项检查 · 1 error · 1 warn · 1 info      退出码 1（--exit-code）
```

---

## 6. 里程碑（按实测结果重排）

| 阶段 | 内容 | 完成标准 | 预估 |
| --- | --- | --- | --- |
| **M0**（已完成一半） | 用真实插件验证规则 | ✅ 已产出上面三个发现，规则集重做为 v2 | — |
| **M1 规则引擎 + CLI** | A 级 6 条 + B 级 6 条，JSON/SARIF 输出 | 对官方包跑：**0 error**；对 Top 40 插件跑：产出真实命中清单 | 1–2 周 |
| **M2 首个公开报告** | 对 Top 100 插件跑 A 级，发布"声明合规现状"报告 | 数据可复现（脚本 + 原始 JSON 一起开源） | 3–5 天 |
| **M3 CI Action** | `uses: you/dsh-plugin-lint@v1` | 在一个真实插件仓库里跑通并拦住一次真实问题 | 3–5 天 |
| **M4 兼容矩阵** | 隔离 profile 跑批 + 站点 + JSON API | 2 个 DSH 版本 × 30 个插件的真实结论 | 2–3 周 |
| **M5 DSH 面板** | 设置页：本机体检 + 兼容查询 | 本机安装验证通过（`application: applied`），明暗主题一致 | 1–2 周 |

**M2 的公开报告就是项目的传播起点**：不喊口号，直接给可复现的数据。

---

## 7. 怎么算成功 / 怎么算失败

| 信号 | 成功 | 失败（及时止损） |
| --- | --- | --- |
| 规则有效性 | 官方包 0 error；Top 40 里 A1 命中 ~40%、A5 命中 ~87% | 官方包也大量报错 → 规则设计有根本问题 |
| 作者反馈 | 有插件作者**按报告改代码**并发 PR | 只有下载没有修改 |
| 生态集成 | 有市场/目录引用本项目的 JSON 数据 | 数据无人消费 |
| 用户侧 | 用户用矩阵决定"升级前先禁用哪些插件" | 没人看矩阵 |

**止损线**：M1 结束时若 A 级规则对官方包仍有 error，或社区反馈"这些都是废话"——停下来，转做方向 B 或 C。

---

## 8. 与现有工具的分工（README 第一屏就放这张表）

| 工具 | 回答的问题 | 我们不重复 |
| --- | --- | --- |
| dsh-plugin-doctor | 包结构/构建能不能过 | ✅ 不碰构建 |
| dsh-testkit | 能不能装、能不能卸、生命周期是否干净 | ✅ 只在矩阵里做"安装+启动+注册探测"，不做 Docker 全生命周期 |
| dsh-trust-check | 这个插件会碰什么（能力披露） | ✅ 不做安全推断、不做拦截 |
| dsh-my-guardian | 装崩了怎么办（事后补救） | ✅ 我们做事前公证 |
| **本项目** | **写得合规吗 / 在这个 DSH 版本上验证过吗** | — |

---

## 9. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| **误报**（最大风险） | 一次误报就毁掉作者信任 | 三级分级；官方包零误报基准进 CI；每条 finding 必须带文件:行:证据:官方出处 |
| 只对打包产物可分析（如 dsh-context） | 行号漂移、噪声大 | 明确声明精度限制；优先分析源码仓库，打包产物只跑 A 级 |
| 规则随 DSH 版本过期 | 工具变成噪声源 | 规则版本化；CI 定时对最新 DSH + 官方包回归 |
| 矩阵跑批成本 | 做不大 | 联邦式（作者 CI 自测 + 签名上传）+ 抽检复验 |
| 被当成"又一个安全扫描器" | 定位模糊 | README 主动互链四个邻居，明确"我们是补齐最后一个格子" |
| 受众小 | 增长慢 | 用 M2 数据报告触达**用户**，用户推动作者 |

---

## 10. 待定问题（需要你决定）

1. **先做哪条腿**：CLI 体检（快、能立刻发报告）还是兼容矩阵（慢、但更独家）？我倾向 CLI 先行，用它养出数据与信任。
2. **规则引擎**：正则为主（快、糙）还是 AST（准、慢）？A 级用正则就够，B 级需要 AST。
3. **公开报告的署名与语气**：点名插件（传播强、有风险）还是匿名统计（安全、无锋芒）？建议**点名但只陈述事实 + 引用官方原文**，并在发布前通知作者。
4. **许可证**：Apache-2.0（有专利授权，适合基础设施）还是 MIT？
5. 是否同时做方向 B（构成冲突）作为第二个模块？
