// 前端：定时向 Rust 拉会话状态，增量渲染成仪表条
// 依赖 Tauri withGlobalTauri（window.__TAURI__）

const STATUS_META = {
  waiting: { tag: "WAIT", order: 0 }, // 等你 —— 最需注意，排最前
  running: { tag: "RUN", order: 1 },
  done: { tag: "DONE", order: 2 },
  idle: { tag: "IDLE", order: 3 },
};

const cardsEl = document.getElementById("cards");
const emptyEl = document.getElementById("empty");
const readoutEl = document.getElementById("readout");
const sigEl = document.getElementById("sig");
const usageEl = document.getElementById("usage");

const rows = new Map(); // session_id -> HTMLElement
// 已通知过的状态：session_id -> status。放模块级（不挂在行元素上）——这样某会话哪怕
// 在列表里反复进出、行被反复重建，也不会把同一个「完成/等你」重复通知。
const notifiedStatus = new Map();

function invoke(cmd, args) {
  if (window.__TAURI__?.core?.invoke) return window.__TAURI__.core.invoke(cmd, args);
  return Promise.reject(new Error("not in tauri"));
}

// 这个 webview 是哪块？固定看板(dock) 与浮窗(popover) 跑的是同一份代码，用窗口 label 区分。
// 只有 dock 负责通知/提示音/托盘状态，避免两个窗口重复触发（弹两次 toast、响两声）。
function currentLabel() {
  try { return window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label || ""; }
  catch { return ""; }
}
const IS_DOCK = (currentLabel() || "dock") === "dock";

function elapsed(ms) {
  if (!ms) return "";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

function nameOf(s) {
  return s.term_title || s.project || "unknown";
}

function subOf(s) {
  switch (s.status) {
    case "running": return s.last_prompt || "运行中…";
    case "waiting": return s.message || s.last_prompt || "等待输入 / 授权";
    case "done": {
      if (s.updated_at) {
        const d = new Date(s.updated_at);
        const hh = String(d.getHours()).padStart(2, "0");
        const mm = String(d.getMinutes()).padStart(2, "0");
        return `完成于 ${hh}:${mm}`;
      }
      return "本轮完成";
    }
    default: return s.cwd ? s.cwd.replace(/\\/g, "/").split("/").slice(-2).join("/") : "空闲";
  }
}

function sideOf(s) {
  if (s.status === "running") return elapsed(s.running_since);
  if (s.status === "waiting") return elapsed(s.waiting_since);
  if (s.status === "done") return "✓";
  return "";
}

// ============================ 设置（本地持久化） ============================
const DEFAULTS = { notify: true, sound: true, autofocus: false, light: false };
let settings = loadSettings();
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("cm.settings") || "{}") }; }
  catch { return { ...DEFAULTS }; }
}
function saveSettings() {
  try { localStorage.setItem("cm.settings", JSON.stringify(settings)); } catch {}
}

// 换肤：亮/暗只切 <html data-theme>，所有颜色走 CSS token 自动重算（暗色为默认，不设属性）。
// 尽早调用，避免开窗瞬间先闪一下暗底。
function applyTheme() {
  const root = document.documentElement;
  if (settings.light) root.setAttribute("data-theme", "light");
  else root.removeAttribute("data-theme");
}
applyTheme();

// ============================ 通知：闪烁 + 提示音 + 系统 toast ============================
let primed = false; // 首帧先给每行“打底”状态，之后的变化才触发通知（避免开面板瞬间刷一屏）

const notif = window.__TAURI__?.notification;
let notifGranted = false;
async function ensureNotifyPerm() {
  if (!notif) return false;
  try {
    let granted = await notif.isPermissionGranted();
    if (!granted) granted = (await notif.requestPermission()) === "granted";
    notifGranted = granted;
    return granted;
  } catch { return false; }
}

let audioCtx = null;
function beep(kind) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const play = (freq, at, dur) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = "sine"; o.frequency.value = freq;
      o.connect(g); g.connect(audioCtx.destination);
      const t = audioCtx.currentTime + at;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.start(t); o.stop(t + dur + 0.02);
    };
    if (kind === "waiting") { play(880, 0, 0.18); play(1175, 0.16, 0.22); } // 两声上行，催促
    else { play(560, 0, 0.34); } // 完成：一声柔和
  } catch {}
}

