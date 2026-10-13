# 15 · 联邦式：作者怎么自己跑，结果怎么进矩阵

## 1. 作者侧：一个 action，一次 PR 评论

插件仓库里加一个 workflow（[action.yml](../.github/actions/probe/action.yml)）：

```yaml
name: dsh probe
on: [pull_request, workflow_dispatch]

jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: <owner>/dsh-plugin-lint/.github/actions/probe@v1
        with:
          target: .                 # 本仓库就是插件
          dsh-versions: 0.2.0-rc.2,0.2.1-alpha.2
          mode: both                # headless（含工具清单）+ web（真实组合）
          comment: 'true'           # 在 PR 上贴结论
```

产出：```matrix-cells/<插件>/<DSH 版本>[+web].json```（作为 artifact 上传），以及一份 markdown 摘要。

**不需要 API key**：桩 provider 是本地的，只用来读取宿主发出的真实请求。

## 2. 结果怎么进矩阵

作者把自己的 cell 提交成 PR（或贴到 issue），标记来源：

```json
"run": { "at": "…", "trust": "self-reported", "tool": "dsh-plugin-lint/probe" }
```

## 3. 信任级别：三档，永不混

| 级别 | 来源 | 站点标记 | 含义 |
| --- | --- | --- | --- |
| `verified` | 本项目跑批，或抽检通过 | ✅ | 我们背书"我们跑出来是这样" |
| `self-reported` | 作者 CI 上传，未经复验 | 🟡 | **仅代表作者所述** |
| `disputed` | 抽检结果与自报不一致 | ⚠️ | **两个结论都留在文件里**，差异公开 |
| `stale` | 超过 30 天，或 DSH 已发新版 | ⏳ | 结论可能过期 |

抽检策略：每周对 `self-reported` 随机抽 20%（种子=运行序号，可复现），跑 [verify.mjs](../scripts/matrix/verify.mjs)：

- 一致 → 升级为 `verified`，并顺手刷新工具清单；
- 不一致 → 标记 `disputed`，把 `{reported, observed}` 一起写进 cell。

**不一致不会被掩盖**，这是这套机制能不能被信任的关键。

## 4. 本仓库的三个 workflow

| 文件 | 触发 | 作用 |
| --- | --- | --- |
| [ci.yml](../.github/workflows/ci.yml) | push / PR | 单测 + 从 npm 拉官方包做零误报基线 |
| [matrix-refresh.yml](../.github/workflows/matrix-refresh.yml) | 每周一 | 重跑 Top 50，开 PR 提交变化的 cell |
| [verify-sample.yml](../.github/workflows/verify-sample.yml) | 每周三 | 抽检自报 cell，开 PR 提交复验结果 |

三个 workflow 都用 `gh` 开 PR，不依赖第三方 action。

## 5. 诚实的限制

- **这些 workflow 还没在 GitHub 上真跑过**：本仓库目前只有本地 git，没有远端。它们的 YAML 未经执行，逻辑则跑在已被本地测试的 `scripts/` 上（action 只是薄包装，因此未执行的风险面很小）。
- **web 组合需要 pnpm 与网络**：CI 里用 `pnpm/action-setup`，装插件时访问 npm registry。
- **客户端半边仍不覆盖**：见 [10](10-m4-verification.md) §5，action 的摘要里也写了这句。
- **大插件慢**：单格 2–180 秒（`@roarpeng/graphflow` 依赖 `onnxruntime-node`，实测 183 秒）。

## 6. 为什么值得作者跑

| 作者得到 | 说明 |
| --- | --- |
| 升级前预警 | DSH 发新版时，先知道自己会不会 `rejected-by-host` |
| 工具清单与提示词成本 | 自己插件的 `+N tools` 与 prompt 字符增量，可写进 README |
| 徽章 | 站点与索引可生成 README 徽章 |
| 免费的真实环境测试 | 官方 profile 里装一遍、起一遍，不用自己搭 |
