# 通用约定（全层适用）

> 这 5 份是硬规，无论改哪一层都适用。层内规范可以补充，但不能与这里冲突。

| 文件 | 管什么 | 什么时候必读 |
|---|---|---|
| [comment-and-doc.md](./comment-and-doc.md) | 注释即决策记录；文件头说明块；README 同步 | 写任何"看起来绕"的代码时 |
| [error-handling.md](./error-handling.md) | 静默降级的分级规则；哪里可以吞异常、哪里必须报 | 写 `try/catch`、`unwrap_or`、`.catch(()=>{})` 时 |
| [cross-platform.md](./cross-platform.md) | Windows / macOS 分叉；路径；子进程调用 | 碰 `process.platform`、`#[cfg(...)]`、`execFileSync` 时 |
| [security-boundaries.md](./security-boundaries.md) | 不可信输入清单与清洗规则 | 拼路径、拼脚本、打印外来内容、开网络端口时 |
| [versioning-release.md](./versioning-release.md) | 三处版本号联动；采集端与看板的版本握手 | 发版、改 hook 字段、改 hook 命令格式时 |

---

## 提交与分支

- 主分支 `main`，直接在 `main` 上迭代（单人项目），CI 在 push / PR 到 `main` 时跑。
- commit message 用中文，前缀沿用 `feat:` / `fix:` / `chore:` / `ci:` / `docs:` / `refactor:`，一句话说清用户能感知的变化。范例（`git log`）：
  - `feat: 看板自带 hooks 安装/升级，启动检测缺失或版本落后即弹窗一键补装`
  - `ci: 修复 node --test 目录扫描（显式 glob）+ 升级 action 到 node24 大版本`
  - `chore: 版本号 0.3.4 → 0.3.5`
- 版本号 bump 单独一个 `chore:` commit，不和功能混在一起。

## 提交前必跑

```bash
node --test hooks/            # 状态机单测（30 条，秒级）
cd app && pnpm tauri build    # 改了 Rust / UI 时；CI 在 Windows + macOS 上都会跑
```

`app/` 用 **pnpm**（`pnpm-lock.yaml` 入库，`package-lock.json` 被 `.gitignore` 明确排除）。

## 不该入库的东西

`.gitignore` 已覆盖，改动时别破坏这几条：

- `tools/phone/token.txt` —— 活凭证。本仓库是 public，git 历史永久，提交过就等于泄露。
- `tools/phone/main.legacy.js` —— 构建产物，和源码不同步时说不清哪个是真的。
- `app/src-tauri/gen/`、`target/`、`node_modules/`、`*.log`、`.claude/monitor/`。
