/**
 * handsomeFish 桌面级外壳 · 主进程（Electron）
 * =============================================================================
 * 目标：让帅鱼能放在**整个桌面的任意位置**，这是 DSH 界面内挂件做不到的
 *       （页面里的 DOM 物理上出不了 DSH 窗口）。
 *
 * 架构选择：**一块铺满工作区的全透明窗口**，角色在这块窗口内部用 CSS 自由定位。
 *   · 好处：lib/client.js 的角色、拖拽、吸附、台词、音效一行都不用改；
 *           「整个桌面四处放」= 窗口内坐标自由，天然成立。
 *   · 代价：整块窗口默认必须**点击穿透**，否则会挡住下面所有程序 ——
 *           所以靠渲染页上报的 hover 状态开关命中测试（见 preload.js / renderer.html）。
 *
 * 启动：cd desktop && npm install && npm start
 */
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { createTurnWatcher } = require("./turn-watch.js");

/**
 * 关掉 Chromium 沙箱。
 * ---------------------------------------------------------------------------
 * 实测：这台机器上沙箱初始化会让 Electron 直接 STATUS_BREAKPOINT 秒崩 ——
 * 连 `electron.exe --version` 都崩，加上 `--no-sandbox` 才正常输出 v40.10.2。
 * 渲染页只加载本地 renderer.html（无远程内容）、contextIsolation 打开、
 * nodeIntegration 关闭，风险可控。
 * 想恢复沙箱：设 HANDSOME_FISH_SANDBOX=1 启动。
 */
if (process.env.HANDSOME_FISH_SANDBOX !== "1") {
  app.commandLine.appendSwitch("no-sandbox");
}

/*
 * 日志同时写文件。
 * 原因：Windows 上 Electron 是 **GUI 子系统**程序 —— 从没有控制台的父进程
 * （比如计划任务、后台任务、双击 exe）启动时，console.log 哪儿都不会出现，
 * 于是"启动后静默退出"完全没法排查。日志落在 desktop/handsome-fish.log。
 */
const LOG_FILE = path.join(__dirname, "handsome-fish.log");
function mirrorToFile(level, args) {
  try {
    const line =
      `[${new Date().toISOString()}] [${level}] ` +
      args
        .map((a) => {
          if (typeof a === "string") return a;
          if (a instanceof Error) return a.stack || a.message;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(" ") +
      "\n";
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    /* 日志写不进去也不能影响主流程 */
  }
}
for (const level of ["log", "warn", "error"]) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    mirrorToFile(level, args);
    try {
      original(...args);
    } catch {
      /* 没有控制台时 stdout 写入可能失败，忽略 */
    }
  };
}

/* 启动即打一行：主进程有没有跑起来，一眼就知道（否则只能看到"静默退出"） */
console.log(`[handsome-fish] 主进程启动 electron=${process.versions.electron} ${process.platform}`);
process.on("uncaughtException", (error) => {
  console.error("[handsome-fish] 未捕获异常:", error && error.stack ? error.stack : error);
});


const CHANNEL = "handsome-fish:bridge";
/* 主进程 → 渲染页：检测到新的一轮对话结束 */
const TURN_CHANNEL = "handsome-fish:turn-end";
/** 一轮进行中 / 结束（桌面窗收不到键盘事件，靠它进入"认真工作"状态） */
const BUSY_CHANNEL = "handsome-fish:busy";

/**
 * 「一轮对话结束」状态路由的绝对地址。
 * ---------------------------------------------------------------------------
 * 桌面窗是 file:// 源，相对路径会解析成 file:///dsh-handsome-fish/... 从而失败，
 * 所以必须拿到 DSH 宿主的绝对地址。三级来源：
 *   1. 环境变量 DSH_WEB_URL（最权威；宿主自己导出的）
 *   2. ~/.dsh/mobile-access/setup.json 的 upstreamOrigin（用户手动从普通终端启动时用）
 *   3. 都没有 → 返回空串，前端退回相对路径（桌面窗里取不到 → 没有结束音，静默降级）
 * 注意：只读 host，绝不去碰 agents-anywhere/bridge/endpoint.json 里的 token。
 */
