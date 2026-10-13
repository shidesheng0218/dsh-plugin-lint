# 18 · 方向 B：构成冲突检查

工具：[conflicts.mjs](../scripts/matrix/conflicts.mjs) · 受控夹具：[test/probe-plugins/tool-alpha](../test/probe-plugins/tool-alpha)、[tool-beta](../test/probe-plugins/tool-beta)

## 1. 为什么单插件探针发现不了这类问题

前面 228 格全都是"一个插件装进一个干净 profile"。**一个插件单独能跑，不代表它和别的插件能共存。** 冲突只在插件相遇时出现，所以需要第二种探针：一次装多个。

## 2. 静态扫描：先从已有数据里找候选

矩阵格子里已经记录了每个插件注册的工具名，所以第一遍不需要新探针——把工具名按归属分组即可：

```text
cells read: 228
plugins that register tools: 16
distinct tool names: 118
names claimed by more than one plugin: 0
```

**抽样范围内零冲突。** 这是个诚实的结果，也说明这类问题不常见——但"不常见"和"不会发生"是两回事，而且一旦发生后果很重（见下）。

## 3. 受控实验：撞名时宿主持什么态度

既然样本里没有，就造一个。两个夹具插件都注册同一个工具名 collide_probe：

| 阶段 | 结果 |
| --- | --- |
| 各自单独探测 | 都 active，各 +1 个工具 |
| **一起装进同一个 profile** | **inactive-error —— 后注册的那个插件整个没挂载上** |

宿主给出的原文：

```text
tool-beta: Error: tool "collide_probe" is already registered
  (for a per-agent variant, register through that agent ctx instead)
```

**结论：撞名不是"后者覆盖前者"，而是后者整个插件报废。** 而且——这一点最关键——按 [10](10-m4-verification.md) 的发现，挂载失败只是 warning、进程照常退出 0。也就是说：

> 用户装了两个撞名的插件，其中一个**完全没生效**，而宿主不会因此报错退出。用户唯一能察觉的线索是启动日志里的一行 warning。

这正是这套检查存在的意义。

## 4. 与规则/矩阵的分工

| 工具 | 回答的问题 |
| --- | --- |
| linter | 这个包自己写得对不对 |
| 单插件探针 | 这个插件在这个 DSH 版本上能不能挂载、给了模型什么 |
| **组合探针（本文）** | **这几个插件装在一起会不会互相顶掉** |

## 5. 怎么用

```bash
# 从已有矩阵格子做静态扫描
node scripts/matrix/conflicts.mjs

# 受控验证一对插件（会先各自单跑，再一起跑，给出"单独 vs 一起"的对比）
node scripts/matrix/conflicts.mjs --plugins a,b

# 对静态扫描出的候选逐个验证（默认取前 3 组）
node scripts/matrix/conflicts.mjs --verify --limit 3
```

输出写在 matrix/index/conflicts.json（含包名，**不进仓库**，遵循 [README 的 Data policy](../README.md#data-policy)）。

## 6. 范围与限制（明确没做的部分）

| 项 | 状态 |
| --- | --- |
| 工具名冲突 | ✅ 静态扫描 + 运行时验证 |
| HTTP 路由路径冲突 | ❌ 未比较（需要从运行时采集路由表） |
| 客户端 slot id 冲突 | ❌ 未比较（需要浏览器侧数据） |
| loader 行 id / 配置行冲突 | ❌ 未比较（可在组合启动时从 stderr 观察） |
| 提示词重复注入（两个插件注入同一段上下文） | ❌ 未检测 |
| 冲突的"谁该赢"建议 | ❌ 不做 —— 工具只陈述宿主实际行为，不给处置建议 |

最后一行是刻意的：**工具报告事实，不替用户做取舍。**
