// server.mjs — 在手机浏览器里看这个项目的看板（实验性辅助脚本，非正式功能）
//
// 做法：零依赖 Node HTTP 服务，直接托管仓库里现成的 UI（app/ui/），
// 再伪造一个 window.__TAURI__ 把 UI 的 invoke() 接到 REST 上——
// 因为 app/ui/src/main.js 的 invoke 只认 window.__TAURI__?.core?.invoke，
// 把它喂饱，UI 就一行都不用改（也确实一行都没改）。
//
// 用法：
//   node build.mjs     # 首次必须跑，生成降级版 JS（旧安卓浏览器要它）
//   node server.mjs    # 启动时会打印手机该用的地址
//
// 安全模型（重要，别想当然）：
//   - 绑 0.0.0.0，**同网段任何设备都能读**你的项目名 / git 分支 / prompt 片段。
//     只读接口刻意不设鉴权（方便），所以**只在可信局域网跑**，别在公司或咖啡厅开。
//   - POST /api/focus 会把你 PC 上的终端窗口提到前台，是唯一会「动手」的接口，
//     因此单独要令牌（token.txt，首次运行随机生成，已在 .gitignore 里）。
//
// 已知取舍：
//   - 僵尸会话剔除是近似的（pid 存活 + 时效闸门），不如 app/src-tauri 里
//     那套 Win32 IsWindow + HWND 回收校验精确。
//   - 聚焦终端依赖 Win32，仅 Windows 可用；看板显示部分跨平台。
//   - /api/usage 是桩，恒返回 0；真实限额百分比走 /api/rate-limits。

import { createServer } from 'node:http';
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join, extname, normalize, sep } from 'node:path';
import { homedir, networkInterfaces } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';

// import.meta.dirname 要 Node 20.11+。旧版本上它是 undefined，
// 后面 join(undefined, ...) 会抛一句跟真实原因毫无关系的 TypeError，
// 所以在这里就拦住并说清楚。
const HERE = import.meta.dirname;
if (!HERE) {
  console.error('需要 Node 20.11 或更高版本（当前 ' + process.version + '）。');
  console.error('原因：本脚本用到 import.meta.dirname，旧版本不支持。');
  process.exit(1);
}

const PORT = Number(process.env.PORT || 7788);
// 直接读仓库里的 UI（不复制），改了 UI 刷新页面就能看到。
// 本脚本住在 <repo>/tools/phone/，所以 UI 在 ../../app/ui
const UI_DIR = process.env.UI_DIR || join(HERE, '..', '..', 'app', 'ui');
const MONITOR_DIR = join(homedir(), '.claude', 'monitor');
// 时效闸门：状态文件超过这个时长没更新就当它是残留。
// 设 24 而不是 8：实测化石都在 105h 以上、真实会话都在 7h 以内，中间空档很大，
// 24h 一样能切干净，却能保住「早上跑的、晚上回家才看」的会话——8h 会把它们误删。
const MAX_AGE_MS = Number(process.env.MAX_AGE_H || 24) * 3600 * 1000;

// ---------------------------------------------------------------- 会话读取