function resolveDshBaseUrl() {
  const env = process.env.DSH_WEB_URL;
  if (typeof env === "string" && /^https?:\/\//i.test(env)) return env.replace(/\/+$/, "");

  try {
    const file = path.join(os.homedir(), ".dsh", "mobile-access", "setup.json");
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const origin = parsed && parsed.upstreamOrigin;
      if (typeof origin === "string" && /^https?:\/\//i.test(origin)) return origin.replace(/\/+$/, "");
    }
  } catch (error) {
    console.warn("[handsome-fish] 读取 setup.json 失败:", error.message);
  }
  return "";
}

const DSH_BASE = resolveDshBaseUrl();
const EVENTS_URL = DSH_BASE ? `${DSH_BASE}/dsh-handsome-fish/events.json` : "";

/** @type {BrowserWindow | null} */
let win = null;

/** @type {ReturnType<typeof createTurnWatcher> | null} */
let turnWatcher = null;

function createWindow() {
  /* 铺满主显示器的工作区（排除任务栏），而不是整块屏幕 —— 否则鱼会跑到任务栏底下 */
  const { workArea } = screen.getPrimaryDisplay();

  win = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    /* 无边框 + 透明：桌面上只看得到角色本身 */
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    /* 桌面挂件不该出现在任务栏/Alt-Tab 里 */
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    movable: false,
    /* 先不显示，等页面就绪再 showInactive()，避免抢走当前窗口的焦点 */
    show: false,
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      /* 关键：窗口没焦点时也要继续跑动画，否则桌宠会「僵住」 */
      backgroundThrottling: false,
      /* 把状态路由的绝对地址交给 preload → 渲染页，桌面窗才拿得到 DSH 的轮次状态 */
      additionalArguments: [`--hf-events-url=${EVENTS_URL}`],
    },
  });

  /* 渲染页的 console 不默认进主进程 stdout —— 只挑对本插件有关的信息转发，
     这样 npm start 的终端里就能看到挂件自己的日志，排查不用开 DevTools。
     注意：console-message 的参数形状跨 Electron 版本变过（旧的 (event, level, message…)
     vs 新的 (event, details)），两种都兜住，免得换个版本就静默失效。 */
  win.webContents.on("console-message", (...args) => {
    const details = args[1];
    let level = 0;
    let message = "";
    if (details && typeof details === "object" && typeof details.message === "string") {
      /* 新签名（Electron 37+）：level 是字符串 */
      message = details.message;
      level = details.level === "error" ? 3 : details.level === "warning" ? 2 : 0;
    } else {
      /* 旧签名：args = (event, level:number, message, line, sourceId) */
      level = typeof args[1] === "number" ? args[1] : 0;
      message = typeof args[2] === "string" ? args[2] : "";
    }
    const text = String(message || "");
    const interesting =
      text.includes("handsomeFish") ||
      text.includes("handsome-fish") ||
      text.includes("HANDSOME_FISH") ||
      level >= 2; /* warning / error 一律转发 */
    if (interesting) console.log(`[renderer] ${text}`);
  });

  /* 置顶到最高层级，尽量盖住全屏应用；Electron 的 'screen-saver' 是可用最高档 */
  console.log("[handsome-fish] 窗口已创建，设置置顶与点击穿透");
  win.setAlwaysOnTop(true, "screen-saver");
  try {
    /* 主要是 macOS 的语义，Windows 上可能不支持 —— 失败了不影响主流程 */
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch (error) {
    console.warn("[handsome-fish] setVisibleOnAllWorkspaces 不受支持，已忽略:", error.message);
  }

  /* 默认整块窗口点击穿透，但把鼠标移动事件转发给页面，
     让页面里的 pointerenter/pointerleave 能正常触发，再由桥把 hover 状态送回来。 */
  win.setIgnoreMouseEvents(true, { forward: true });

  win.loadFile(path.join(__dirname, "renderer.html"), {
    search: process.argv.includes("--devtools") ? "debug=1" : "",
  });
  console.log("[handsome-fish] renderer.html 已提交加载");

  win.once("ready-to-show", () => {
    console.log("[handsome-fish] ready-to-show → 显示窗口（不抢焦点）");
    win.showInactive();
    if (process.argv.includes("--devtools")) win.webContents.openDevTools({ mode: "detach" });
  });

  /* 页面加载失败要能看见，否则表现就是"启动了什么都没有" */
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error(`[handsome-fish] 页面加载失败 code=${code} desc=${desc} url=${url}`);
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    console.error("[handsome-fish] 渲染进程终止:", details);
  });

  win.on("closed", () => {
    win = null;
  });
}

