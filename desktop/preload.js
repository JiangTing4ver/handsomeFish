/**
 * handsomeFish 桌面级外壳 · preload
 * =============================================================================
 * 做两件事：
 *   1. 把渲染页里的消息转成 IPC 送到主进程（点击穿透 / 退出）；
 *   2. 把「DSH 状态路由的绝对地址」交给渲染页 —— 桌面窗是 file:// 源，
 *      相对路径取不到 DSH 的 HTTP 路由，必须由外壳给绝对地址。
 *
 * contextIsolation: true，只暴露一个函数与一份只读配置，页面拿不到 Node 能力。
 */
const { contextBridge, ipcRenderer } = require("electron");

const CHANNEL = "handsome-fish:bridge";

/* ---------------------------------------------------------------------------
   配置：主进程通过 additionalArguments 传进来（避免 preload 里再做一次 IPC 往返）
   --------------------------------------------------------------------------- */
const PREFIX = "--hf-events-url=";
const arg = process.argv.find((a) => a.startsWith(PREFIX));
const eventsUrl = arg ? arg.slice(PREFIX.length) : "";

contextBridge.exposeInMainWorld("handsomeFishConfig", {
  /** 绝对地址，例如 http://127.0.0.1:43120/dsh-handsome-fish/events.json；取不到时为 "" */
  eventsUrl,
  platform: process.platform,
});

contextBridge.exposeInMainWorld("handsomeFishBridge", (msg) => {
  /* 只转发普通对象，且只允许主进程认识的几个 type，避免页面把任意东西塞进 IPC */
  if (!msg || typeof msg !== "object") return;
  const type = typeof msg.type === "string" ? msg.type : "";
  if (type !== "ready" && type !== "hover" && type !== "quit") return;
  ipcRenderer.send(CHANNEL, {
    type,
    on: msg.on === true,
    version: typeof msg.version === "string" ? msg.version : "",
    carrier: typeof msg.carrier === "string" ? msg.carrier : "",
  });
});

/* ---------------------------------------------------------------------------
   「一轮对话结束」：轮询在主进程（Node 侧）做，这里只把结果转交给页面。
   —— 页面自己发不出这个请求：Chromium 禁止 file:// 页面 fetch http://。
   --------------------------------------------------------------------------- */
const TURN_CHANNEL = "handsome-fish:turn-end";

contextBridge.exposeInMainWorld("handsomeFishTurns", {
  subscribe(onTurnEnd) {
    if (typeof onTurnEnd !== "function") return () => {};
    const listener = (_event, payload) => {
      try {
        onTurnEnd(payload || null);
      } catch (error) {
        /* 页面里的回调抛错不能影响 IPC 通道 */
      }
    };
    ipcRenderer.on(TURN_CHANNEL, listener);
    return () => ipcRenderer.removeListener(TURN_CHANNEL, listener);
  },
});


