# 16 · M5 面板：把矩阵放进设置页

代码在 [panel/](../panel/)，说明见 [panel/README.md](../panel/README.md)。

## 1. 它做什么

在 DSH 设置页加一个 **Plugin compatibility** 区块，列出**本 profile 已安装的插件**，以及每个插件在各 DSH 版本上的实测裁决。

数据来自 matrix/index/latest.json，构建时快照进 panel/data/matrix-index.json —— **离线可用，且只会显示我们已经发布过的结论**。

## 2. 结构：host 路由 + client 槽位

```text
浏览器 (settings.section)                宿主
  fetch POST /api/dsh-plugin-lint/panel
  <- { dsh.version, profile.bundles[], rows[] }
                                          |- 读 $DSH_PROFILE_DIR/package.json 取已选 bundle
                                          |- 读 node_modules/<pkg>/package.json 取实际版本
                                          - 与快照 join，得到每个插件的各版本裁决
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
| 用我们自己的 linter 检查本包 | ✅ **0 error · 0 warn · 0 info** |
| host payload 逻辑（已装 bundle × 矩阵 join） | ✅ 5 个单测 |
| **页面在浏览器里长什么样** | ❌ **未验证** |

最后一行是真实缺口，不是客套：**构建过程中没有可用的浏览器控制能力**，所以布局、明暗两套主题下的观感、表格实际渲染都没被人看过。在有人真正打开这个页面之前，视觉设计一律按未验证对待。

官方 verification 文档对这种情形的要求也是如此：只做 JS 语法、清单校验、槽位注册验证，并**明确声明视觉未验证**。

## 5. 顺带的结果：dogfooding 通过

面板本身是我们 11 条规则的真实测试用例，而且一次就干净：

```text
$ node bin/dsh-plugin-lint.mjs panel
  clean  no findings
  0 error · 0 warn · 0 info
```

对比生态现状：**62% 的头部插件与官方 Client 包耦合**。我们自己不这么做 —— 现在它是被 CI 强制的（ci.yml 里对 panel 跑 --exit-code）。

## 6. 怎么用

```bash
node scripts/matrix/bundle-panel-data.mjs     # 把最新矩阵快照进 panel/data/
dsh plugin --profile <profile> add <panel 目录绝对路径>
```

面板已声明兼容 0.2.0-rc.2 与 0.2.1-alpha.2（依据是上表的实测挂载结果，不是自报）。