function fireAlert(el, s, kind) {
  // 视觉：卡片描边脉冲
  const cls = kind === "waiting" ? "flash-wait" : "flash-done";
  el.classList.remove("flash-wait", "flash-done");
  void el.offsetWidth; // 重启动画
  el.classList.add(cls);
  el.addEventListener("animationend", () => el.classList.remove(cls), { once: true });

  if (settings.sound) beep(kind);

  if (settings.notify && notif && notifGranted) {
    const name = nameOf(s);
    try {
      notif.sendNotification({
        title: kind === "waiting" ? `⏸ ${name} 需要你输入` : `✓ ${name} ${subOf(s)}`,
        body: kind === "waiting" ? (s.message || s.last_prompt || "等待输入 / 授权") : "",
      });
    } catch {}
  }

  // 需输入时自动把该会话终端切到前台（可选，默认关）
  if (kind === "waiting" && settings.autofocus && (s.win_hwnd || s.window_title)) {
    invoke("focus_session", { sessionId: s.session_id }).catch(() => {});
  }
}

// 按 session_id 记录“上次已通知过的状态”，仅在真正跨状态时触发（未 primed 时静默打底）。
// 用 session_id 而非行元素做键：会话反复进出列表/行被重建也不会重复通知同一状态。
function maybeNotify(el, s) {
  const st = s.status;
  const id = s.session_id;
  const prev = notifiedStatus.get(id);
  notifiedStatus.set(id, st);
  // 首次见到该会话：静默打底，绝不通知。否则「开板/重启前就已完成」或「晚一帧才进列表」的
  // 会话会被误当成刚刚完成而误报——这才是刷屏的根因（重启一次攒一条）。只有亲眼见证它从别的
  // 状态切进来才算数。
  if (prev === undefined) return;
  if (!primed || st === prev) return;
  if (!IS_DOCK) return; // 通知/提示音只由固定看板发，浮窗不重复
  if (st === "waiting") fireAlert(el, s, "waiting");
  else if (st === "done") fireAlert(el, s, "done");
}

// ============================ 渲染 ============================
function createRow() {
  const el = document.createElement("div");
  el.className = "row";
  el.innerHTML = `
    <span class="led"></span>
    <div class="main">
      <div class="name"></div>
      <div class="metaline"><span class="tag"></span><span class="branch"></span><span class="sub"></span></div>
    </div>
    <div class="side"><span class="time"></span></div>`;
  el._refs = {
    name: el.querySelector(".name"),
    tag: el.querySelector(".tag"),
    branch: el.querySelector(".branch"),
    sub: el.querySelector(".sub"),
    time: el.querySelector(".time"),
  };
  el.addEventListener("click", async () => {
    el.classList.add("clicked");
    setTimeout(() => el.classList.remove("clicked"), 200);
    // 用行上实时挂的 _session，而非创建时捕获的旧对象
    const id = el._session?.session_id;
    if (!id) return;
    try { await invoke("focus_session", { sessionId: id }); }
    catch (e) { console.warn("focus failed:", e); }
  });
  el.addEventListener("contextmenu", (e) => openCtx(e, el));
  return el;
}

function updateRow(el, s) {
  const meta = STATUS_META[s.status] || STATUS_META.idle;
  const focusable = !!(s.win_hwnd || s.window_title);
  el.className = `row ${s.status}${focusable ? " focusable" : ""}`;
  el.title = `${s.cwd || ""}${focusable ? "  —  点击切到该终端 / 右键更多" : ""}`;
  const r = el._refs;
  const name = nameOf(s) + (s.__dupId ? ` #${s.__dupId}` : "");
  const sub = subOf(s), side = sideOf(s), branch = s.git_branch || "";
  if (r.name.textContent !== name) r.name.textContent = name;
  if (r.tag.textContent !== meta.tag) r.tag.textContent = meta.tag;
  if (r.branch.textContent !== branch) r.branch.textContent = branch;
  if (r.sub.textContent !== sub) r.sub.textContent = sub;
  if (r.time.textContent !== side) r.time.textContent = side;
}

