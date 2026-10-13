# 04 · DSH 插件开发速查（技术笔记）

来源：DSH 安装包自带官方文档 `skills/cordis-plugin-development`（已归档至 `reference/official-skill/`）+ 本机安装包实测。
**铁律：本机安装的 DSH 才是权威。** 写代码前先用 `cordis_inspect_query` 确认 Service / Event / Slot / Theme。

## 1. 插件有四种形态

| 形态 | 组成 | 适用 |
| --- | --- | --- |
| Host 插件 | `index.js` 导出 `apply(ctx, config)` 或 Service class | 工具、事件、提示词、服务 |
| Bundle | `package.json` 里 `dsh.bundle.patch` 指向 `cordis.patch.yml` | 分发单元（可含多行插件） |
| Client（UI）插件 | bundle + `dsh.client` 段 + `./client` 导出 | Web 界面里的页面/面板/装饰 |
| MCP bundle | 仅 manifest + patch，插入 `@deepseek-ai/dsh-mcp-client` | 接 MCP server |

一个带 UI 的插件 = bundle 清单 + patch + host 入口 + client 入口，共 4 个文件起步。

## 2. 最小清单

```json
{
  "name": "@you/my-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js", "./client": "./client.js", "./package.json": "./package.json" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true, "inject": [] },
    "compatibility": { "dshReleases": { "0.2.0-rc.2": "compatible" } }
  },
  "icon": "./icon.svg"
}
```

```yaml
# cordis.patch.yml
- insert:
    - id: my-plugin
      name: '@you/my-plugin'
      config: {}
```

展示元数据在**不激活插件**时就被管理页读取——是插件门面，别省。实测校正（2026-10-13，对照 `dsh-context@0.69.1`）：

- **标题与描述放在 `locale/<lang>.json` 的 `meta` 字段**，不是 package.json：
  ```json
  // locale/en.json
  { "meta": { "title": "Context (dsh-context)", "description": "Context insights and management…" } }
  ```
- **图标是 package.json 顶层 `icon`**（相对路径，SVG/PNG/JPEG/WebP ≤256KiB）。
- 缺这些字段不会报错，只会回退成包名与描述、默认图。

## 3. 安装与生效

- 安装走官方 `plugin_manager` 的 `install_bundle`（`target` 传包目录绝对路径）；**不要**手写 profile 的 `package.json` / `cordis.patch.yml`，**不要**在 profile 目录跑 pnpm。
- 生效与否看返回的 `application` 与 `warnings`：`applied` 才算生效；`failed` 要诊断、`overridden` 说明被更高优先级层覆盖、`restart-required` 说明还没生效。
- 新 bundle 可通过 HMR 直接激活；**替换已安装包需要重启**才能加载新的 JS 模块代。
- 每个 `plugin_manager` 动作在没有 Full access 时都需要审批。
- 不带 profile 启动时 `DSH_PROFILE` / `DSH_PROFILE_DIR` 为空；带 profile 时可用 `dsh --profile "$DSH_PROFILE" --dump-config` 打印合成后的配置。

本机事实（2026-10-13）：
- DSH：`@deepseek-ai/dsh` 0.2.0-rc.2；profile `desktop`（`~/.dsh/profiles/desktop`）
- 已装第三方插件：`ds-bot@0.1.3`、`dsh-context@0.69.1`
- 安装包在 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`（**asar 只有宿主进程自己能读**；shell / ripgrep / node / pnpm 都打不开，需要副本才能分析）

## 4. 必须遵守的实现规则（摘自官方 practices）

1. **会话日志是唯一真相**：模型看得到的一切必须能从已提交的 session event 重建；插件内存只是缓存。
2. **注册即副作用，属于某个 context**：卸载/热更新/slot 折叠会移除对应 context 上的注册。注册到 `agent.ctx` 的，**自己也要持有 disposer**。
3. **框架驱动、插件计算**：不要自己订阅 + 全量重扫 + 写 DOM。
4. **用最弱的扩展点**：`ctx.tools.restrict()`（只能减工具） < `ctx.tools.guard()`（只能拒） < waterfall 监听器（可改写、依赖顺序） < `system-prompt/assemble`（替换整个装配）。越强，越要负责保留别人的贡献。
5. **兼容未知数据**：别的插件和更老的 DSH 会读你写的东西。
6. **插件 UI 就是宿主 UI**：用主题 token（`--dsw-alias-*`）、跟随 locale、模仿宿主组件；**不要** import 官方 Client 包；**不要** iframe 内嵌 Host 页面；**不要**写宿主 DOM。

性能：每会话状态用 `ctx.sessionProjections`（`apply(state,event)` 纯函数、忽略的事件返回同引用、`view()` 不变则不发布、改语义要 bump `stateVersion`）；等 `turn/end`/`assistant/message`/`tool/result` 这类持久事件，实时 token 用 `agent/assistant-stream`；定时器里做工作要 `agent.followup()` 唤醒 agent（`agent.inject()` 不会唤醒）。

## 5. 验证要求（官方 verification 参考）

- 优先用**已连接的真实页面**验证；不要为了截图去装浏览器渲染器、模拟 React、抽取 SVG 做预览。
- 视觉类改动若无浏览器控制能力：只做 JS 语法 + 清单校验 + 槽位注册验证，并**明确声明视觉未验证**。
- 测试用独立目录、限时、用完清理。
- 验证用的临时设置要还原。

## 6. 参考资料位置

- 官方文档：`reference/official-skill/`（SKILL.md + 6 篇 references + templates 说明）
- 官方源码：本机 asar 内 `.../dsh/node_modules/@deepseek-ai/*/lib/index.js` 与 `lib/types/**/*.d.ts`（含 JSDoc）；GitHub 上是 `packages/<group>/<name>/src`
- 生态目录数据：`dsh-plugin-catalog`（`plugins.json`，含 capability 标注）
