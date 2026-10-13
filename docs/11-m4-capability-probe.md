# 11 · M4 能力探针：从"能挂载"到"到底给了模型什么"

验证时间：2026-10-13 · DSH 0.2.0-rc.2 · 结论：**成功，矩阵的核心差异化能力到手**。

## 1. 要验的问题（假设 #6）

> 无头环境下能不能探测**具体注册了什么**（工具、命令、路由），而不真的调用模型？

只能回答"能挂载"的矩阵，价值有限；能回答"这个版本上它给模型加了哪些工具、系统提示词涨了多少"，才是别人替代不了的。

## 2. 方法：让宿主自己把答案交出来

不需要内省 API，也不需要读源码。**用桩 provider 接住宿主的真实请求**——请求体里什么都有：

```text
1. 进程内起一个 Anthropic Messages 协议的桩服务（随机端口）
2. 往隔离 profile 加一层 patch overlay，把默认的 deepseek route 指过去：
     - id: llm-deepseek
       name: "@deepseek-ai/dsh-llm-deepseek-api-key"
       config:
         baseURL: http://127.0.0.1:<port>
         apiKeyEnv: PROBE_API_KEY     # 假 key，无需真凭据
3. 先跑一次基线（未装插件），记录模型可见的 tools / system
4. 装插件，再跑一次，做差集
```

宿主发来的请求体包含：`tools`（模型可见的完整工具表）、`system`（系统提示词）、`messages`、`dsh_session_log`，以及 **`dsh_plugin_packages`——宿主自己上报的、带版本的已加载包清单**。最后一项等于白送一份权威的"到底组成了什么"。

## 3. 踩到的坑（值得记下来）

第一版探针把桩服务和启动放在同一个进程里，却用 `execFileSync` 起子进程——**同步调用阻塞了事件循环，桩服务无法响应**，子进程就一直等，最终变成 6 分钟的重试风暴（`362341 ms`）。

改成异步 `execFile` + `await` 后：**3732 ms**。代码里已写明原因，避免以后有人"顺手改回同步"。

## 4. 实测结果（四种场景全部区分得开）

| 插件 | 状态 | 工具增量 | 系统提示词 | 耗时 |
| --- | --- | --- | --- | --- |
| `dsh-mnemon` | `active` | **+17**（`mnemon_remember`、`mnemon_recall`、`mnemon_forget` …） | 2640 → **7153** 字符 | 3.7 s |
| `dsh-context` | `active` | 无（它是仪表盘/命令类插件） | 不变 | 3.8 s |
| 夹具 `throws-in-apply` | `inactive`（Error + 堆栈） | 无 | 不变 | 2.8 s |
| 夹具 `missing-service` | `inactive`（pending: waiting for service） | 无 | 不变 | 1.8 s |

单插件全流程 **1.8 – 3.9 秒**（含基线启动、安装、复测）。

## 5. 矩阵因此能给出的结论

| 维度 | 数据来源 | 说明 |
| --- | --- | --- |
| 能否挂载 | stderr 的 `did not activate` 段 | 失败分类：error / pending |
| **注册了什么工具** | 请求体 `tools` 差集 | 精确到工具名 |
| **提示词成本** | `system` 字符数差 | token 开销的代理指标 |
| **组成了哪些包** | `dsh_plugin_packages` | 带版本，宿主自报 |
| 客户端半边 | — | ⚠️ 仍不在覆盖范围（见 [10](10-m4-verification.md)） |

## 6. 用法

```bash
node scripts/probe-boot.mjs dsh-mnemon --tools
node scripts/probe-boot.mjs test/probe-plugins/throws-in-apply --tools
node scripts/probe-boot.mjs <npm 包名或本地目录> [...] [--keep]
```

不带 `--tools` 时只做挂载检测（不需要桩服务，更快）；`--keep` 保留临时 DSH_HOME 便于排查。

## 7. 对 M4 的最终影响

1. 矩阵的**数据模型定稿**：`status` + `tools.added` + `systemPrompt.delta` + `packages.added` + 证据。
2. **联邦式完全可行**：这个脚本零依赖、输出 JSON、单插件几秒钟，作者可以在自己 CI 里跑完再上传。
3. 结论必须分两栏（host 半边 / 客户端半边），见 [10](10-m4-verification.md) 第 5 节。
4. 成本：100 插件 × 3 个 DSH 版本 ≈ **10–20 分钟**。
