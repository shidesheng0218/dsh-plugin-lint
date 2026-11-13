# 17 · npm 发布记录与对账

本文记录**已发生**的发布事实、**未完成**的版本对账，以及自动发布链路的真实状态。历史小节保留原样，但不作为"当前已发布版本"的证据；当前状态看 §8。

## 1. 名字被占了（一个真发现）

准备发布时才发现：**dsh-plugin-lint 已经存在于 npm**，而且是一个**同类工具**——

```text
dsh-plugin-lint@0.2.1
  "Static linter for DeepSeek Harness (DSH) plugins: packaging closure,
   client-face dependency sniffing, Android constraint pre-check"
  maintainer: sunnyyuber    first published: 2026-09-20
  repo: github.com/SUNNYYUBER/DSH-Tavern-for-Android
```

它的 packaging closure 与我们的 E3/E5（清单指向缺失文件、发布产物漏文件）**范围重叠**。

这是我的疏忽：ADR 里写了"未占用检查待做"，但一直没做。教训记在这里 —— **名字可用性应该在任何品牌相关工作之前查**。

## 2. 决定：改用个人 scope

发布名定为 **@shidesheng0218/dsh-plugin-lint**。理由：

- 生态惯例如此：@michengai/*、@linxin666/* 都是个人 scope，且是下载量最高的插件之一
- 零改名成本：GitHub 仓库、bin 名、文档、CI 全部不用动
- scoped 包发布需显式 --access public，已在 publishConfig 里写死

如果以后想要无 scope 的品牌名，可选且均可用：dsh-conformance、dsh-plugin-conformance。

## 3. 包内容（2026-10-14，0.1.0 发布时实测）

```text
@shidesheng0218/dsh-plugin-lint@0.1.0
  package size  28.5 kB    unpacked 85.8 kB    13 files
  bin: dsh-plugin-lint, dsh-plugin-probe
```

发布前做了一次**真实安装冒烟**（打包 → 装进临时项目 → 跑命令），不是只看 dry-run：

| 检查 | 结果 |
| --- | --- |
| ./node_modules/.bin/dsh-plugin-lint <dir> | ✅ 正常输出，退出码 0 |
| dsh-plugin-probe 是否随包安装 | ✅ 在 .bin/ 里 |
| 库导入 import("@shidesheng0218/dsh-plugin-lint") | ✅ 9 个导出（lintPackage / formatText / toSarif / RULES …） |

以上是 0.1.0 的记录。工作区现在是 0.3.0（未发布），包内容已经变化，见 §8。

## 4. 发布步骤（0.1.0 实际执行过）

```bash
cd dsh-plugin-lab
npm login                     # 或设置 NPM_TOKEN
npm publish                   # publishConfig 已声明 access: public
```

发布后验证：

```bash
npm view @shidesheng0218/dsh-plugin-lint version
npx @shidesheng0218/dsh-plugin-lint . --no-color
```

## 5. 0.1.0 发布前状态（历史快照）

| 项 | 状态 |
| --- | --- |
| 包名可用 | ✅ @shidesheng0218/dsh-plugin-lint 未被占用 |
| 版本 | 0.1.0（首次发布） |
| 包内容 | ✅ 13 个文件，含 LICENSE / NOTICE / README |
| 依赖 | ✅ 零运行时依赖 |
| 测试 | ✅ 当时 28/28（当前套件用例数见 §9，不沿用此数） |
| 安装冒烟 | ✅ 见上表 |
| npm 登录 | ✅ 发布时已解决（见 §6） |

## 6. 实际发布（2026-10-14，已上线）

**@shidesheng0218/dsh-plugin-lint@0.1.0 已发布**，registry 验证通过：`npx -y @shidesheng0218/dsh-plugin-lint <目录>` 从 registry 拉取并正常运行，两个 bin 都在。

过程中三个值得记录的事实：

| 现象 | 真相 |
| --- | --- |
| 发布需要 OTP | 账号开了 2FA；npm 正在收紧绕过 2FA 的 token，这是平台策略 |
| 搜索 API 一度显示 `0.0.0-stage` | npm 的 staged publish 中转态，确认后变成 0.1.0，dist-tag latest 正常 |
| 日志警告 bin 条目 "invalid and removed" | **文案有误导**：因为值写了 `./bin/...` 前缀，`secureAndUnixifyPath` 归一化后**保留**了条目。已发布的包里 bin 是好的；本地 package.json 已去掉 `./` 前缀与线上一致 |

## 7. 自动发布（2026-10-21 加入）

两个 workflow 接管发版，触发条件是 main 上对应目录有变更：

| workflow | 触发路径 | 发布对象 |
| --- | --- | --- |
| `publish-lint.yml` | `src/` `bin/` `scripts/lib/` `scripts/probe-boot.mjs` `package.json` | `@shidesheng0218/dsh-plugin-lint` |
| `publish-panel.yml` | `panel/` | `@shidesheng0218/dsh-plugin-lint-panel` |

设计行为：

- 先跑 `npm test`，再跑 `npm whoami` 校验 token；**校验失败在 bump 之前停下**，避免留下没发布的版本号（commit d753034 补上的）
- 当前版本已在 npm 上时自动 bump patch，把 bump 提交推回 main，并用提交标题前缀让本次 job 跳过自己
- `npm publish --provenance`（需要仓库公开 + `id-token: write`）

必需的前置条件：仓库 secret `NPM_TOKEN`，值为 npm **Automation** token（绕过 2FA）。未配置时的报错是 `ENEEDAUTH`。

**注意：以上是设计目标，不是已验证结果。** 见 §8。

## 8. 对账状态（2026-10-26）

### 8.1 registry vs 工作区

| 包 | registry 最新 | 工作区 | 结论 |
| --- | --- | --- | --- |
| `@shidesheng0218/dsh-plugin-lint` | **0.1.0**（2026-10-14） | **0.3.0** | 工作区版本未发布；npm 上只有 0.1.0（另有中转态 0.0.0-stage） |
| `@shidesheng0218/dsh-plugin-lint-panel` | **0.1.5**（2026-10-21） | **0.1.6** | 0.1.6 未发布；bump 提交 `49b21b4` 已在 main，registry 无 0.1.6 |

### 8.2 panel 0.1.6：bump 已进 main，发布失败

时间线（均可从 git / registry 复核）：

1. 2026-10-21，`publish-panel` 把 panel 版本 bump 到 0.1.6，由 github-actions[bot] 提交 `49b21b4`（`chore(panel): publish @shidesheng0218/dsh-plugin-lint-panel@0.1.6`）并推回 main。
2. 随后的 `npm publish` 失败，registry 没有 0.1.6（最新仍是 0.1.5）。
3. 同日晚些的 `d753034` 给两个 publish workflow 加了"先校验 token 再 bump"，提交信息明确记录这次失败：*"A missing or placeholder NPM_TOKEN failed at the publish step, after the bump commit had already been pushed — leaving an unpublished version on main."*
4. 结果：仓库的 panel 版本（0.1.6）比 registry（0.1.5）**领先一个未发布版本**，需要人工对账——要么发布 0.1.6，要么回滚/re-bump，不能默认它已经上线。

### 8.3 自动发布的真实状态

- 两个 publish workflow 在 main 上的最近一次运行（2026-10-26）以**失败**结束（GitHub Actions 运行记录）；仓库里没有一次"推送后自动发布成功"的记录。
- 因此**不能承诺自动发布可靠**：合入 main 不等于上线，发布后必须用 `npm view <pkg> version` 对账。
- 目前没有"版本已在 main 却不在 registry"的自动检测/告警，也没有失败后的自动回滚。

### 8.4 lint 0.3.0

- 工作区是 0.3.0，**从未发布**；registry 只有 0.1.0。
- 0.3.0 新增的 `dsh-plugin-analyze` / `dsh-plugin-upgrade-plan` 两个 bin 与三个分析模块只存在于源码，不能通过 `npx` 获得（见 [docs/19](19-analysis-tools.md)、[docs/20](20-release-0.3.0.md)）。

### 8.5 对账命令

```bash
npm view @shidesheng0218/dsh-plugin-lint version
npm view @shidesheng0218/dsh-plugin-lint-panel version
git show main:package.json | grep '"version"'
git show main:panel/package.json | grep '"version"'
git log --oneline -5 -- panel/package.json
```

## 9. 当前测试与发布门禁

- `npm test`（`node --test test/*.test.js`）是本地门禁；用例数以实际运行输出为准，不在本文写死。
- 两个 publish workflow 在发布前也会跑 `npm test`，所以测试不绿时发布 job 会失败（这是设计意图）。
- `npm run e2e:official` 需要先从 npm 抓官方包，依赖网络；发布前是否作为门禁由维护者决定。
- 根目录的一次性交接文档已在 commit `953688f` 删除，本文不再引用它们。

## 10. 2026-11-06 发布治理变更

- 两个 publish workflow **不再自动 bump patch**。当前版本已在 registry 时，job 输出 `publish=false` 并正常结束；发布必须来自一次经过评审的版本号变更，而不是合并的副作用。
- 发布前门禁：`npm test` + 官方 80 包零误报基线（`--expect 80`）+ 打包安装冒烟；panel 额外做 `npm pack` → 临时 prefix 安装 → `import()` 冒烟。lint 还要求 `PROBE_VERSION` 与 `package.json` 版本一致，否则拒绝发布。
- 两个 workflow 只在 `refs/heads/main` 上运行；`workflow_dispatch` 不再能从功能分支发布。
- 尚未对账：lint `0.3.0` 与 panel `0.1.6` 仍高于 registry（0.1.0 / 0.1.5）。本次变更不会发布它们；版本号需要按 0.4.0 / 0.2.0 的计划先对齐，再走一次显式发布。

## 11. 0.4.0 / panel 0.2.0 发布记录（2026-11-13）

| 包 | registry | 仓库 |
| --- | --- | --- |
| `@shidesheng0218/dsh-plugin-lint` | **0.4.0** | **0.4.0** |
| `@shidesheng0218/dsh-plugin-lint-panel` | **0.2.0** | **0.2.0** |

- 通过终端 `npm login --auth-type=web` + 2FA 批准发布；`NPM_TOKEN` 仍未配置，两个 publish workflow 仍会在 token 检查处失败关闭（版本已在 registry 时 job 空转）。
- 发布前门禁全部通过：430 个用例、覆盖率行 95.3% / 分支 86.2% / 函数 96.1%、官方 80 包零误报基线、package smoke。
- 发布后从 registry 重新安装两个包做冒烟：CLI `0.4.0`、十个核心导出、`./experimental`、manifest schema、panel `apply`、aggregate-only 与 panel 自检 0 发现，全部通过。
- 200-cell Docker 矩阵验收、新的浏览器截图验收与 `matrix/public/` 仍未完成，见 [docs/21 §8](21-release-0.4.0.md)。
- 发布后按 docs/21 §9 对账，再把 release notes 从 draft 改为已发布。
