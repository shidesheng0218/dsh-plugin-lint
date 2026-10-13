# 07 · M1 实测结果（2026-10-13）

M1 的目标是**证伪最高风险的假设**：规则集能不能做到对官方代码零误报。结论是——**能，但初版规则有一半必须重做**。

## 1. 验收基线：官方包零误报

```text
node scripts/e2e-official.mjs
  packages checked: 80
  findings by rule: 80 I1(info) · 159 I2(info) · 1 W3(info)
  error-level findings: none
  PASS
```

**0 error / 0 warn**，只剩 info 级（缺兼容声明、缺展示元数据）——这本身正是生态现状，不是规则缺陷。

## 2. 外部验证：12 个真实已发布插件

```text
node scripts/lint-npm-packages.mjs dsh-context ds-bot dsh-cost-meter ... dsh-vision-router
  packages linted: 12
  findings by rule: 13 W1(warn) · 9 I1(info) · 16 I2(info) · 2 W3(info)
  totals: 0 error · 13 warn
```

被抽查的 12 个插件（含 dsh-context、ds-bot、dsh-cost-meter、dsh-whale-widget、dsh-mnemon、dsh-vision-router 等）**没有触发任何 error 级规则**。

## 3. 最重要的产品结论

> **error 级规则在真实插件上的命中率是 0。它们是"防罕见致命错误"的保险，不是产品价值本身。**

当前能给用户的日常价值是另外两件事：

| 价值 | 规则 | 实测覆盖率 |
| --- | --- | --- |
| **耦合清单**：这个插件和宿主内部模块绑得多深（升级风险） | W1 | 12 个插件里 **13 条命中，涉及 8 个插件** |
| **声明完整性**：兼容版本、图标、多语言元数据有没有 | I1 / I2 | 12 个插件里 **25 条 info**，几乎人人缺 |

这直接决定 M2 的叙事：**首份公开报告不该是"抓到了多少违规"，而应该是"生态的耦合与声明现状"**——那是真实、可复现、且每个人都相关的数据。error 级规则继续留在工具里当保险，但不要拿它当卖点（否则会像"零结果的安全扫描器"一样没人用）。

## 4. 初版规则被实测推翻的三条（保留记录）

| 初版规则 | 实测反例 | 处置 |
| --- | --- | --- |
| waterfall 监听器必须 `return next()` | 真实插件会**故意 reject**（拥有决策），还会**重新进入 `ctx.llm.stream()`** 重发请求 | 降级为 B 级，只报"所有路径都不返回" |
| 禁止监听 `system-prompt/assemble` | **官方包自己就有 4 处监听**（agent-preset-registry、dsh-agent、session-reference、system-prompt） | **删除**：官方禁的是"用它增删工具/文本"，不是监听本身，而这不可静态判定 |
| 禁止订阅 `session/event` | 官方 `dsh-api-session-controller` 合法订阅并做增量缓冲 | 收紧为"**回调体内**出现全量日志重扫"（用括号平衡提取回调体） |
| `meta` 放 package.json | 实际在 `locale/<lang>.json` 的 `meta` 键（dsh-context 实证） | 修正规则与文档 |

另外修掉两个自身 bug（都由验收测试抓出）：
- 路径未归一化 `./` → E5 在 52 个官方包上误报（**验收测试第一次运行就抓到了**）
- 字符串扫描器把 `quote` 写成了布尔值而非字符 → 字符串在换行处才结束，导致 E2 取词带上 `","`

## 5. 噪声治理（跑真实数据才暴露的问题）

- `dsh-genui` 一个包刷出 **10 条 W1**（每条依赖一条）→ 改为**按"面"聚合**：代码加载一条、清单依赖一条，降到 2 条。
- 官方包上的 W1 有 **70 条**（所有官方客户端包都加载 primitives/store/slots）→ 加**第一方豁免**，并写明理由（第一方与模块表同版本发布）。
- 官方包上的 W3 有 7 条 → 括号深度在打包产物上不可靠，**降级为 info** 并在提示里说明需人工确认。

## 6. M1 交付物清单

| 文件 | 说明 |
| --- | --- |
| `src/mask.js` | 注释/字符串感知扫描器（masked 视图 + structural 视图 + 字符串索引 + 回调体提取 + 括号深度） |
| `src/load.js` | 包加载、entry 解析、npm `files` 覆盖判定 |
| `src/rules.js` | 11 条规则，每条带官方出处 |
| `src/index.js` | 引擎与报告 schema |
| `src/report.js` | text / JSON / SARIF 三种输出 |
| `bin/dsh-plugin-lint.mjs` | CLI（`--json` `--sarif` `--dsh-version` `--exit-code`） |
| `test/lint.test.js` | 19 个单测（每条规则正例 + 反例） |
| `scripts/e2e-official.mjs` | 官方包零误报验收 |
| `scripts/lint-npm-packages.mjs` | 对真实已发布 npm 包抽样体检（M2 报告的基础设施） |
| `src/data/event-types.json` | 45 个官方 session 事件类型目录（从官方 append 调用点采集） |

## 7. M2 建议（按实测数据重排）

1. 扩样到 **Top 100** 已发布插件，产出"耦合与声明现状"报告（脚本已就绪，只需扩名单 + 生成 JSON）。
2. 报告必须**可复现**：连脚本、原始 JSON、DSH 版本一起公开。
3. 发布前**逐一通知被点名的作者**（业主已定口径：点名 + 只陈述事实）。
4. 之后再启动 M4 兼容矩阵——因为矩阵要解决的是 W1/I1 暴露出来的同一个问题：**升级时到底谁会碎**。
