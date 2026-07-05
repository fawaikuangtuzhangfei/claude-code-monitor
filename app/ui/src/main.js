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
  if (s.status === "done") return "✓";
  return "";
}

function createRow() {
  const el = document.createElement("div");
  el.className = "row";
  el.innerHTML = `
    <span class="led"></span>
    <div class="main">
      <div class="name"></div>
      <div class="metaline"><span class="tag"></span><span class="sub"></span></div>
    </div>
    <div class="side"><span class="time"></span></div>`;
  el._refs = {
    name: el.querySelector(".name"),
    tag: el.querySelector(".tag"),
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
  return el;
}

function updateRow(el, s) {
  const meta = STATUS_META[s.status] || STATUS_META.idle;
  const focusable = !!(s.win_hwnd || s.window_title);
  el.className = `row ${s.status}${focusable ? " focusable" : ""}`;
  el.title = `${s.cwd || ""}${focusable ? "  —  点击切到该终端" : ""}`;
  const r = el._refs;
  const name = nameOf(s), sub = subOf(s), side = sideOf(s);
  if (r.name.textContent !== name) r.name.textContent = name;
  if (r.tag.textContent !== meta.tag) r.tag.textContent = meta.tag;
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
    }
  }

  autosize(sessions.length);
}

// —— 窗口高度自适应：跟着卡片数量伸缩，超过屏幕才封顶+内部滚动 ——
const titlebarEl = document.getElementById("titlebar");
let lastHeight = 0;
function autosize(n) {
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

// —— 标题栏按钮（走 Rust 命令，稳定）——
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

// —— 开机自启开关（⏻）——
const bootBtn = document.getElementById("boot");
function reflectBoot(on) {
  bootBtn.classList.toggle("active", on);
  bootBtn.title = on ? "开机自启：开（点击关闭）" : "开机自启：关（点击开启）";
}
invoke("get_autostart").then(reflectBoot).catch(() => {});
bootBtn.addEventListener("click", async () => {
  const next = !bootBtn.classList.contains("active");
  reflectBoot(next); // 乐观更新
  try { await invoke("set_autostart", { on: next }); }
  catch (e) { console.warn("set_autostart failed:", e); reflectBoot(!next); }
});

tick();
setInterval(tick, 1000);
