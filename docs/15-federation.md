# 15 · 联邦式：作者怎么自己跑，结果怎么进矩阵

## 1. 作者侧：一个 workflow（当前 action 不可用）

插件仓库里加一个 workflow（[action.yml](../.github/actions/probe/action.yml)）：

```yaml
name: dsh probe
on: [pull_request, workflow_dispatch]

jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: shidesheng0218/dsh-plugin-lint/.github/actions/probe@v1
        with:
          target: .                 # 本仓库就是插件
          dsh-versions: 0.2.0-rc.2,0.2.1-alpha.2
          mode: both                # headless（含工具清单）+ web（真实组合）
          comment: 'true'           # 在 PR 上贴结论
```

产出：`matrix-cells/<插件>/<DSH 版本>[+web].json`（作为 artifact 上传），以及一份 markdown 摘要。

**当前 action 不可用**：`action.yml` 用 `${{ github.action_path }}/scripts/matrix/run.mjs` 定位脚本，但 `github.action_path` 指向 action 目录，目录里只有 `action.yml`；另外 `tee` 在 `mkdir -p` 之前执行。作者现在要在 CI 里用探针，只能 checkout 本仓库后跑 `node scripts/probe-boot.mjs`（见 §6）。

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

抽检策略（手动触发）：对 `self-reported` 随机抽 20%（种子=运行序号），跑 [verify.mjs](../scripts/matrix/verify.mjs)：

- 一致 → 升级为 `verified`，并顺手刷新工具清单；
- 不一致 → 标记 `disputed`，把 `{reported, observed}` 一起写进 cell。

**不一致不会被掩盖**，这是这套机制能不能被信任的关键。

**当前状态：这是一条没有跑通的设计。** `matrix/cells/` 与复验报告 `matrix/index/verification.json` 都被 gitignore；2026-11-06 之前 `verify-sample.yml` 是每周三的调度任务，但它默认读一个干净 checkout 里不存在的 `matrix/cells`，每次都在 `CELL_READ_FAILED` 退出（例如 run 41825103086），一个 cell 也没验过。现在该 workflow 改为**仅手动触发**，必须通过 `cells` 输入提供一个已存在的语料目录；没有语料时它明确报错，而不是空转成绿色。

## 4. 本仓库的 workflow（当前 5 个）

| 文件 | 触发 | 作用 |
| --- | --- | --- |
| [ci.yml](../.github/workflows/ci.yml) | push / PR | 单测 + 从 npm 拉官方包做零误报基线 + 自检 panel |
| [matrix-refresh.yml](../.github/workflows/matrix-refresh.yml) | 每周一探针；发布需手动勾选 | 重跑 Top 50，把 candidate 作为 artifact 上传；点名数据只有在显式 `publish_named_data=true` 时才提交 |
| [verify-sample.yml](../.github/workflows/verify-sample.yml) | 手动 | 抽检自报 cell；必须提供已存在的 cells 目录 |
| [publish-lint.yml](../.github/workflows/publish-lint.yml) | main 上 lint 相关路径变更 | 版本已在 registry 则空转；新版本需先过单测、80 包基线、打包冒烟 |
| [publish-panel.yml](../.github/workflows/publish-panel.yml) | main 上 `panel/**` 变更 | 同上，另加打包安装 + import 冒烟 |

前三个 CI workflow 用 `gh` 开 PR，不依赖第三方 action。两个 publish workflow 的**发布结果**见 [docs/17](17-release.md)：panel 0.1.6 的 bump 进了 main 但 registry 没有 0.1.6，自动发布没有被证明可靠。2026-11-06 起两个 publish workflow 不再自动 bump：版本已在 registry 时 job 直接空转，发布必须来自一次显式的版本号变更，并先通过官方基线（lint）或打包 import 冒烟（panel）。

## 5. 已实测（2026-10-13，GitHub Actions / ubuntu-latest）

当时存在的三个 CI workflow 全部真跑过（publish workflow 是 2026-10-21 之后才加的，见 [docs/17](17-release.md)）：

| workflow | 结果 |
| --- | --- |
| `ci.yml` | ✅ 19 秒；**第一次执行就抓到一个真实缺陷**（把父目录传给 linter），已修 |
| `matrix-refresh.yml` | ✅ 2 分 33 秒（限定 2 插件 / 8 格）；数据与 macOS 一致 |
| `verify-sample.yml` | ✅ 10 秒；无自报 cell 时正确空转，不开空 PR（历史记录；后来的每周调度在干净 checkout 上失败，见 §3） |

### 跨平台可复现性（Linux vs macOS，同一格）

```text
dsh-mnemon x 0.2.0-rc.2 [headless]
  status       active           vs  active
  tools        17               vs  17      （清单逐项相同）
  packages     5                vs  5
  prompt 字符  7157             vs  7153    ← 差 4 字符
  耗时         17.8s            vs  4.4s    ← runner 更慢，符合预期
```

**那 4 个字符的差异要写进结论的语气里**：系统提示词含运行环境的路径（`/home/runner/work/…` vs `/private/tmp/…`），所以"提示词字符数"是**近似量**，不应被当作精确可复现值。其余字段（状态、工具清单、包清单）跨平台完全一致。

## 6. 诚实的限制

- **作者侧 composite action 目前不可用**：[action.yml](../.github/actions/probe/action.yml) 用 `${{ github.action_path }}/scripts/matrix/run.mjs` 定位脚本，但 `github.action_path` 指向 action 目录，目录里并没有 `scripts/`（只有 action.yml）。作者要用探针，目前得从本仓库 checkout 直接跑 `node scripts/probe-boot.mjs`。
- **web 组合需要 pnpm 与网络**：CI 里用 `pnpm/action-setup`，装插件时访问 npm registry。
- **客户端半边仍不覆盖**：见 [10](10-m4-verification.md) §5。
- **大插件慢**：单格 2–180 秒（`@roarpeng/graphflow` 依赖 `onnxruntime-node`，实测 183 秒）。

## 7. 为什么值得作者跑

| 作者得到 | 说明 |
| --- | --- |
| 升级前预警 | DSH 发新版时，先知道自己会不会 `rejected-by-host` |
| 工具清单与提示词成本 | 自己插件的 `+N tools` 与 prompt 字符增量，可写进 README |
| 徽章 | 站点与索引可生成 README 徽章 |
| 免费的真实环境测试 | 官方 profile 里装一遍、起一遍，不用自己搭 |
