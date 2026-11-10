# 21 · v0.4.0 release notes（draft，发布候选）

> **状态：draft / release candidate。** 仓库版本是 lint `0.4.0`、panel `0.2.0`，两者**都未发布**。npm 上 `@shidesheng0218/dsh-plugin-lint` 最新仍是 `0.1.0`（2026-10-14），`@shidesheng0218/dsh-plugin-lint-panel` 最新仍是 `0.1.5`（2026-10-21）。本文件在 registry 对账完成前保持 draft；对账状态见 [docs/17](17-release.md)。

0.3.x 版本线被跳过：v0.3 的分析能力与 v0.4 的矩阵/面板重写一起进入 0.4.0。`docs/20-release-0.3.0.md` 保留为历史草稿，不再是发布记录。

## 1. 版本与兼容性

| 包 | 本仓库 | registry | 发布类型 |
| --- | --- | --- | --- |
| `@shidesheng0218/dsh-plugin-lint` | `0.4.0` | `0.1.0` | minor；lint JSON `schemaVersion: 1`、既有 CLI 参数与退出码不变 |
| `@shidesheng0218/dsh-plugin-lint-panel` | `0.2.0` | `0.1.5` | **major**；payload v2，面板运行时同步与动作路由的行为变化 |

核心入口保留十个稳定导出：`lintPackage`、`loadPackage`、`filesCover`、`maskSource`、`RULES`、`EVENT_TYPES`、`DOC`、`formatText`、`toSarif`、`toBadge`。实验分析 API 通过包内 `./experimental` 子路径提供，不在根入口。

## 2. lint 引擎

- 11 条规则及其分级不变；E1–E5 的判定对齐宿主与 npm 的真实语义：
  - E1 只读取 `append` 的第一个字面量实参，覆盖 `session` / `ctx.session` / `agent.session` / `this.session`；注释、字符串文本和变量实参不再被误读。事件目录用当前桌面宿主重新采集（380 类型），官方包新增事件不再被报 error。
  - E2 接受宿主 loader 会归一化的 `<package>/client`；patch 行只在本包命名空间内被视为合法 id。
  - E3 按 `exports["."]` 优先解析宿主入口；被遮蔽的失效 `main` 降为 info。
  - E4 只接受 string 或 `{ default }` 的 `./client` export，与浏览器侧解析器一致。
  - E5 对齐 npm-packlist：`files` 存在时禁用根 ignore 文件，`.gitignore` 作为回退，子目录 ignore 仍然生效。
- 报告仍携带 `limits`；SARIF/badge/text 输出与退出码契约不变。

## 3. 探针

- Docker 是默认后端，失败即关闭；`--unsafe-host` 是显式逃生口，结果保持 self-reported。
- 镜像内的 `pnpm` shim 让 `dsh plugin add` 可用；`/tmp` noexec 下的 native-addon 缓存已禁用。
- web 组合在 ready 行出现时立即停止容器，使用完整超时而不是 15 秒上限。
- 同一 DSH 版本的 harness 安装在所有 cell 之间共享，安装去重；冷启动安装超时单独放宽。
- 桌面 DSH + Docker 的组合在启动前给出明确错误，不再静默失败。

## 4. 矩阵 v2

- cell/index/manifest 使用 schema v2：cacheKey、artifact integrity、resolved/loaded 版本、trust 阶梯、verification provenance。
- export 使用 staging + 逐文件 hash + index/aggregate 重建校验 + 原子替换；sync 重新下载并逐字节校验。
- legacy v1 cell 只读迁移为 `legacy-unpinned`，不能产生 verified 或升级推荐。
- 本地目录 artifact 的 manifest inputs 不再携带 `undefined`，跑批可以写出 `run-manifest.json`。

## 5. panel 0.2.0

