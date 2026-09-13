# Bootstrap Task: Fill Project Development Guidelines

**You (the AI) are running this task. The developer does not read this file.**

The developer just ran `trellis init` on this project for the first time.
`.trellis/` now exists with empty spec scaffolding, and this bootstrap task
exists under `.trellis/tasks/`. When they want to work on it, they should start
this task from a session that provides Trellis session identity.

**Your job**: help them populate `.trellis/spec/` with the team's real
coding conventions. Every future AI session — this project's
`trellis-implement` and `trellis-check` sub-agents — auto-loads spec files
listed in per-task jsonl manifests. Empty spec = sub-agents write generic
code. Real spec = sub-agents match the team's actual patterns.

Don't dump instructions. Open with a short greeting, figure out if the repo
has any existing convention docs (CLAUDE.md, .cursorrules, etc.), and drive
the rest conversationally.

---

## Status

- [x] 按真实技术栈重建 spec 目录（2026-09-13，基准 commit `d5756d3`）
- [x] 每份规范都带真实 `文件:行号` 引用，无占位文本
- [x] 额外产出现存坏味道清单 `.trellis/spec/code-smells.md`（只列不改）

**`trellis init` 原本给的 `.trellis/spec/frontend/` 已删除** —— 那 6 个模板是 React 取向
（component / hook / state-management / type-safety），与本项目技术栈完全不符：
`app/ui` 是原生 JS 单文件无框架无构建，另有 Rust / Node ESM / PowerShell 三层。

`.trellis/spec/guides/` 的两份思维指南也已重写 —— 原版里的例子全是 Trellis CLI 自己仓库的
（`packages/cli/src/templates/trellis/`、`rsync` 同步指令、TypeScript / Python），放在这个仓库里会误导 agent。

---

## 实际产出的 spec 结构

| 目录 | 对应真实分层 | 文件数 |
|------|------|------|
| `.trellis/spec/index.md` | 总索引：技术栈地图 + 「改哪层读哪份」+ 十条硬规 | 1 |
| `.trellis/spec/conventions/` | 全层通用：注释即决策记录 / 分级静默降级 / 跨平台 / 安全边界 / 版本联动 | 6 |
| `.trellis/spec/hooks-node/` | `hooks/` + `install/`（Node ESM，零依赖） | 4 |
| `.trellis/spec/tauri-rust/` | `app/src-tauri/`（Rust + Tauri v2） | 3 |
| `.trellis/spec/ui-vanilla/` | `app/ui/`（原生 JS + 原生 CSS） | 3 |
| `.trellis/spec/scripts-and-tools/` | PowerShell 脚本 + `tools/phone` 实验 | 3 |
| `.trellis/spec/guides/` | 跨层 / 复用思维指南（已按本仓库重写） | 3 |
| `.trellis/spec/code-smells.md` | 现存问题清单（A 文档失真 / B 一致性 / C 潜在缺陷 / D 死代码 / E 结构） | 1 |

最关键的一份是 `.trellis/spec/hooks-node/status-contract.md` —— `~/.claude/monitor/<id>.json`
是本项目唯一的跨进程契约，有 4 个实现同时读写它，那份文档列了改字段/加事件的完整联动清单。

---

## How to fill the spec

### Step 1: Import from existing convention files first (preferred)

Search the repo for existing convention docs. If any exist, read them and
extract the relevant rules into the matching `.trellis/spec/` files —
usually much faster than documenting from scratch.

| File / Directory | Tool |
|------|------|
| `CLAUDE.md` / `CLAUDE.local.md` | Claude Code |
| `AGENTS.md` | Codex / Claude Code / agent-compatible tools |
| `.cursorrules` | Cursor |
| `.cursor/rules/*.mdc` | Cursor (rules directory) |
| `.windsurfrules` | Windsurf |
| `.clinerules` | Cline |
| `.roomodes` | Roo Code |
| `.github/copilot-instructions.md` | GitHub Copilot |
| `.vscode/settings.json` → `github.copilot.chat.codeGeneration.instructions` | VS Code Copilot |
| `CONVENTIONS.md` / `.aider.conf.yml` | aider |
| `CONTRIBUTING.md` | General project conventions |
| `.editorconfig` | Editor formatting rules |

### Step 2: Analyze the codebase for anything not covered by existing docs

Scan real code to discover patterns. Before writing each spec file:
- Find 2-3 real examples of each pattern in the codebase.
- Reference real file paths (not hypothetical ones).
- Document anti-patterns the team clearly avoids.

### Step 3: Document reality, not ideals

**Critical**: write what the code *actually does*, not what it should do.
Sub-agents match the spec, so aspirational patterns that don't exist in the
codebase will cause sub-agents to write code that looks out of place.

If the team has known tech debt, document the current state — improvement
is a separate conversation, not a bootstrap concern.

---

## Quick explainer of the runtime (share when they ask "why do we need spec at all")

- Every AI coding task spawns two sub-agents: `trellis-implement` (writes
  code) and `trellis-check` (verifies quality).
- Each task has `implement.jsonl` / `check.jsonl` manifests listing which
  spec files to load.
- The platform hook auto-injects those spec files + the task's `prd.md`
  into every sub-agent prompt, so the sub-agent codes/reviews per team
  conventions without anyone pasting them manually.
- Source of truth: `.trellis/spec/`. That's why filling it well now pays
  off forever.

---

## Completion

When the developer confirms the checklist items above are done with real
examples (not placeholders), guide them to run:

```bash
python ./.trellis/scripts/task.py finish
python ./.trellis/scripts/task.py archive 00-bootstrap-guidelines
```

After archive, every new developer who joins this project will get a
`00-join-<slug>` onboarding task instead of this bootstrap task.

---

## Suggested opening line

"Welcome to Trellis! Your init just set me up to help you fill the project
spec — a one-time setup so every future AI session follows the team's
conventions instead of writing generic code. Before we start, do you have
any existing convention docs (CLAUDE.md, .cursorrules, CONTRIBUTING.md,
etc.) I can pull from, or should I scan the codebase from scratch?"
