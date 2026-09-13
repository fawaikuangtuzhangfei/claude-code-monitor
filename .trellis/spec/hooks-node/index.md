# 采集端（Node ESM）规范

范围：`hooks/*.mjs`、`install/install-hooks.mjs`。这些脚本会被**复制到用户机器的 `~/.claude/monitor-hooks/`** 并由 Claude Code 在每次 hook 事件时调起。

| 文件 | 职责 | 行数 |
|---|---|---|
| `hooks/status-logic.mjs` | **纯决策核心**：hook 事件 + 上一份状态 → 这次该怎么写盘。无副作用、无 I/O | ~102 |
| `hooks/status-logic.test.mjs` | 上者的单测，30 条，`node:test` 零依赖 | ~197 |
| `hooks/emit-status.mjs` | 全部副作用：读 stdin、抓窗口/tty/pid、git 分支、原子写盘 | ~333 |
| `hooks/statusline-bridge.mjs` | 包在用户原有 statusline 外的「透传 + 截获」层 | ~87 |
| `install/install-hooks.mjs` | 命令行装/卸（幂等，自动备份 `settings.json`） | ~176 |

---

## 铁律

1. **零第三方依赖。** 只用 `node:*` 内置模块。这些文件跑在用户机器上，没有 `node_modules`。
2. **Node ≥18 语法**（README 前置要求）。用到更高版本特性必须显式检测并给出人能懂的报错 —— 范本 `tools/phone/server.mjs:34` 对 `import.meta.dirname`（20.11+）的处理。
3. **绝不阻塞用户会话。** 所有子进程调用带超时，`UserPromptSubmit` 路径上尽量不 fork（见 [pure-logic-and-tests.md](./pure-logic-and-tests.md) 的「探测节流」一节）。
4. **无需变化就不写盘。** `decide()` 返回 `skip` 时直接 `process.exit(0)`（`emit-status.mjs:247`）。
5. **落盘一律原子写。** 见 [settings-and-atomic-io.md](./settings-and-atomic-io.md)。
6. **纯逻辑必须有单测。** 新增状态转移规则 = 新增测试用例，不是可选项。

## 代码风格

- ESM `import`，`node:` 前缀必写（`import { readFileSync } from 'node:fs'`）。
- 单引号，2 空格缩进，分号结尾。
- 顶层 `await` 可用（`emit-status.mjs:211` 的 `const input = await readStdin()`）。
- 常量全大写放文件顶部（`HERE`、`EVENT`、`TAIL_BYTES`、`MAP`、`MARK`）。
- 每个函数上方一段中文注释说清职责 + 为什么这么做，见 [../conventions/comment-and-doc.md](../conventions/comment-and-doc.md)。
- 文件顶部带 `#!/usr/bin/env node`（`emit-status.mjs`、`statusline-bridge.mjs`、`install-hooks.mjs`）。

## 本层的三份规范

| 文件 | 内容 |
|---|---|
| [status-contract.md](./status-contract.md) | 状态机契约 + 状态文件字段表 + **加字段的 4 处联动清单** |
| [pure-logic-and-tests.md](./pure-logic-and-tests.md) | 纯/脏分层的边界在哪；单测怎么写；探测节流规则 |
| [settings-and-atomic-io.md](./settings-and-atomic-io.md) | 原子写；改 `settings.json` 的安全流程；Node/Rust 双实现同步 |