function render(sessions) {
  sessions.forEach((s) => (s.__id = s.session_id));

  // 同名会话（term_title / 项目名相同）加个短 session id 后缀，避免多开时分不清谁是谁
  const nameCount = {};
  sessions.forEach((s) => { const n = nameOf(s); nameCount[n] = (nameCount[n] || 0) + 1; });
  sessions.forEach((s) => { s.__dupId = nameCount[nameOf(s)] > 1 ? String(s.session_id).slice(0, 4) : ""; });

  sessions.sort((a, b) => {
    const oa = STATUS_META[a.status]?.order ?? 9;
    const ob = STATUS_META[b.status]?.order ?? 9;
    if (oa !== ob) return oa - ob;
    return (b.updated_at || 0) - (a.updated_at || 0);
  });

  updateHeader(sessions);
  emptyEl.classList.toggle("hidden", sessions.length > 0);

  const seen = new Set();
  const desired = [];
  sessions.forEach((s) => {
    seen.add(s.__id);
    let el = rows.get(s.__id);
    if (!el) {
      el = createRow();
      rows.set(s.__id, el);
    }
    el._session = s;
    updateRow(el, s);
    maybeNotify(el, s);
    desired.push(el);
  });

  // 只在位置不对时才移动节点 —— 静止时零 DOM 改动，不会重排/闪屏
  desired.forEach((el, i) => {
    if (cardsEl.children[i] !== el) cardsEl.insertBefore(el, cardsEl.children[i] || null);
  });

  // 移除消失的会话
  for (const [id, el] of rows) {
    if (!seen.has(id)) {
      rows.delete(id);
      el.remove();
      if (ctxTarget === el) closeCtx();
    }
  }

  primed = true; // 首帧结束后，后续变化才发通知
  autosize(sessions.length);
}

// —— 窗口高度自适应：跟着卡片数量伸缩，超过屏幕才封顶+内部滚动 ——
const titlebarEl = document.getElementById("titlebar");
let lastHeight = 0;
let forcedHeight = false; // 浮层（设置/右键）把窗口临时撑高时置真，暂停自适应缩窗
function autosize(n) {
  if (forcedHeight) return; // 别让每秒 tick 把撑高的窗口缩回去，导致浮层又被裁切
  // 量“自然内容高度”：逐行 offsetHeight 累加（不受 flex 拉伸影响，能缩回去）
  let cards = 16; // #cards 上下 padding 各 8
  const kids = cardsEl.children;
  for (let i = 0; i < kids.length; i++) cards += kids[i].offsetHeight;
  if (kids.length > 1) cards += (kids.length - 1) * 7; // gap（与 styles.css #cards 的 gap 一致）
  if (n === 0) cards = 56; // 空态占位
  const foot = usageEl && !usageEl.classList.contains("hidden") ? usageEl.offsetHeight : 0;
  const needed = Math.ceil(titlebarEl.offsetHeight + cards + foot + 2); // +2 边框

  const maxH = Math.max(160, (window.screen.availHeight || 900) - 80);
  const h = Math.min(needed, maxH);
  if (Math.abs(h - lastHeight) < 2) return; // 没变就不动窗口，避免抖动
  lastHeight = h;
  invoke("set_win_height", { height: h }).catch(() => {});
}

// 打开浮层（设置/右键菜单）前，若它会超出当前窗口下沿，就临时把窗口撑高；关闭后还原。
// 解决：只有极少卡片时窗口很矮，绝对定位的浮层被窗口裁掉只露一条。
function forceHeightFor(el) {
  const need = Math.ceil(el.offsetTop + el.offsetHeight + 8);
  if (need > window.innerHeight) {
    forcedHeight = true;
    lastHeight = need;
    invoke("set_win_height", { height: need }).catch(() => {});
  }
}
function restoreHeight() {
  if (!forcedHeight) return;
  forcedHeight = false;
  lastHeight = 0; // 强制 autosize 重新下发，按卡片数量还原真实高度
  autosize(rows.size);
}

let lastHeaderKey = "";
function updateHeader(sessions) {
  const nWait = sessions.filter((s) => s.status === "waiting").length;
  const nRun = sessions.filter((s) => s.status === "running").length;
  const nDone = sessions.filter((s) => s.status === "done").length;

  const key = `${nWait}/${nRun}/${nDone}`;
  if (key === lastHeaderKey) return; // 计数没变就不重绘头部、也不打扰托盘
  lastHeaderKey = key;

  // 把状态“上移”到托盘图标：Win 换红点图标、mac 菜单栏显示文字。仅计数变化时下发，且只由固定看板驱动。
  if (IS_DOCK) invoke("set_tray_status", { nWait, nRun, nDone }).catch(() => {});

  sigEl.className = "sig" + (nWait ? " wait" : nRun ? " run" : "");
  readoutEl.innerHTML =
    `<span class="stat on-wait ${nWait ? "" : "zero"}"><b>${nWait}</b>WAIT</span>` +
    `<span class="stat on-run ${nRun ? "" : "zero"}"><b>${nRun}</b>RUN</span>` +
    `<span class="stat ${nDone ? "" : "zero"}"><b>${nDone}</b>DONE</span>`;
}

