# 16 · M5 面板：把矩阵放进设置页

代码在 [panel/](../panel/)，说明见 [panel/README.md](../panel/README.md)。

## 1. 它做什么

在 DSH 设置页加一个 **Plugin Health Center** 区块，列出**本 profile 已安装的插件**，以及每个插件在各 DSH 版本上的实测裁决；下方是生态聚合计数（只有数字，没有包名）。

数据有两个来源，取决于本地有没有全量快照：

| 来源 | 内容 | 何时生效 |
| --- | --- | --- |
| `data/matrix-index.json` | 全量矩阵快照，含包名与逐插件裁决 | 本地存在该文件，或设置了 `DSH_PLUGIN_LINT_INDEX` |
| `data/aggregate.json` | 每版本状态计数，无包名 | 全量快照不存在时；npm 包只随附这个文件 |

**因此从 npm 安装的面板只显示聚合数据，逐插件矩阵列需要本地快照。** `data/matrix-index.json` 由 `scripts/matrix/bundle-panel-data.mjs` 在本地生成，被 gitignore，也不在 panel 的 `files` 里。

当前矩阵快照：50 个插件 × 2 个 DSH 版本 × 2 种组合 = 200 格，采集于 2026-10-16。状态计数：0.2.0-rc.2 上 active 80 / awaiting-service 16 / rejected-by-host 2 / install-failed 2；0.2.1-alpha.2 上 active 72 / awaiting-service 20 / rejected-by-host 8。

### 数据口径（必须和数字一起读）

- **记录版本 ≠ 实际加载版本。** 200 格中有 23 格记录的 `plugin.version` 与 cell 自己记录的"实际装入版本"不一致；cell 的 `reproduce` 命令不带版本。面板的逐插件裁决应视为该次跑批的快照，不是可精确复现的当前状态。
- **逐插件数据不在版本库里。** `matrix/cells/` 与 `matrix/index/` 被 gitignore，干净 clone 只有 `panel/data/aggregate.json`；重建需要网络、npm 与探针。
- **版本覆盖旧。** 快照只钉 `0.2.0-rc.2` 与 `0.2.1-alpha.2` 两个 DSH 版本。

## 2. 结构：host 路由 + client 槽位

```text
浏览器 (settings.section)                宿主
  fetch POST /api/dsh-plugin-lint/panel
  <- { dsh.version, profile.bundles[], rows[] }
                                          |- 读 $DSH_PROFILE_DIR/package.json 取已选 bundle
                                          |- 读 node_modules/<pkg>/package.json 取实际版本
                                          - 与本地快照 join，得到每个插件的各版本裁决
```

两条 API 都是从**真实可用的参照插件**（dsh-trust-check 的 source map + 本机 dsh-context）里逐字确认的，没有靠猜：

| 用途 | 实际 API |
| --- | --- |
| 注册路由 | ctx.inject(["connection"], c => c.effect(() => connection.fetch.register({ path, methods: ["POST"], requestBody: "buffered", fetch }))) |
| 返回值 | Response.json(payload, { headers: { "cache-control": "no-store" } }) |
| 注册设置区块 | ctx.slots.inject("settings.section", () => ctx.slots.register({ name, id, order, label }, Component)) |
| 浏览器取数 | 相对路径 fetch("/api/...", { method: "POST" }) |

## 3. 两个刻意的设计选择

**只用 react，不 import 任何官方 Client 包。** 官方文档明令禁止把 Harness Client 包当模块加载（会无预警变更、抛错会白屏 slot）。颜色只用 --dsw-alias-* token，且每个都带 fallback —— token 改名只会让观感降级，不会让页面崩。token 名字是从官方 bundle 里统计出来的真实名字（label-primary、border-l1、state-success-primary …），不是猜的。

**组件外包了一层 error boundary。** 官方文档写明：抛错的组件会把整个 slot entry 变空白。空白设置页比一条错误消息糟糕得多。

## 4. 验证状态（诚实版）

| 检查 | 结果 |
| --- | --- |
| host 半边在 0.2.0-rc.2 上挂载（headless + web） | ✅ 两种组合都 active |
| host 半边在 0.2.1-alpha.2 上挂载（headless + web） | ✅ 两种组合都 active |
| 用我们自己的 linter 检查本包 | ✅ **0 error · 0 warn · 0 info**（11 checks） |
| host payload 逻辑（已装 bundle × 矩阵 join） | ✅ 14 个 node:test 用例（`node --test test/panel.test.js`） |
| **页面在浏览器里长什么样** | ✅ **已验证并截图**（见下） |

### 视觉验证

[`scripts/screenshot-panel.mjs`](../scripts/screenshot-panel.mjs) 在一个**一次性 web profile** 里装上面板、启动界面、用 Chromium 打开并截图——全程不碰任何真实 profile：

```bash
node scripts/screenshot-panel.mjs        # 写出 docs/assets/panel.png
```

这一步抓到了两个代码审查没发现的 bug：

| 症状 | 原因 | 修法 |
| --- | --- | --- |
| 页面显示 "Running DSH unknown" | `import.meta.resolve` 在 profile 里解析不到 `@deepseek-ai/dsh` | 改从启动器路径（`process.argv[1]`）回推安装位置 |
| 官方 bundle 显示 "not installed" | 它们从 dsh 安装处解析，不在 profile 的 node_modules 里；而且 `payload()` 重新构造行对象时把 `providedBy` 丢掉了 | 新增 `providedBy: profile \| dsh-installation`，并把它透传到行对象 |

两个都补了单测防回归。**视觉验证的价值在于：它能发现代码审查看不到的"逻辑对但话是错的"问题。**

截图里还能看到面板的诚实边界：脚注写明每格只是 host 半边的探针结果、浏览器半边不在探针范围内、"untested here" 不等于失败、以及"这些是对具名包的检测事实，不是裁决"。

## 5. dogfooding

面板本身是我们 11 条规则的真实测试用例，一次就干净：

```text
$ node bin/dsh-plugin-lint.mjs panel
  clean  no findings
  0 error · 0 warn · 0 info
```

对比生态现状：**62% 的头部插件与官方 Client 包耦合**。我们自己不这么做 —— 现在它是被 CI 强制的（`ci.yml` 里对 panel 跑 `--exit-code`）。

## 6. 怎么用

```bash
node scripts/matrix/bundle-panel-data.mjs          # 把本地矩阵快照进 panel/data/
dsh plugin --profile <profile> add <panel 目录绝对路径>   # 从 checkout 安装
```

npm 上的面板版本是 **0.1.5**（2026-10-21 发布）；工作区的 0.1.6 **未发布**（registry 没有 0.1.6，见 [docs/17](17-release.md)）。从 npm 安装时只用聚合数据，逐插件矩阵需要本地快照：先跑上面的 bundle 脚本，或用 `DSH_PLUGIN_LINT_INDEX` 指向一个本地 `matrix-index.json`。

面板已声明兼容 0.2.0-rc.2 与 0.2.1-alpha.2（依据是上表的实测挂载结果，不是自报）。
