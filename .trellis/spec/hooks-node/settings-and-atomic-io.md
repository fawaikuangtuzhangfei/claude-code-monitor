# 落盘与改写用户配置

---

## 原子写（所有落盘一律如此）

看板每秒读一次目录，非原子写必然会被读到写一半的 JSON。

```js
// hooks/emit-status.mjs:330
// 原子写：先写临时文件再 rename，避免看板读到写一半的 JSON
const tmpFile = `${outFile}.${process.pid}.tmp`;
writeFileSync(tmpFile, JSON.stringify(record, null, 2), 'utf8');
renameSync(tmpFile, outFile);
```

三要素，缺一不可：

1. 临时文件名**带 `process.pid`** —— 多个 hook 进程可能同时写（`statusline-bridge.mjs:46` 也是这个模式）。
2. `rename` 而不是 `copy`（同文件系统内是原子的）。
3. `JSON.stringify(x, null, 2)` —— 落盘 JSON 一律缩进 2 空格，便于人工排查。

读方要容忍写方还没写完/文件坏掉：所有读取都包 `try/catch`，坏了当没有（`emit-status.mjs:232`、`lib.rs:27-32`、`server.mjs:83`）。

### 删除即消失

`session-end` 不写"已关闭"状态，直接删文件（`status-logic.mjs:54` 返回 `{ action: 'delete' }`），看板下一秒自然少一张卡。删除用 `rmSync(path, { force: true })` 包在 `try/catch` 里 —— 文件不存在也算成功。

---

## 改写 `~/.claude/settings.json`

这是全项目**唯一会修改用户文件**的地方，两份实现必须行为一致：

- `install/install-hooks.mjs`（命令行路径）
- `app/src-tauri/src/install.rs`（看板内一键安装路径，`install_hooks` 命令）

### 五步流程（顺序不能变）

```
1. 读 → 解析失败则另存 settings.json.unparsable-<ts> 并中止，一个字节都不写
2. 解析成功 → 备份成 settings.json.bak-monitor（备份的必须是好文件）
3. 合并 hooks：对 MAP 里每个事件，先按 MARK 删掉我们装的旧条目，再 push 一条最新的
4. （可选）包裹 statusLine：首次包裹把原命令存进 wrapped-statusline.json
5. 写回 + 写 .installed-version
```

注意第 2 步的顺序：`install.rs:121` 把 `fs::copy` 放在 `Ok(v)` 分支里，注释写明「解析成功才备份（备份的是好文件）」。别把备份提到解析之前 —— 那会用坏文件覆盖上一次的好备份。

### 只动带自己标记的条目

```js
// install/install-hooks.mjs:70
function groupHasOurHook(group) {
  return (group.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes(MARK));
}
```

Rust 侧的等价物是 `install.rs:210 group_has_our_hook`。**用户自己的其它钩子必须原样保留**，`filter` / `retain` 只剔除含 `MARK` 的。

### statusLine 要能无损还原

- 首次包裹：原 `statusLine` 原样存进 `~/.claude/monitor-hooks/wrapped-statusline.json`（原来没有就存 `{}`）。
- 已包裹（`command` 含 `BRIDGE_MARK`）：只刷新路径，**不覆盖已存的原命令**。
- 卸载：有原命令就替回，没有就 `delete settings.statusLine`，然后删掉 `wrapped-statusline.json`。
- 桥接本身（`statusline-bridge.mjs`）必须原样透传：读入的 stdin 原封不动喂给原命令，stdout / stderr / 退出码全部照抄（`statusline-bridge.mjs:82-84`）。**用户终端里的 statusline 视觉与行为必须完全不变。**

转调原命令的两条分支（`statusline-bridge.mjs:69-80`）也别合并：单 token 命令直接当可执行文件 spawn（避开 shell 引号/斜杠坑，Windows 下补 `.exe`），含空格的复杂命令才回退 `shell: true`。

### Rust 侧的额外要求

`Cargo.toml` 里 `serde_json` 开了 `preserve_order` feature，注释说明了原因：

```toml
# preserve_order：改写 settings.json 时保留用户原有键顺序，不按字母重排（Value 底层用 IndexMap）
serde_json = { version = "1", features = ["preserve_order"] }
```

**不要关掉这个 feature** —— 否则用户每次一键安装，自己的 `settings.json` 就被按字母重排一遍，git diff 里全是噪音。

写回用 `serde_json::to_string_pretty`（与 Node 侧的 `null, 2` 对齐）。

### 两份实现的同步清单

改任何一项，两边都要改：

| 项 | Node | Rust |
|---|---|---|
| 事件表 `MAP` | `install-hooks.mjs:41` | `install.rs:32` |
| `MARK` | `install-hooks.mjs:53` | `install.rs:27` |
| `BRIDGE_MARK` | `install-hooks.mjs:32` | `install.rs:28` |
| hook 命令格式 `node "<path>" <arg>` | `install-hooks.mjs:36` | `install.rs:151` |
| 要复制/落盘的脚本清单 | `install-hooks.mjs:19-28`（`copyFileSync`） | `install.rs:22-25`（`include_str!`）+ `:109-112`（`fs::write`） |
| 备份 / parse-guard 行为 | `install-hooks.mjs:57` | `install.rs:117` |
| statusLine 包裹/还原 | `install-hooks.mjs:79/95` | `install.rs:161-195`（只有包裹，卸载仍走 Node） |

> 这是一处**刻意的重复实现**（理由见 `install.rs:1-15`：macOS GUI App 的 PATH 带不到 nvm 的 node，所以不能 shell out 调 Node 脚本）。重复本身是对的，但必须当成"一个契约两处实现"来维护 —— 上面这张表就是契约。