async function tick() {
  try {
    const sessions = await invoke("list_sessions");
    render(sessions || []);
  } catch {
    render([]); // 非 Tauri 环境（如纯浏览器打开）时空渲染
  }
  if (usageState) renderUsage(); // 每秒用缓存重算倒计时（不取数），与卡片计时同频
}

// —— 用量条 ——
// 首选：Claude Code 递给 statusline 的真实「占限额百分比」（5h / 7d），需装 statusline 桥接。
// 退回：本地 transcript 累加的 token 总量（近 5h / 24h），任何人都能看，只是不含百分比。
function fmtTokens(n) {
  if (!n) return "0";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}
// 百分比配色：<50 稳、50~80 注意、>=80 告警
function pctClass(p) {
  return p >= 80 ? "u-danger" : p >= 50 ? "u-warn" : "u-ok";
}
// resets_at（Unix 秒）-> “重置于 2h13m / 3d4h”
function fmtReset(sec) {
  if (!sec) return "";
  const s = Math.max(0, sec * 1000 - Date.now()) / 1000;
  if (s < 3600) return `${Math.ceil(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`;
}

// 数据每 30s 取一次缓存在这里；倒计时每秒用缓存重算，不重复取数/扫盘。
let usageState = null; // { mode:"limits", rl } | { mode:"tokens", u } | null

// 一排限额仪表：标签 · 刻度条(填充=占比) · 读数 · 重置倒计时
function gaugeRow(label, w) {
  if (!w || typeof w.used_percentage !== "number") return "";
  const p = Math.round(w.used_percentage);
  const cls = pctClass(p);
  const width = Math.max(2, Math.min(100, p)); // 至少留 2% 让填充可见
  const reset = fmtReset(w.resets_at);          // 每次调用都重算 → 每秒走字
  return `<div class="u-gauge">` +
    `<span class="u-glabel">${label}</span>` +
    `<span class="u-track"><span class="u-fill ${cls}" style="width:${width}%"></span></span>` +
    `<span class="u-pct ${cls}">${p}<i>%</i></span>` +
    (reset
      ? `<span class="u-reset" title="${label} 窗口重置倒计时">⟳${reset}</span>`
      : `<span class="u-reset u-reset-none">—</span>`) +
    `</div>`;
}

function renderUsage() {
  if (!usageState) { usageEl.classList.add("hidden"); return; }
  if (usageState.mode === "limits") {
    const rl = usageState.rl, lim = rl.rate_limits;
    // 只显示 5H / 7D 占限额百分比。花费($)刻意不显示：usage-limits.json 全局一份，
    // 谁的 statusline 最后刷新就覆盖成谁的 total_cost_usd，多开时会来回跳，参考意义低。
    usageEl.innerHTML = [gaugeRow("5H", lim.five_hour), gaugeRow("7D", lim.seven_day)].filter(Boolean).join("");
    usageEl.classList.remove("hidden");
  } else {
    const u = usageState.u;
    const tok = (label, n) =>
      `<div class="u-gauge u-gauge-tok"><span class="u-glabel">${label}</span>` +
      `<span class="u-pct">${fmtTokens(n)}</span><span class="u-tok-unit">TOK</span></div>`;
    usageEl.innerHTML = tok("5H", u.last5h) + tok("24H", u.last24h);
    usageEl.classList.remove("hidden");
  }
}

// 30s 取一次数据：优先真实限额%，缺失退回 token 累加
async function tickUsage() {
  try {
    let rl = null;
    try { rl = await invoke("get_rate_limits"); } catch {}
    const lim = rl && rl.rate_limits;
    if (lim && (lim.five_hour || lim.seven_day)) {
      usageState = { mode: "limits", rl };
    } else {
      const u = await invoke("get_usage");
      usageState = u && (u.last5h || u.last24h) ? { mode: "tokens", u } : null;
    }
  } catch {
    usageState = null;
  }
  renderUsage();
  autosize(rows.size); // 用量条显隐会改变总高，重算一次
}

