# 01 · 生态地图

调研时间：2026-10-13 · 调研对象：本机 DSH Desktop（`@deepseek-ai/dsh` 0.2.0-rc.2 / profile `desktop`）

## 1. 数据来源（可复现）

```bash
# 生态规模：GitHub 话题
curl -s "https://api.github.com/search/repositories?q=topic:dsh-plugin&sort=stars&per_page=30"

# 社区目录（4,508 条，含 capability 标注）
curl -sL https://registry.npmjs.org/dsh-plugin-catalog/-/dsh-plugin-catalog-$(curl -s https://registry.npmjs.org/dsh-plugin-catalog | node -pe "JSON.parse(require('fs').readFileSync(0)).'dist-tags'.latest").tgz | tar xz
# → package/plugins.json

# npm 关键词检索
curl -s "https://registry.npmjs.org/-/v1/search?text=keywords:dsh-plugin&size=100"
```

本机另有权威一手资料：DSH 安装包内自带官方开发文档
`.../app.asar/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/`（已归档到 `reference/official-skill/`）。

> 注意：npm 月下载量可能被镜像/CI 放大，仅作**相对强弱**参考，不作绝对值。

## 2. 规模

| 指标 | 数值 |
| --- | --- |
| GitHub `dsh-plugin` 话题仓库数 | **18,925** |
| 官方仓库 star / 协议 | 248,322 / MIT |
| 社区目录收录插件 | **4,508**（2026-10-11 更新） |
| 其中可从 npm 安装 | 2,342 |
| 最近 30 天新增 | 984 |
| 目录内标注了 capability 的 | 3,535（**973 条完全没有标注**） |
| 标注了"红线"的 | 491 |

## 3. 分类覆盖（薄 → 厚）

| 插件数 | 分类 | 说明 |
| --- | --- | --- |
| 17 | agi | AGI 架构探索 |
| 24 | identity | 身份与通信 |
| 65 | voice | 语音与音频 |
| 68 | docs | 文档与渲染 |
| 77 | wsl | WSL / Windows 互操作 |
| 80 | market | 插件市场与管理 |
| 100 | browser | 浏览器与网页 |
| 109 | vision | 视觉与多模态 |
| 111 | git | Git 与代码评审 |
| 137 | fun | 娱乐 |
| 139 | remote | 远程与移动端 |
| 151 | security | 安全与权限 |
| 160 | theme | 主题外观 |
| 173 | notify | 通知与集成 |
| 178 | skill | 技能包 |
| 209 | memory | 记忆 |
| 215 | model | 模型接入 |
| 236 | usage | 用量计费 |
| 267 | workflow | 工作流自动化 |
| 298 | session | 会话与消息 |
| 323 | dev | 开发与运行时 |
| 585 | tools | 工具与能力 |
| **786** | **ui** | UI 增强 |

结论：**UI 类已经过密**（786 个），而 `dev`（323）里真正的"开发者工具"其实很少——大部分是被归入 dev 的运行时补丁。

## 4. 风险面：插件能力分布

插件 Host 代码**在宿主进程内执行，不受工作区沙箱约束**（官方 plugin-manager 文档原文）。目录里声明的能力分布：

| 占比 | 能力 |
| --- | --- |
| 66.2% | fs-read |
| 52.0% | network |
| 51.4% | env |
| 51.1% | fs-write |
| 35.9% | shell |
| 10.8% | credentials |
| 8.3% | llm |
| 7.4% | host-runtime |
| 7.2% | dynamic-code |
| 2.1% | subagent |

即：**约 1,620 个插件声明能执行 shell，486 个声明能读凭据**，而这些标注是**插件作者自己在目录里申报的静态声明**，没有被独立验证过；另有 973 个插件连声明都没有。

## 5. 头部玩家（消费级，月下载）

| 月下载 | 插件 | 赛道 |
| --- | --- | --- |
| 576K | dshmarket | 插件市场 |
| 262K | @michengai/dsh-codex-ui | 侧栏 / 会话树 |
| 204K | @michengai/dsh-skills-manager | 技能管理 |
| 183K | @michengai/dsh-archive-manager | 会话归档 |
| 168K | dsh-whale-widget | 余额挂件 |
| 140K | dsh-context | 上下文洞察 |
| 119K | @linxin666/dsh-web-all | 聚合全家桶 |
| 107K | dsh-cost-meter | 费用统计 |

## 6. 开发者工具现状（本次调研最关键的一节）

| 月下载 | 项目 | 做什么 | 覆盖的空白 |
| --- | --- | --- | --- |
| 31.0K | dsh-my-guardian | 新装插件先入候选区、失败自动禁用 | 运行时容错 |
| 19.6K | @noob-stupid/dsh-plugin-console | 框架升级门控、失败回滚、多源私有市场 | 升级安全 |
| 8.3K | dsh-update-checker | 更新检查 | 版本发现 |
| 6.6K | @perrylink/dsh-plugin-doctor | 包结构 / cordis patch 静态体检 | 结构合规 |
| 5.0K | @perrylink/dsh-github | GitHub CI 复合 action | CI 集成 |
| 2.7K | dsh-trust-check | 安装后**静态能力披露**（文件+行号+片段） | 供应链可见性 |
| 1.5K | create-dsh-plugin-cli | 脚手架 | 起步 |
| 1.4K | dsh-testkit | Docker 隔离的真实宿主生命周期发布门禁 | 发布验证 |

**读法**：这几个方向的"坑位"都有人占了，但**月下载都在 1K–9K 量级**（消费级头部是 100K+）。这说明：不是没人做，而是**还没人做成标准**。想进入这个区域，必须回答"我和 dsh-testkit / dsh-trust-check 有什么不同"。

## 7. 确认的空白（有检索证据）

| 方向 | 检索命中 | 结论 |
| --- | --- | --- |
| **插件 × DSH 版本 的已验证兼容矩阵** | 3 条（均不相关） | **几乎无人做** |
| **官方最佳实践的机检 / 惯用法 lint** | 8 条（均不相关） | **几乎无人做** |
| 插件生命周期自动化测试 | 1 条（dsh-testkit） | 已被占，但很浅 |
| DSH Web 界面**无障碍**（键盘/读屏/对比度） | 28 条，**全部是 computer-use 的 macOS AX**，没有一条是修 Harness UI 的 | **空白** |
| UI 多语言（官方只有 zh/en，社区只有俄语包） | 44 条，绝大多数是"翻译工具输出"，不是本地化 UI | **基本空白** |
| 构成冲突（多个插件抢同一 slot/路由/工具名/配置行） | 52 条，无专做冲突检测的 | **空白** |

## 8. 红海清单：不要做

插件市场、主题/皮肤、桌宠挂件、费用/额度统计、记忆系统、网页搜索 provider、权限网关与自动审批、远程/手机访问、IM 桥接、会话归档与回放、多模型 provider 接入、MCP 连接器、文档预览。
—— 以上每个方向都已有 10+ 个实现和月下载 50K+ 的头部产品。