- host 拆分为 profile/matrix/payload/update/actions/routes，payload v2 带 health bucket、conflict 分区和 upgrade preview。
- 动作路由要求 JSON、显式 action header、`confirmed: true`、合法包名、已安装版本与 profile 锁；panel 自身与第一方 bundle 受保护。
- Origin 检查与转发的 `Host` 比较，`dsh web` 下的动作不再返回 403。
- npm 包只包含 `data/aggregate.json`；逐插件行需要本地快照或显式发布的 `matrix/public/`。

## 6. 发布治理

- 两个 publish workflow 只在 `main` 上运行，只在版本号是新的时发布；**不再自动 bump patch**。
- lint 发布前跑单测、官方 80 包零误报基线、打包安装冒烟和 `PROBE_VERSION` 一致性检查；panel 发布前跑单测与打包 import 冒烟。
- 点名数据的自动提交与 artifact 上传需要显式 `publish_named_data=true`；`matrix/public/` 默认被 gitignore。

## 7. 验证结果（2026-11-10，发布候选）

| 检查 | 结果 |
| --- | --- |
| `npm test` | 381 通过 / 0 失败 |
| `npm run test:coverage` | 行 91.1% / 分支 82.2% / 函数 91.2%（门槛 85/80/80） |
| 官方 80 包零误报基线 | 0 error · 0 warn，PASS |
| 自检 `panel` + `test/probe-plugins` | 0 error / 0 warn |
| `node scripts/package-smoke.mjs` | 根包与 panel 真实 tarball 安装、全部 bin `--help`、核心/实验导出、panel import 均通过 |
| 真实 Docker 探针 | headless `active`（28 s）、web `active`（27 s，ready） |

## 8. 已知边界与发布阻塞

1. **registry 尚未发布 0.4.0 / 0.2.0。** NPM_TOKEN 未配置；`publish-lint` / `publish-panel` 在 token 检查处失败关闭。
2. **200-cell Docker 矩阵验收未执行。** 计划 Task 12 要求新的 v2 语料（50 × 2 × 2）与 manifest/index/aggregate 校验；本次只做了单 cell 的真实 Docker 探针。没有这次验收，不把矩阵数据标记为“已验证”。
3. **没有新的浏览器截图验收。** `scripts/screenshot-panel.mjs` 仍是旧快照；发布前应在一次性 web profile 里重新截图并核对 aggregate/冲突/更新区域。
4. **`matrix/public/` 未发布。** panel 的运行时同步源仍返回 404；npm 安装只显示聚合计数，这是数据政策的默认结果，不是故障。
5. **同源插件信任模型未变。** panel 的 action header / `confirmed` 对同源插件 JS 可伪造；真正的边界需要宿主级权限或产品决策。
6. **已知 P1 未清**：矩阵 cacheKey 未纳入 tools/isolation；error cell 仍会阻断导出链；报告的 SARIF URI 仍是绝对路径。

## 9. 发布清单（人工）

```bash
# 1. 确认版本与 registry
npm view @shidesheng0218/dsh-plugin-lint version
npm view @shidesheng0218/dsh-plugin-lint-panel version

# 2. 全部门禁（与 CI 相同）
npm test
npm run test:coverage
node scripts/fetch-official-from-npm.mjs --limit 80
node scripts/e2e-official.mjs --expect 80
node bin/dsh-plugin-lint.mjs panel test/probe-plugins --no-color --exit-code
node scripts/package-smoke.mjs

# 3. 真实 Docker 探针（可选但推荐）
node scripts/probe-boot.mjs test/probe-plugins/tool-alpha --dsh 0.2.0-rc.2 --cache /tmp/dsh-probe-cache

# 4. 由仓库管理员配置 NPM_TOKEN（Automation token），合并版本提交后观察 publish workflow

# 5. 发布后对账并做 registry 安装冒烟
npm view @shidesheng0218/dsh-plugin-lint@0.4.0 version dist.integrity dist.tarball
npm view @shidesheng0218/dsh-plugin-lint-panel@0.2.0 version dist.integrity dist.tarball
```

只有 registry 返回确切版本、workflow 成功且从 registry 再安装冒烟通过后，才把本文件从 draft 改为已发布，并更新 [docs/17](17-release.md) 的对账表。