// ============================ 标题栏按钮 ============================
const pinBtn = document.getElementById("pin");
let pinned = true;
function reflectPin() {
  pinBtn.classList.toggle("active", pinned);
  pinBtn.textContent = pinned ? "▲" : "△";
  pinBtn.title = pinned ? "已置顶（点击取消）" : "未置顶（点击置顶）";
}
reflectPin();
pinBtn.addEventListener("click", async () => {
  pinned = !pinned;
  reflectPin();
  try { await invoke("set_pin", { on: pinned }); }
  catch (e) { console.warn("set_pin failed:", e); }
});
document.getElementById("hide").addEventListener("click", async () => {
  try { await invoke("hide_win"); }
  catch (e) { console.warn("hide failed:", e); }
});

// ============================ 设置菜单（⚙） ============================
const gearBtn = document.getElementById("gear");
const menuEl = document.getElementById("menu");

function reflectMenu() {
  menuEl.querySelectorAll(".menu-item").forEach((item) => {
    const k = item.dataset.k;
    if (k === "autostart") return; // 异步单独刷
    item.classList.toggle("on", !!settings[k]);
  });
}
function refreshAutostartState() {
  const item = menuEl.querySelector('[data-k="autostart"]');
  invoke("get_autostart")
    .then((on) => item.classList.toggle("on", !!on))
    .catch(() => {});
}

function openMenu() {
  closeCtx(); // 两个浮层互斥，避免各自撑高互相打架
  reflectMenu();
  refreshAutostartState();
  menuEl.classList.remove("hidden");
  gearBtn.classList.add("active");
  forceHeightFor(menuEl); // 窗口太矮时撑高，保证整张菜单可见
}
function closeMenu() {
  if (menuEl.classList.contains("hidden")) return;
  menuEl.classList.add("hidden");
  gearBtn.classList.remove("active");
  restoreHeight();
}
gearBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  menuEl.classList.contains("hidden") ? openMenu() : closeMenu();
});

menuEl.addEventListener("click", async (e) => {
  const item = e.target.closest(".menu-item");
  if (!item) return;
  const k = item.dataset.k;

  if (k === "autostart") {
    const next = !item.classList.contains("on");
    item.classList.toggle("on", next); // 乐观
    try { await invoke("set_autostart", { on: next }); }
    catch { item.classList.toggle("on", !next); }
    return;
  }

  settings[k] = !settings[k];
  item.classList.toggle("on", settings[k]);
  saveSettings();

  if (k === "notify" && settings.notify) ensureNotifyPerm();
  if (k === "light") applyTheme();
});

// 两个窗口（dock / popover）共享 localStorage：一处切主题，另一处收到 storage 事件后同步，
// 无需重启即保持一致。
window.addEventListener("storage", (e) => {
  if (e.key !== "cm.settings") return;
  settings = loadSettings();
  applyTheme();
  reflectMenu();
});

// ============================ 卡片右键菜单 ============================
const ctxEl = document.getElementById("ctx");
let ctxTarget = null; // 当前右键的行
function openCtx(e, el) {
  e.preventDefault();
  closeMenu(); // 两个浮层互斥
  ctxTarget = el;
  const s = el._session || {};
  // 无可聚焦窗口时禁用“切窗”
  const focusItem = ctxEl.querySelector('[data-a="focus"]');
  const focusable = !!(s.win_hwnd || s.window_title);
  focusItem.style.display = focusable ? "" : "none";

  ctxEl.classList.remove("hidden");
  // 先显示再量尺寸，做边界收拢
  const w = ctxEl.offsetWidth, h = ctxEl.offsetHeight;
  const x = Math.min(e.clientX, window.innerWidth - w - 6);
  const y = Math.min(e.clientY, window.innerHeight - h - 6);
  ctxEl.style.left = `${Math.max(6, x)}px`;
  ctxEl.style.top = `${Math.max(6, y)}px`;
  forceHeightFor(ctxEl); // 窗口太矮（如只有一张卡片）时撑高，保证菜单不被裁
}
function closeCtx() {
  if (ctxEl.classList.contains("hidden")) return;
  ctxEl.classList.add("hidden");
  ctxTarget = null;
  restoreHeight();
}
ctxEl.addEventListener("click", async (e) => {
  const item = e.target.closest(".ctx-item");
  if (!item || !ctxTarget) return;
  const s = ctxTarget._session || {};
  const id = s.session_id;
  closeCtx();
  switch (item.dataset.a) {
    case "focus":
      if (id) invoke("focus_session", { sessionId: id }).catch(() => {});
      break;
    case "opendir":
      if (s.cwd) invoke("open_dir", { path: s.cwd }).catch(() => {});
      break;
    case "copyid":
      if (id) { try { await navigator.clipboard.writeText(id); } catch {} }
      break;
    case "remove":
      if (id) invoke("remove_session", { sessionId: id }).catch(() => {});
      break;
  }
});

