# 08 · 作者通知流程（发布前必做）

决策来源：[ADR D-001](05-decision-log.md) —— **点名 + 只陈述事实 + 发布前通知作者**。

## 流程

| 步骤 | 动作 | 产出 |
| --- | --- | --- |
| 1 | 跑报告：`node scripts/build-report.mjs --top 100` | `reports/<日期>/{raw.json,packages.json,REPORT.md}` |
| 2 | 生成通知名单：`node scripts/build-contact-list.mjs reports/<日期>` | `reports/<日期>/CONTACTS.md`（含维护者邮箱、仓库、每条结论与复现命令） |
| 3 | 逐包联系维护者（issue 或邮件），给出**至少 14 天**回应期 | 每包的沟通记录 |
| 4 | 收到回复后：作者证明规则错了 → **先修规则并重跑**；作者确认属实 → 报告保留原始事实 | 更新后的报告与规则变更记录 |
| 5 | 14 天期满后才可公开发布；报告中每条未回应项标注"已通知，未回应" | 公开发布版 |

## 通知模板（中文）

```text
主题：[dsh-plugin-lint] 关于 <包名>@<版本> 的静态检查结果（发布前告知）

你好 <维护者>：

我们在做一个针对 DeepSeek Harness 插件的静态合规检查工具 dsh-plugin-lint，
对 npm 上按下载量排序的前 100 个社区插件做了一次体检，其中涉及你的 <包名>@<版本>。

以下是**检测到的事实**（不是评价，也不构成安全结论）：

- 规则 <规则号>（<级别>）：<一句话描述>
  - 位置：<文件:行>
  - 检测到：<message>
  - 证据：<evidence>
  - 依据文档：<doc>

复现方式：
  npx dsh-plugin-lint .        # 在解包后的插件目录里执行

我们的报告计划在 <日期> 公开发布，会点名列出上述事实。
在此之前：
- 如果这条**判断有误**，请直接回复，我们会先修规则再重跑，并在变更记录里注明；
- 如果有我们没考虑到的上下文（例如该写法是有意为之），也欢迎说明，我们会把它写进报告的"限制"一节。

顺祝顺利。
```

## 通知模板（English）

```text
Subject: [dsh-plugin-lint] static check result for <package>@<version> (heads-up before publication)

Hello <maintainer>,

We maintain dsh-plugin-lint, a static conformance checker for DeepSeek Harness plugins.
We ran it over the top 100 community plugins by downloads, and it reported the following
for <package>@<version>.

Detected facts (not a judgement, and not a security conclusion):

- Rule <id> (<level>): <title>
  - where: <file:line>
  - detected: <message>
  - evidence: <evidence>
  - source document: <doc>

Reproduce:
  npx dsh-plugin-lint .        # inside the unpacked package directory

We plan to publish the report on <date>, naming the packages and these facts.
Before then: if the finding is wrong, tell us and we will fix the rule and re-run before
publishing, with the change recorded. If there is context we are missing (for example the
pattern is deliberate), we will add it to the report's limitations section.
```

## 红线（自己给自己定的）

- 不做**风险评分**、不做**排行榜**、不做"最危险的插件"这类叙事。
- 不做安全背书，也不做安全推断（那是 dsh-trust-check 的边界）。
- 每条结论必须能被第三方用一条命令复现；不能复现的结论不许写进报告。
- info 级（缺图标、缺兼容声明）不单独通知——那是生态普遍现状，不是某个作者的问题；只在报告里给汇总数据。
