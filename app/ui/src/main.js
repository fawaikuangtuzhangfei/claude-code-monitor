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

const rows = new Map(); // session_id -> HTMLElement

function invoke(cmd, args) {
  if (window.__TAURI__?.core?.invoke) return window.__TAURI__.core.invoke(cmd, args);
  return Promise.reject(new Error("not in tauri"));
}

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
    case "done": return "本轮完成";
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
const DEFAULTS = { notify: true, sound: true, autofocus: false, mini: false };
let settings = loadSettings();
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("cm.settings") || "{}") }; }
  catch { return { ...DEFAULTS }; }
}
function saveSettings() {
  try { localStorage.setItem("cm.settings", JSON.stringify(settings)); } catch {}
}

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
        title: kind === "waiting" ? `⏸ ${name} 需要你输入` : `✓ ${name} 本轮完成`,
        body: subOf(s),
      });
    } catch {}
  }

  // 需输入时自动把该会话终端切到前台（可选，默认关）
  if (kind === "waiting" && settings.autofocus && (s.win_hwnd || s.window_title)) {
    invoke("focus_session", { sessionId: s.session_id }).catch(() => {});
  }
}

// 每行记录“上次已通知过的状态”，仅在真正跨状态时触发（并在未 primed 时静默打底）
function maybeNotify(el, s) {
  const st = s.status;
  const prev = el._notifiedStatus;
  el._notifiedStatus = st;
  if (!primed || st === prev) return;
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
  const name = nameOf(s), sub = subOf(s), side = sideOf(s), branch = s.git_branch || "";
  if (r.name.textContent !== name) r.name.textContent = name;
  if (r.tag.textContent !== meta.tag) r.tag.textContent = meta.tag;
  if (r.branch.textContent !== branch) r.branch.textContent = branch;
  if (r.sub.textContent !== sub) r.sub.textContent = sub;
  if (r.time.textContent !== side) r.time.textContent = side;
}

function render(sessions) {
  sessions.forEach((s) => (s.__id = s.session_id));
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
  // 迷你模式：只留顶栏
  if (document.body.classList.contains("mini")) {
    const h = Math.ceil(titlebarEl.offsetHeight + 2);
    if (Math.abs(h - lastHeight) < 2) return;
    lastHeight = h;
    invoke("set_win_height", { height: h }).catch(() => {});
    return;
  }
  // 量“自然内容高度”：逐行 offsetHeight 累加（不受 flex 拉伸影响，能缩回去）
  let cards = 16; // #cards 上下 padding 各 8
  const kids = cardsEl.children;
  for (let i = 0; i < kids.length; i++) cards += kids[i].offsetHeight;
  if (kids.length > 1) cards += (kids.length - 1) * 7; // gap（与 styles.css #cards 的 gap 一致）
  if (n === 0) cards = 56; // 空态占位
  const needed = Math.ceil(titlebarEl.offsetHeight + cards + 2); // +2 边框

  const maxH = Math.max(160, (window.screen.availHeight || 900) - 80);
  const h = Math.min(needed, maxH);
  if (Math.abs(h - lastHeight) < 2) return; // 没变就不动窗口，避免抖动
  lastHeight = h;
  invoke("set_win_height", { height: h }).catch(() => {});
}

// 打开浮层（设置/右键菜单）前，若它会超出当前窗口下沿，就临时把窗口撑高；关闭后还原。
// 解决：迷你模式 / 只有极少卡片时窗口很矮，绝对定位的浮层被窗口裁掉只露一条。
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
  lastHeight = 0; // 强制 autosize 重新下发，尊重迷你/卡片数量还原真实高度
  autosize(rows.size);
}

let lastHeaderKey = "";
function updateHeader(sessions) {
  const nWait = sessions.filter((s) => s.status === "waiting").length;
  const nRun = sessions.filter((s) => s.status === "running").length;
  const nDone = sessions.filter((s) => s.status === "done").length;

  const key = `${nWait}/${nRun}/${nDone}`;
  if (key === lastHeaderKey) return; // 计数没变就不重绘头部
  lastHeaderKey = key;

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

function applyMini() {
  document.body.classList.toggle("mini", settings.mini);
  autosize(rows.size); // 立即伸缩窗口
}

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
  if (k === "mini") applyMini();
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

// ============================ 启动 ============================
if (settings.notify) ensureNotifyPerm();
applyMini();
tick();
setInterval(tick, 1000);