// 点空白 / Esc 关闭浮层
document.addEventListener("click", (e) => {
  if (!menuEl.classList.contains("hidden") && !menuEl.contains(e.target) && e.target !== gearBtn) closeMenu();
  if (!ctxEl.classList.contains("hidden") && !ctxEl.contains(e.target)) closeCtx();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeMenu(); closeCtx(); }
});
// 非卡片区域屏蔽 WebView 原生右键菜单（原生菜单在桌面小工具里很违和）
document.addEventListener("contextmenu", (e) => {
  if (!e.target.closest(".row")) e.preventDefault();
});

// 首次用户交互时解锁音频（WebView2 的自动播放策略会让 AudioContext 起始为 suspended）
function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch {}
  window.removeEventListener("pointerdown", unlockAudio);
}
window.addEventListener("pointerdown", unlockAudio);

// ===================== 采集端安装/升级弹窗 =====================
// App 自带 hooks 安装：启动时问 Rust「采集端缺不缺 / 版本旧不旧」，缺或旧就弹一次窗，
// 一键把发射器+桥接铺进 ~/.claude/。只在固定看板(dock)弹，浮窗(popover)不重复弹。
const installOverlay = document.getElementById("install-overlay");
async function maybePromptInstall() {
  if (currentLabel() !== "dock" || !installOverlay) return;
  let st;
  try { st = await invoke("hooks_status"); } catch { return; } // 非 Tauri / 命令缺失都静默跳过
  if (!st || !st.needs_install) return;
  const body = document.getElementById("install-body");
  body.textContent = st.first_time
    ? "还没安装状态采集组件。安装后看板才能显示会话状态与限额用量。"
    : `采集组件有更新（v${st.installed_version || "旧版"} → v${st.app_version}）。更新后限额 5H/7D、新字段才会生效——光换看板不换采集端是不生效的。`;
  // 已经接管过状态栏 → 默认仍勾选（重装会幂等刷新，不会重复包裹）
  document.getElementById("install-statusline").checked = true;
  document.getElementById("install-msg").classList.add("hidden");
  installOverlay.classList.remove("hidden");
}
document.getElementById("install-later")?.addEventListener("click", () => {
  installOverlay.classList.add("hidden"); // 本次会话不再打扰；下次启动仍会按版本判断
});
document.getElementById("install-go")?.addEventListener("click", async () => {
  const withStatusline = document.getElementById("install-statusline").checked;
  const msgEl = document.getElementById("install-msg");
  const goBtn = document.getElementById("install-go");
  goBtn.disabled = true;
  msgEl.classList.remove("hidden");
  msgEl.classList.remove("err");
  msgEl.textContent = "安装中…";
  try {
    const r = await invoke("install_hooks", { withStatusline });
    msgEl.textContent = `✓ 已完成（v${r.app_version}）。重启正在运行的 Claude Code 会话后生效。`;
    tickUsage(); // 桥接被下次 statusline 调用才写文件，这里先刷一下用量显示
    setTimeout(() => installOverlay.classList.add("hidden"), 2800);
  } catch (e) {
    msgEl.classList.add("err");
    msgEl.textContent = "✗ 失败：" + (e?.message || e);
  } finally {
    goBtn.disabled = false;
  }
});

// ============================ 启动 ============================
if (settings.notify) ensureNotifyPerm();
tick();
setInterval(tick, 1000);
tickUsage();
setInterval(tickUsage, 30000); // 用量变化慢，30s 拉一次即可，避免每秒全盘扫日志
maybePromptInstall(); // 采集端缺/旧就弹窗（仅 dock）