/* ---------------------------------------------------------------------------
   桥：渲染页报「鼠标在不在角色上」，这里据此开关点击穿透
   --------------------------------------------------------------------------- */
let interactive = false;

ipcMain.on(CHANNEL, (_event, msg) => {
  if (!win || win.isDestroyed()) return;

  if (msg.type === "hover") {
    const want = msg.on === true;
    if (want === interactive) return;
    interactive = want;
    /* 鼠标进到角色/菜单/气泡上 → 正常接收点击；离开 → 立刻恢复穿透 */
    win.setIgnoreMouseEvents(!want, want ? undefined : { forward: true });
    return;
  }

  if (msg.type === "quit") {
    app.quit();
    return;
  }

  if (msg.type === "ready") {
    /* 角色就绪：确认窗口仍是穿透姿态（热重载后可能残留上一条状态） */
    interactive = false;
    win.setIgnoreMouseEvents(true, { forward: true });
    console.log(`[handsome-fish] 渲染页就绪 v${msg.version || "?"}（carrier=${msg.carrier || "?"}）`);
  }
});

/* ---------------------------------------------------------------------------
   生命周期
   --------------------------------------------------------------------------- */
if (!app.requestSingleInstanceLock()) {
  /* 桌宠不允许开两只，否则会叠在一起还抢鼠标。
     但在某些受限环境里这个锁拿不到（依赖命名对象）；这里明确打日志，
     免得出现"启动后静默退出、什么都没有"这种没法排查的现象。 */
  console.log("[handsome-fish] 单实例锁未获取到（可能已有实例在跑，或环境限制），本次启动退出");
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win && !win.isDestroyed()) {
      win.setAlwaysOnTop(true, "screen-saver");
      win.showInactive();
    }
  });

  app.whenReady().then(() => {
    console.log("[handsome-fish] DSH 状态路由:", EVENTS_URL || "(未解析到，桌面窗将没有结束音)");
    createWindow();

    /* 轮询放主进程：页面是 file:// 源，自己发不出跨协议请求（实测 Failed to fetch） */
    if (EVENTS_URL) {
      turnWatcher = createTurnWatcher({
        url: EVENTS_URL,
        onTurnEnd: (payload) => {
          if (!win || win.isDestroyed()) return;
          win.webContents.send(TURN_CHANNEL, {
            seq: typeof payload?.seq === "number" ? payload.seq : null,
            at: typeof payload?.at === "number" ? payload.at : null,
          });
        },
        log: (message) => console.log("[handsome-fish] " + message),
        /* 一轮进行中 → 桌面窗里的小蓝也在"认真工作"。
           桌面窗是独立的透明窗口、没有键盘焦点，收不到键盘事件，只能靠这个。 */
        onBusyChange: (busy) => {
          if (!win || win.isDestroyed()) return;
          win.webContents.send(BUSY_CHANNEL, busy === true);
        },
      });
      turnWatcher.start();
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("will-quit", () => {
    if (turnWatcher) turnWatcher.stop();
  });

  /* 无边框无任务栏，靠菜单里的「退出挂件」或 Ctrl+C 结束；这里兜住窗口全关的情况 */
  app.on("window-all-closed", () => {
    app.quit();
  });
}