// pid 是否还活着。返回 true / false / null(未知——没记录 pid 的老状态文件)
// signal 0 只做存在性探测，不真的发信号；Windows 上同样有效。
// EPERM = 进程在、但没权限管它，仍算活着。
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// 读 ~/.claude/monitor/*.json，过滤掉非会话文件和明显的僵尸会话。
// 正式版在 Rust 里用 IsWindow + HWND 回收校验，精确；这里只能近似——
// 原型阶段够用，目的是别让一屏残留卡片干扰你判断体验。
function listSessions() {
  const stats = { total: 0, kept: 0, droppedNotSession: 0, droppedDeadPid: 0, droppedStale: 0 };
  let files = [];
  try {
    files = readdirSync(MONITOR_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return { sessions: [], stats };
  }

  const now = Date.now();
  const out = [];
  for (const f of files) {
    stats.total++;
    let rec;
    try {
      rec = JSON.parse(readFileSync(join(MONITOR_DIR, f), 'utf8'));
    } catch {
      stats.droppedNotSession++;
      continue;
    }
    // 会话文件必有 status；usage-limits.json 这类没有，跳过
    if (typeof rec?.status !== 'string') {
      stats.droppedNotSession++;
      continue;
    }

    // 终端进程还在不在。win_pid 是承载会话的终端窗口进程，owner_pid 是 mac 侧的等价物。
    const alive = pidAlive(rec.win_pid ?? rec.owner_pid);
    if (alive === false) {
      stats.droppedDeadPid++;
      continue;
    }
    // 时效闸门：pid 活着也照样卡。实测 130 个文件里有一批 100~600 小时前的化石，
    // 终端进程恰好没退（或 pid 被系统回收给了别的进程），光靠 pid 判不掉。
    // 一个几周没动静的会话不该占手机屏幕，所以这条不管 pid 死活一律生效。
    if (now - (rec.updated_at || 0) > MAX_AGE_MS) {
      stats.droppedStale++;
      continue;
    }

    out.push(rec);
    stats.kept++;
  }
  return { sessions: out, stats };
}

// 限额数据：statusline 桥接写的，原样透传（Rust 版 get_rate_limits 也是原样返回）
function readRateLimits() {
  try {
    return JSON.parse(readFileSync(join(MONITOR_DIR, 'usage-limits.json'), 'utf8'));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- 操控（聚焦终端）

// 只读接口不需要令牌（保持现状，书签照旧能用）；
// 但「聚焦窗口」是往你 PC 上动手，同网段任何人都能调就太过了，所以单独加一道令牌。
// 令牌存盘复用，免得每次重启都要重新改手机书签。
const TOKEN_FILE = join(HERE, 'token.txt');
let TOKEN;
try {
  TOKEN = readFileSync(TOKEN_FILE, 'utf8').trim();
} catch {
  TOKEN = '';
}
if (!TOKEN) {
  TOKEN = randomBytes(9).toString('base64url');
  writeFileSync(TOKEN_FILE, TOKEN, 'utf8');
}

const FOCUS_PS1 = join(HERE, 'focus.ps1');

// 按 session_id 查出 win_hwnd。
// session_id 先过白名单正则再拼路径——它来自网络请求，绝不能直接进文件路径。
function hwndOf(sessionId) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(sessionId || ''))) return null;
  try {
    const rec = JSON.parse(readFileSync(join(MONITOR_DIR, `${sessionId}.json`), 'utf8'));
    const h = Number(rec.win_hwnd);
    return Number.isInteger(h) && h !== 0 ? h : null;
  } catch {
    return null;
  }
}

// 交给 PowerShell 去调 Win32。只传一个已校验过的整数，不拼任何字符串进命令行。
function focusHwnd(hwnd) {
  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', FOCUS_PS1, '-Hwnd', String(hwnd)],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => resolve(!err && String(stdout).includes('OK'))
    );
  });
}

// ---------------------------------------------------------------- 前端垫片

