# 17 · npm 发布准备

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

## 3. 包内容（已实测）

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

## 4. 发布步骤（需要你的 npm 凭据）

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

## 5. 发布前状态

| 项 | 状态 |
| --- | --- |
| 包名可用 | ✅ @shidesheng0218/dsh-plugin-lint 未被占用 |
| 版本 | 0.1.0（首次发布） |
| 包内容 | ✅ 13 个文件，含 LICENSE / NOTICE / README |
| 依赖 | ✅ 零运行时依赖 |
| 测试 | ✅ 28/28 |
| 安装冒烟 | ✅ 见上表 |
| **npm 登录** | ❌ **未登录，需要你操作** |

## 6. 实际发布（2026-10-14，已上线）

**@shidesheng0218/dsh-plugin-lint@0.1.0 已发布**，registry 验证通过：`npx -y @shidesheng0218/dsh-plugin-lint <目录>` 从 registry 拉取并正常运行，两个 bin 都在。

过程中三个值得记录的事实：

| 现象 | 真相 |
| --- | --- |
| 发布需要 OTP | 账号开了 2FA；npm 正在收紧绕过 2FA 的 token，这是平台策略 |
| 搜索 API 一度显示 `0.0.0-stage` | npm 的 staged publish 中转态，确认后变成 0.1.0，dist-tag latest 正常 |
| 日志警告 bin 条目 "invalid and removed" | **文案有误导**：因为值写了 `./bin/...` 前缀，`secureAndUnixifyPath` 归一化后**保留**了条目。已发布的包里 bin 是好的；本地 package.json 已去掉 `./` 前缀与线上一致 |

发布命令（需要 OTP 时）：

```bash
npm publish --otp=<验证器当前 6 位码>
```

## 7. 自动发布（2026-10-21 起）

两个 workflow 接管发版，触发条件是 main 上对应目录有变更：

| workflow | 触发路径 | 发布对象 |
| --- | --- | --- |
| `publish-lint.yml` | `src/` `bin/` `scripts/lib/` `scripts/probe-boot.mjs` `package.json` | `@shidesheng0218/dsh-plugin-lint` |
| `publish-panel.yml` | `panel/` | `@shidesheng0218/dsh-plugin-lint-panel` |

共同行为：

- 先跑 `npm test`，再跑 `npm whoami` 校验 token；**校验失败在 bump 之前停下**，不会留下没发布的版本号
- 当前版本已在 npm 上时自动 bump patch，把 bump 提交推回 main，并用提交标题前缀让本次 job 跳过自己
- `npm publish --provenance`（需要仓库公开 + `id-token: write`）

必需的前置条件：仓库 secret `NPM_TOKEN`，值为 npm **Automation** token（绕过 2FA）。未配置时的报错是 `ENEEDAUTH`。

矩阵数据每周刷新（`matrix-refresh.yml`）会跑 `bundle-panel-data.mjs`，把聚合数据写进 `panel/data/aggregate.json`；PR 合并后即触发 `publish-panel`，数据刷新到用户手里不需要人工介入。
