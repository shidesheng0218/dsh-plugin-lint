# 10 · M4 技术验证：无头兼容性探针可行吗

验证时间：2026-10-13 · 环境：DSH 0.2.0-rc.2（桌面版自带）· 结论：**可行，但有一个必须写进结论的边界**。

## 1. 要验的问题（假设 #5）

> 能不能不启动完整 Web UI，就装好一个插件并判断它是否正常挂载？

这是 M4 兼容矩阵能否成立的前提。验不通，整个 M4 的设计都要改。

## 2. 方法（已固化成脚本）

```bash
node scripts/probe-boot.mjs <npm 包名或本地路径> [...] [--keep]
```

脚本做四件事：

1. 建一个**一次性 `DSH_HOME`**（`mkdtemp`），绝不碰真实 profile；
2. 在里面落一个 `headless` profile（官方自带，首次启动自动展开）；
3. 用官方 CLI `dsh plugin --profile headless add <spec>` 安装（内部走 pnpm 并选中 bundle）；
4. 无头启动一次，解析 stderr，输出结构化结论。

判定用的哨兵：一次性 home 里**没有凭据**，所以"合成成功"必然停在
`MISSING_CREDENTIAL: llm-deepseek: no API key…`。**能走到这句话 = 所有 entry 都挂载成功**。

## 3. 实测结论（四条，都可复现）

### 3.1 隔离可行，且 profile 是官方自带的

`DSH_HOME=/tmp/xxx` 即可完全隔离。注意：`headless` **是官方自带 profile，不能作为 `--from-default-profile` 的目标**（会报 `profile "headless" is shipped and cannot be a custom profile target`）——首次启动会自动落到 `$DSH_HOME/profiles/headless`。

### 3.2 安装可脚本化，而且很快

```text
dsh plugin --profile headless add dsh-context
dependencies: + dsh-context ^0.69.1     Done in 658ms
```

本地路径同样可行（`add /path/to/plugin` → pnpm `link:`），所以**作者可以拿未发布的目录直接跑矩阵**。

### 3.3 ⚠️ 最关键的发现：挂载失败只是 warning，退出码仍然是 0

故意做一个 `apply()` 抛错的插件，启动输出是：

```text
dsh: warning: 1 entry did not activate
throws-in-apply (throws-in-apply): Error: M4-PROBE: this plugin always fails to mount
    at new apply (file:///private/tmp/m4-plugins/throws-in-apply/index.js:2:9)
    at Fiber.execute (...)
dsh: MISSING_CREDENTIAL: ...
exit code = 0
```

**插件挂了，宿主照常启动，进程照常退出 0。** 任何"能不能启动 / 退出码是否为 0"的判定都检测不到插件故障——矩阵**必须解析 stderr 的 `did not activate` 段**。这一条如果不实测，矩阵会给出全套假阳性绿灯。

### 3.4 失败分类（实测区分得开）

| 状态 | stderr 特征 | 含义 |
| --- | --- | --- |
| `active` | 无 warning，直达 `MISSING_CREDENTIAL` | host 半边挂载成功 |
| `inactive: pending` | `pending (waiting for service: X)` | `inject` 的服务不存在 → 按设计保持不激活（可能是依赖被禁用，也可能是真不兼容） |
| `inactive: error` | `Error: …` + 堆栈 | `apply()` 抛错，附完整堆栈与出错文件行 |

| `install-failed` | pnpm 报错 | 包不存在 / 网络 / peer 冲突 |

移除插件后再次启动**无任何 warning**，说明探针可重复、无残留。

两种失败模式的**夹具已入库**（[`test/probe-plugins/`](../test/probe-plugins/)），可随时复验分类是否漂移：

```bash
node scripts/probe-boot.mjs test/probe-plugins/throws-in-apply test/probe-plugins/missing-service
# → inactive (Error) / inactive (pending)，真实插件 → active
```

## 4. 成本实测

| 场景 | 耗时 |
| --- | --- |
| 单插件（含两次启动 + 安装） | 1.7 – 6.7 秒 |
| 大包（`@deepseek-harness-tui/dsh-tui`） | 28.9 秒 |
| 纯启动一次 | ~0.62 秒 |

按 100 个插件 × 3 个 DSH 版本估算：**10–35 分钟**。矩阵在成本上完全可行，不需要分布式。

## 5. 边界（必须写进矩阵结论里）

> **headless 只验证 host 半边。客户端半边永远不会在这里运行。**

证据：`dsh-context` 自己的 patch 只插一行 host row，注释写得很清楚：

```yaml
# Bundle patch layer: the row loads the package's main entry as the host half
# (a plain Cordis plugin); the `dsh.client` declaration makes the web app load
# its ./client bundle as the browser half.
- insert:
    - id: dsh-context
      name: dsh-context
```

客户端半边由 web 应用在**浏览器**里按 `dsh.client` 声明加载。而报告显示 **62% 的插件与官方 Client 包耦合**——这部分矩阵**覆盖不到**。

所以 M4 的结论必须分成两栏，绝不能混：

| 结论 | 手段 | 覆盖 |
| --- | --- | --- |
| host 半边可用 | 本探针（自动、便宜） | 100% 可自动 |
| 客户端半边 | 静态规则（E2 工厂 id、A1 耦合）+ 将来的浏览器冒烟测试 | 目前仅静态 |

## 6. 对 M4 设计的直接影响

1. **状态机定稿**：`install-failed` / `boot-failed` / `inactive(pending)` / `inactive(error)` / `active(host-only)`。
2. **证据链**：每条结论附 stderr 片段 + 耗时 + 插件版本 + DSH 版本 + integrity 哈希。
3. **联邦式天然可行**：这个脚本零依赖、输出 JSON，**可以直接交给插件作者在自己的 CI 里跑**，再签名上传结果；我们只做抽检复验。
4. **反指标**：绝不用"启动成功"当健康结论——见 3.3。

## 7. 仍未验证的两件事

| # | 问题 | 影响 | 下一步 |
| --- | --- | --- | --- |
| 1 | 能否在无头下探测**具体注册了什么**（工具表、命令、路由）而不真的调用模型 | 决定矩阵是"能挂载"还是"功能可用" | 试 stub provider（本地假 OpenAI 端点 + 假 key）配合 `--json` 事件流 |
| 2 | 客户端半边能否自动化 | 62% 的耦合插件目前只有静态结论 | 试 web profile 无头启动能否捕获 client bundle 装配失败；或接浏览器冒烟 |

第 1 条如果做成，矩阵的结论就能从"挂载成功"升级到"注册了这些工具"——**这是把矩阵从合格做到不可替代的关键一步**。