// 伪造 window.__TAURI__.core.invoke，把 UI 的 12 个命令映射到 REST / 空操作。
// 只实现三个读接口，其余（窗口、托盘、自启、聚焦、安装 hooks）一律安静地返回 null——
// 关键是别 reject，UI 里不少地方没 catch，抛了会中断渲染。
const SHIM = `
(function () {
  // ---- 排错：手机上没有 devtools，所以报错既画到页面上、也回传服务端控制台 ----
  function report(kind, msg, extra) {
    try {
      var box = document.getElementById('__err');
      if (!box) {
        box = document.createElement('pre');
        box.id = '__err';
        box.style.cssText = 'position:fixed;inset:0;z-index:99999;margin:0;padding:12px;' +
          'background:#180a0a;color:#ff9b9b;font:12px/1.5 monospace;white-space:pre-wrap;' +
          'overflow:auto;-webkit-user-select:text;user-select:text';
        (document.body || document.documentElement).appendChild(box);
      }
      box.textContent += '[' + kind + '] ' + msg + '\\n' + (extra || '') + '\\n\\n';
    } catch (e) {}
    post(kind, String(msg), String(extra || ''));
  }
  function post(kind, msg, extra) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/api/log', true);
      x.setRequestHeader('content-type', 'application/json');
      x.send(JSON.stringify({ kind: kind, msg: msg, extra: extra || '', ua: navigator.userAgent }));
    } catch (e) {}
  }
  // 立刻报一次 UA：哪怕后面全挂，至少能知道这是什么浏览器
  post('hello', 'shim 已执行', '');
  window.addEventListener('error', function (e) {
    report('error', e.message, (e.filename || '') + ':' + e.lineno + ':' + e.colno + '\\n' + (e.error && e.error.stack || ''));
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    report('reject', (r && r.message) || r, (r && r.stack) || '');
  });
  // 存活信标：main.js 若整个没跑起来，rows 会是 0 且 readout 为空——
  // 据此区分「模块没执行」和「模块执行了但渲染不出来」
  window.addEventListener('load', function () {
    setTimeout(function () {
      var readout = document.getElementById('readout');
      post('load',
        'rows=' + document.querySelectorAll('#cards .row').length +
        ' readout="' + ((readout && readout.textContent) || '') + '"' +
        ' tauri=' + (typeof window.__TAURI__), '');
    }, 1500);
  });

  // 用 XHR 不用 fetch：这段垫片必须能在最旧的浏览器上跑起来，
  // 否则连"为什么跑不起来"都上报不出去（第一次就栽在这——垫片用了 async/await，
  // 旧浏览器解析阶段就挂了，页面只剩静态 HTML，看着就是"空页面"）。
  // 条件请求：轮询接口带上一次拿到的 ETag，内容没变服务端回 304 空体，
  // 这里直接把上次解析好的结果拿出来用——省掉传输、JSON.parse 和一次全量 render。
  // 不靠浏览器缓存自动发 If-None-Match（旧安卓上行为不可靠），全部显式做。
  var etags = {}, cachedBody = {};
  function get(path, conditional) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open('GET', path, true);
      if (conditional && etags[path]) x.setRequestHeader('If-None-Match', etags[path]);
      x.onreadystatechange = function () {
        if (x.readyState !== 4) return;
        if (x.status === 304) {
          if (Object.prototype.hasOwnProperty.call(cachedBody, path)) return resolve(cachedBody[path]);
          // 说好没变、本地却没那份东西（不该发生）。清掉 etag 让下次无条件重取，
          // 而不是留着一个永远命中 304、页面永远空的死循环。
          etags[path] = null;
          return reject(new Error(path + ' -> 304 但本地无缓存'));
        }
        if (x.status < 200 || x.status >= 300) return reject(new Error(path + ' -> ' + x.status));
        var v;
        try { v = JSON.parse(x.responseText); } catch (e) { return reject(e); }
        if (conditional) {
          var et = x.getResponseHeader('ETag');
          // 拿不到 ETag（被代理剥了之类）就退回无条件轮询，功能不受影响
          if (et) { etags[path] = et; cachedBody[path] = v; }
        }
        resolve(v);
      };
      x.send();
    });
  }
  // ---- 断线提示 ----
  // main.js 的 tick() 拉数失败时会走 render([])，页面显示「无运行中的会话」——
  // 于是「服务挂了 / WiFi 断了 / 电脑休眠了」和「一切正常、没会话在跑」长得一模一样。
  // 对「回家瞄一眼」的用法这是个陷阱：扫一眼以为没事，其实根本没连上。
  // 所以这里给个明确的断线横幅，并把那句会误导人的空态文案盖掉。
  var failCount = 0, lastOk = 0, bar = null;
  function setOffline(on) {
    if (!bar) {
      bar = document.createElement('div');
      bar.id = '__offline';
      bar.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:9999;' +
        'padding:6px 10px;background:#7a1f1f;color:#ffd9d9;' +
        'font:600 12px/1.4 monospace;text-align:center;display:none';
      (document.body || document.documentElement).appendChild(bar);
    }
    if (on) {
      var ago = lastOk ? Math.round((new Date().getTime() - lastOk) / 1000) : 0;
      bar.textContent = '⚠ 连不上电脑' +
        (lastOk ? '，最后更新于 ' + ago + ' 秒前' : '，从未连上');
    }
    bar.style.display = on ? 'block' : 'none';
    // 断线时藏掉「无运行中的会话」，否则两条信息互相打架
    var empty = document.getElementById('empty');
    if (empty) empty.style.visibility = on ? 'hidden' : '';
  }

  // ---- 操控：聚焦终端 ----
  // 令牌从 URL 取（?t=xxx）。没带令牌就只是只读看板，点卡片会明确告诉你操控没开，
  // 而不是默默什么都不发生——静默失败最难查。
  var TOKEN = (location.search.match(/[?&]t=([^&]*)/) || [])[1] || '';

  function postJson(path, obj) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open('POST', path, true);
      x.setRequestHeader('content-type', 'application/json');
      x.onreadystatechange = function () {
        if (x.readyState !== 4) return;
        if (x.status < 200 || x.status >= 300) {
          return reject(new Error(x.responseText || 'HTTP ' + x.status));
        }
        try { resolve(x.responseText ? JSON.parse(x.responseText) : null); }
        catch (e) { resolve(null); }
      };
      x.send(JSON.stringify(obj));
    });
  }

  // 操控必须有反馈：main.js 里 focus_session 是 .catch(()=>{}) 静默的，
  // 手机上点完没任何动静你根本不知道成没成。
  var toastEl = null, toastTimer = null;
  function toast(text, isErr) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText = 'position:fixed;left:50%;bottom:18px;z-index:9998;' +
        'margin-left:-44%;width:88%;box-sizing:border-box;padding:9px 12px;border-radius:6px;' +
        'font:600 12px/1.35 monospace;color:#fff;text-align:center;display:none';
      (document.body || document.documentElement).appendChild(toastEl);
    }
    toastEl.style.background = isErr ? '#7a1f1f' : '#1f5a34';
    toastEl.textContent = text;
    toastEl.style.display = 'block';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.style.display = 'none'; }, 2200);
  }

  var READ = {
    focus_session: function (args) {
      var id = args && (args.sessionId || args.session_id);
      if (!TOKEN) {
        toast('操控未启用：书签里要带 ?t=令牌', true);
        return Promise.resolve(null);
      }
      return postJson('/api/focus', { session_id: id, token: TOKEN }).then(
        function () { toast('已切到该终端'); return null; },
        function (e) { toast('切窗失败：' + e.message, true); return null; }
      );
    },
    list_sessions: function () {
      return get('/api/sessions', true).then(
        function (v) { failCount = 0; lastOk = new Date().getTime(); setOffline(false); return v; },
        function (e) {
          // 连错两次才报，避免一次网络抖动就闪红条（3s 轮询 → 约 6s 后出现）
          failCount++;
          if (failCount >= 2) setOffline(true);
          throw e; // 继续抛给 main.js 的 tick()，让它照常走 render([])
        }
      );
    },
    get_rate_limits: function () { return get('/api/rate-limits', true); },
    get_usage:       function () { return get('/api/usage'); },
    hooks_status:    function () { return Promise.resolve({ needs_install: false }); },
    get_autostart:   function () { return Promise.resolve(false); },
  };
  window.__TAURI__ = {
    core: {
      invoke: function (cmd, args) {
        if (READ[cmd]) return READ[cmd](args);
        // set_win_height / set_tray_status / set_pin / hide_win / set_autostart /
        // focus_session / open_dir / remove_session / install_hooks —— 手机上无意义
        return Promise.resolve(null);
      },
    },
    // 刻意不提供 notification：你要的是看板不是通知，
    // 而且 main.js 用的是 ?. 访问，缺了会自动降级、不报错。
  };
})();
`;

