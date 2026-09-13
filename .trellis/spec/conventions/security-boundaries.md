# 安全边界

这个项目本身只读本机文件、不联网、不上报。但它有三类真实的攻击面，都已经在代码里处理过 —— 改动时别把防护拆了。

---

## 不可信输入清单

| 输入 | 来源 | 能造成什么 | 现有防护 |
|---|---|---|---|
| `session_id` | Claude Code 从 stdin 传来的 JSON | 拼进文件路径 → `../` 穿越；删任意文件 | 清洗成 `[A-Za-z0-9_-]`，截断 128 |
| `cwd` / 目录名 | 用户的项目路径 | 塞进终端转义序列 / AppleScript 字符串 → 注入 | macOS 标题只用清洗后的 sessionId，不用目录名（`emit-status.mjs:286`） |
| `~/.claude/settings.json` | 用户手写 | 解析失败时覆盖 → 毁掉用户配置 | parse-guard，见 [error-handling.md](./error-handling.md) L3 |
| `tools/phone` 的 HTTP 请求体 | 同网段任意设备 | 路径穿越、ANSI 注入终端、越权操控 PC | 白名单正则 + `safeLine()` + 令牌 |
| transcript `*.jsonl` 内容 | 会话正文（可含用户粘贴的任意文本） | 把正文里的类似字样误当成真 agent id | 锁死 id 格式为 `[0-9a-f]{16,}` |

---

## 规则 1：进文件路径的 id 必须清洗，两侧规则逐字一致

三处实现，改一处必须同改另外两处：

```js
// hooks/emit-status.mjs:215
const sessionId = (String(rawId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128)) || 'unknown';
```
```rust
// app/src-tauri/src/lib.rs:465  注释明确写了「与 hook 端规则一致」
fn sanitize_id(s: &str) -> String { /* 非 [A-Za-z0-9_-] → '_'，take(128)，空则 "unknown" */ }
```
```js
// tools/phone/server.mjs:146  网络来源，改用白名单拒绝而非替换
if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(sessionId || ''))) return null;
```

清洗后的值**同时作为 `record.session_id` 落盘**（`emit-status.mjs:213` 有注释：身份唯一，聚焦时按它回查文件，两边必须一致）。不要"落盘用原值、路径用清洗值"，那会让聚焦/删除找不到文件。

> 当前 `lib.rs` 里 `remove_session` 走了 `sanitize_id`，`focus_session` 没走 —— 已记在 [../code-smells.md](../code-smells.md)，新代码一律清洗。

## 规则 2：拼进脚本/转义序列的内容必须先收窄字符集

- AppleScript：只塞已清洗的 `sessionId`（`emit-status.mjs:61` 有注释"塞进 AppleScript 字符串安全"）。
- macOS 聚焦标记用纳秒时间戳，字符集限定 `[A-Za-z0-9_]`（`lib.rs:407 focus_marker`，注释写明"塞进 AppleScript/OSC 都安全"）。
- 写 tty 前校验路径前缀，防呆：

  ```rust
  // app/src-tauri/src/lib.rs:419  只认 /dev/tty* 路径，防止误写到别的文件
  if !tty.starts_with("/dev/tty") { return; }
  ```
  同样的校验在 `emit-status.mjs:118` 的 `captureTtyMac` 里也有一份。
- PowerShell 只传已校验过的整数，**不拼任何字符串进命令行**（`tools/phone/server.mjs:156`）。

## 规则 3：打印外来内容前必须洗掉控制字符

局域网上任何人都能 POST 进 `/api/log`，裸打印意味着别人能往你终端注入 ANSI 转义（清屏、移光标、伪造输出）：

```js
// tools/phone/server.mjs:442
function safeLine(s) {
  return String(s == null ? '' : s).replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, '.');
}
```

`/api/log` 与 `/api/focus` 的日志行全部过 `safeLine`。**新增任何把外来内容打进终端的代码，必须过 `safeLine`。**

## 规则 4：静态文件服务必须做目录穿越防护

```js
// tools/phone/server.mjs:512
const full = normalize(join(UI_DIR, urlPath));
if (!full.startsWith(normalize(UI_DIR) + sep)) { res.writeHead(403).end('forbidden'); return; }
```

注意末尾的 `+ sep` —— 少了它，`/ui-evil` 能绕过 `/ui` 的前缀检查。

## 规则 5：读接口可以不鉴权，写接口必须要令牌

`tools/phone` 的安全模型（`server.mjs:12-17` 写得很清楚，别想当然）：

- 绑 `0.0.0.0`，**同网段任何设备都能读**项目名 / git 分支 / prompt 片段 → 只在可信局域网跑。
- `POST /api/focus` 是唯一会"动手"的接口（把 PC 上的窗口提到前台），单独要令牌。
- 令牌：`randomBytes(9).toString('base64url')`，存 `token.txt` 复用，**已在 `.gitignore`**（`.gitignore` 里那段注释解释了为什么：public 仓库 + git 历史永久）。
- 请求体必须限长并明确回 413，且**不要用 `req.destroy()`**（`server.mjs:418`：那样 `'end'` 不再触发，客户端拿不到任何响应，只能干等超时）。当前限额：`/api/focus` 4KB、`/api/log` 64KB。
- 令牌缺失时要**明确告知**而不是静默失败（`server.mjs:324` toast「操控未启用：书签里要带 ?t=令牌」）。

## 规则 6：WebView CSP 与 Tauri 权限按需最小化

`app/src-tauri/tauri.conf.json` 的 CSP 已收紧，改前端时不要为了方便放宽：

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost; font-src 'self'
```

`style-src` 的 `'unsafe-inline'` 是必需的（`main.js` 用 `style.left = ...` 定位右键菜单、`style="width:N%"` 画刻度条）；`script-src` **不得**加 `'unsafe-inline'`。

`app/src-tauri/capabilities/default.json` 只列出实际用到的 12 项权限，`windows` 显式限定 `["dock", "popover"]`。加权限前先确认 UI 真的调用了它。

## 规则 7：落盘内容里什么可以有、什么不可以

状态文件里**刻意保留**了最近一条 prompt 的前 120 字（`status-logic.mjs:31 clip()`）作卡片摘要，README `## 隐私说明` 对此有明确交代。新增字段时：

- 不要落盘 transcript 正文、token 明细、文件内容。
- 新增任何可能含敏感内容的字段 → 同步更新 README `## 隐私说明`。
- 探针模式（`statusline-bridge.mjs:51` 的 `CCMON_CAPTURE`）会存**完整载荷**，必须保持"默认关闭、需显式设环境变量"。