// 手机适配：只覆盖必要的几条，不动仓库里的 styles.css。
// 注意目标是 Chrome 75（Android 5.1 上能装到的较新版本），比桌面 Chrome 缺不少特性。
const MOBILE_CSS = `
/* 高度：不用 100vh 也不用 100dvh。
   100vh 在移动浏览器等于「地址栏收起后」的大视口，内容会被地址栏盖住一截；
   100dvh 要 Chrome 108，这台只有 75。
   height:100% 逐级继承到真实可视高度，所有浏览器行为一致，最稳。 */
html, body { height: 100%; }
#app { height: 100%; border: 0; border-radius: 0; box-shadow: none; }

/* 全屏显示时这些桌面装饰没意义 */
.corner { display: none !important; }
/* 置顶 / 隐藏到托盘：手机上点了什么也不会发生，直接藏掉 */
#pin, #hide { display: none !important; }
/* 触摸目标放大一点 */
.tb-btn { min-width: 34px; min-height: 34px; }
body { -webkit-text-size-adjust: 100%; }

/* flex 的 gap 要 Chrome 84，这台 75 不支持，卡片会挤成一坨。
   统一改用相邻兄弟 margin：不做特性检测，所有浏览器走同一条路径，结果一致。 */
#cards { gap: 0 !important; }
#cards > * + * { margin-top: 7px; }

/* color-mix() 要 Chrome 111（样式表里 7 处）。不支持时整条 background 声明失效，
   卡片会变成全透明、显得扁平。只给旧浏览器补个底色，新浏览器保持原渐变不受影响。 */
@supports not (background: color-mix(in srgb, red 50%, transparent)) {
  .row { background: rgba(255, 255, 255, 0.032); }
}

/* 省电：关掉四个常驻动画（LED 呼吸 / WAIT 告警 / 信号点脉冲 / 空态光标）。
   styles.css:293 那句「只动 opacity → GPU 合成层，不触发重绘」是为桌面写的，
   目的是防止透明置顶窗口闪屏；结论在手机上反过来——只要还有一个 infinite 动画在跑，
   合成器就永远进不了空闲，GPU 和一个 CPU 核被持续唤醒，7 张卡就是 7 个动画层。
   而且 Chrome 75 在这类老 GPU 上未必真走得上合成路径，退化成全量重绘只会更贵。

   丢掉的信号有限：状态本来就靠颜色 + WAIT/RUN 文字标签区分，静止照样认得出；
   「刚变成 WAIT」的那下醒目提示走的是 .row.flash-wait（一次性放 3 遍），不受影响。 */
.sig.wait,
.row.running .led,
.row.waiting .led,
.empty-cursor { animation: none !important; }
`;

// ---------------------------------------------------------------- 静态文件

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// 收请求体，超限就明确回 413。
// 不用 req.destroy()：那样 'end' 不再触发，客户端拿不到任何响应，只能干等超时。
function readBody(req, res, limit) {
  return new Promise((resolve) => {
    let body = '';
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      body += c;
      if (body.length > limit) {
        over = true;
        res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('请求体过大');
        resolve(null);
      }
    });
    req.on('end', () => { if (!over) resolve(body); });
    req.on('error', () => { if (!over) resolve(null); });
  });
}

// 打印到终端前先洗掉控制字符。
// /api/log 收的是网络来的内容，局域网上任何人都能 POST 进来；
// 裸打印意味着别人能往你控制台注入 ANSI 转义序列（清屏、移光标、伪造输出）。
// 保留 \t，去掉其余 C0/C1 控制符和 DEL。
function safeLine(s) {
  return String(s == null ? '' : s).replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, '.');
}

function sendJson(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

// 带 ETag 的 JSON：内容跟客户端手里那份一样就回 304 空体。
//
// 为什么值得做：状态文件的 updated_at 只在 hook 事件时变（不是心跳），
// 所以「没有会话在动」的时候每次轮询拿到的 JSON 是逐字节相同的。
// 回 304 省掉的是传输体积、手机端的 JSON.parse 和一次全量 render——
// 对老手机来说，更重要的是响应更小 → 射频高功耗窗口更短。
//
// 这里的 ETag 是「应用级」的，不走浏览器 HTTP 缓存——所以仍然发 no-store。
// 别改成 no-cache：那样浏览器会自己存一份，并在下次请求时**追加**它自己的
// If-None-Match；XHR 的 setRequestHeader 是逗号拼接语义，两个值拼在一起
// 就永远等不上服务端算出来的那个，304 一次都不会命中，白折腾。
// no-store 下浏览器不缓存、不加头，条件请求完全由垫片掌控（它自己存 etag + 解析结果）。
function sendJsonEtag(req, res, obj) {
  const body = JSON.stringify(obj);
  const etag = `"${createHash('sha1').update(body).digest('base64')}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': 'no-store' });
    return res.end();
  }
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    etag,
  });
  res.end(body);
}

// 把垫片和移动端样式注入到仓库那份 index.html 里。
// 垫片用普通 <script>（同步执行），必须排在 type="module" 的 main.js 之前——
// module 是 defer 语义，所以放 head 里就稳了。
// 仓库的 main.js 用了 ES2020 的 ?. 和 ??，旧安卓浏览器解析模块直接失败，
// 整个 JS 一行不跑，页面只剩静态 HTML——看着就是「只有标题和齿轮」。
// main.legacy.js 是 esbuild 降到 ES2015 + IIFE 的产物，连 type="module"（Chrome 61+）都不需要。
// 重新生成：node build.mjs
const LEGACY_JS = join(HERE, 'main.legacy.js');
const USE_LEGACY = process.env.LEGACY !== '0' && existsSync(LEGACY_JS);

function renderIndex() {
  let html = readFileSync(join(UI_DIR, 'index.html'), 'utf8');
  // 换成降级版：普通 <script>，不走模块
  if (USE_LEGACY) {
    html = html.replace(
      '<script type="module" src="/src/main.js"></script>',
      '<script src="/main.legacy.js"></script>'
    );
  }
  html = html.replace(
    '</head>',
    `  <meta name="mobile-web-app-capable" content="yes" />\n` +
      `  <style>${MOBILE_CSS}</style>\n` +
      `  <script>${SHIM}</script>\n` +
      `</head>`
  );
  return html;
}

function serveStatic(res, urlPath) {
  // 目录穿越防护：规整化之后必须仍在 UI_DIR 里
  const full = normalize(join(UI_DIR, urlPath));
  if (!full.startsWith(normalize(UI_DIR) + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (!existsSync(full) || !statSync(full).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(full)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(readFileSync(full));
}

// ---------------------------------------------------------------- 服务

const server = createServer((req, res) => {
  const path = (req.url || '/').split('?')[0];

  if (path === '/' || path === '/index.html') {
    try {
      const html = renderIndex();
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      res.end(html);
    } catch (e) {
      res.writeHead(500).end('读不到 UI，检查 UI_DIR：' + UI_DIR + '\n' + e.message);
    }
    return;
  }

  // 降级版 JS 放在原型目录（不在 UI_DIR 里），单独处理
  if (path === '/main.legacy.js' && existsSync(LEGACY_JS)) {
    res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' });
    res.end(readFileSync(LEGACY_JS));
    return;
  }

  // 这两个是轮询接口，走 ETag：没变就 304（见 sendJsonEtag 的说明）
  if (path === '/api/sessions') return sendJsonEtag(req, res, listSessions().sessions);
  if (path === '/api/rate-limits') return sendJsonEtag(req, res, readRateLimits());
  // 正式版会扫 ~/.claude/projects/**/*.jsonl 累加 token；原型不做——
  // UI 的 tickUsage 优先用 rate_limits，拿到了就不会走到这里。
  if (path === '/api/usage') return sendJson(res, { last5h: 0, last24h: 0, updated_at: Date.now() });

  // 聚焦终端：唯一一个会动你 PC 的接口，所以要令牌
  if (path === '/api/focus' && req.method === 'POST') {
    (async () => {
      const body = await readBody(req, res, 4096);
      if (body === null) return; // 已回 413

      let o = {};
      try { o = JSON.parse(body); } catch {}

      if (o.token !== TOKEN) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('令牌不对');
      }
      // 平台先判，否则非 Windows 上会把「不支持」误报成「窗口已关闭」
      if (process.platform !== 'win32') {
        res.writeHead(501, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('聚焦终端依赖 Win32，仅 Windows 可用');
      }
      const hwnd = hwndOf(o.session_id);
      if (hwnd === null) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('这个会话没有可用的终端窗口');
      }
      const ok = await focusHwnd(hwnd);
      console.log(`  → 聚焦 ${safeLine(o.session_id)} (hwnd ${hwnd}): ${ok ? '成功' : '失败'}`);
      if (!ok) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('窗口已关闭或切换失败');
      }
      sendJson(res, { ok: true });
    })();
    return;
  }

  // 手机端报错回传：浏览器没 devtools，让页面把 error/rejection 打到这边控制台。
  // 打印前一律过 safeLine —— 内容来自网络，不能裸打进终端。
  if (path === '/api/log' && req.method === 'POST') {
    (async () => {
      const body = await readBody(req, res, 64 * 1024);
      if (body === null) return; // 已回 413

      let o = {};
      try { o = JSON.parse(body); } catch { o = { kind: 'raw', msg: body }; }
      console.log('');
      console.log(`  ┌─ 手机端 [${safeLine(o.kind)}] ${new Date().toLocaleTimeString()}`);
      for (const line of safeLine(o.msg).split('\n')) console.log('  │ ' + line);
      if (o.extra) for (const line of safeLine(o.extra).split('\n')) console.log('  │ ' + line);
      if (o.ua) console.log('  └─ ' + safeLine(o.ua));
      res.writeHead(204).end();
    })();
    return;
  }

  // 过滤效果自查：想知道 132 个文件里到底留下几个、各因什么被剔除，就看这个
  if (path === '/api/debug') {
    const { stats } = listSessions();
    return sendJson(res, { stats, monitorDir: MONITOR_DIR, uiDir: UI_DIR, maxAgeMs: MAX_AGE_MS });
  }

  return serveStatic(res, path);
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
    }
  }
  const { stats } = listSessions();
  console.log('');
  console.log('  Claude 看板 · 手机原型');
  console.log('  ─────────────────────────────────');
  console.log(`  本机   http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  手机   http://${ip}:${PORT}/?t=${TOKEN}`);
  console.log('');
  console.log('  ↑ 手机用带 ?t= 的这条（点卡片可切窗）。不带令牌也能看，只是纯只读。');
  console.log('');
  console.log(`  状态文件 ${stats.total} 个 → 显示 ${stats.kept} 个`);
  console.log(`  （剔除：非会话 ${stats.droppedNotSession} / 进程已退出 ${stats.droppedDeadPid} / 过期 ${stats.droppedStale}）`);
  console.log('');
  // 没跑过 build.mjs 时，旧安卓浏览器会白屏且毫无线索——在这里就说破，
  // 别让人对着「只有标题和齿轮」的页面去查后端。
  if (!USE_LEGACY) {
    console.log('  ⚠ 未加载 main.legacy.js，直接使用仓库原版 main.js。');
    console.log('    Chrome 80 以下（含不少旧安卓机）会白屏。先跑一次：node build.mjs');
    console.log('');
  }
  console.log('  手机需与本机同一 WiFi。Ctrl+C 停止。');
  console.log('');
});
