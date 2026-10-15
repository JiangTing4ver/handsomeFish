/**
 * dsh-handsome-fish — host 半侧（Node / Cordis 组合树）
 * =============================================================================
 * 职责刻意做到最小：只把「一轮对话结束」这件事计数，并通过一条只读 HTTP 路由
 * 暴露给 client 半侧轮询，用来触发「任务结束音」。
 *
 * 挂件的装饰、互动、拖拽、台词、音效合成 100% 在 client 半侧（lib/client.js），
 * 所以：
 *   · 没有 webServer 的组合（纯 CLI 等）里，挂件照常工作，只是没有结束音；
 *   · 任何异常都被吞掉，绝不允许影响 harness 启动。
 *
 * 已核实的两处平台 API（本机 0.2.0-rc.2 源码为准）：
 *   1. 会话事件流：`ctx.on('session/event', (session, event) => …)`
 *      签名见 @deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js
 *      → `'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void`
 *      事件类型枚举见 @deepseek-ai/dsh-session/lib/types/known-event-types.js（含 turn/start、turn/end）
 *   2. 路由注册：`ctx.webServer.register({ kind, path, handler })`，
 *      handler 自己持有响应（req/res 即 node:http 原生对象），返回 disposer。
 *      见 @deepseek-ai/dsh-host-webserver/lib/index.js 的 register()
 *      组合方式沿用真实插件写法：ctx.inject(['webServer'], …) + ctx.effect(…)
 *      （参考 dsh-client-modules/lib/index.js:546-552、dshmarket/lib/index.js:93）
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extname, resolve, sep } from "node:path";

/*
 * 角色原画：主机侧把本地 assets/ 通过一条**只读前缀路由**发出去。
 *
 * 为什么必须由主机侧发：DSH 页面是 http://127.0.0.1:<port>，**读不到 file:// 的图**；
 * 而作者原画属于第三方素材、我们刻意不提交进仓库，所以图只能待在用户的本地磁盘上。
 * 于是：图留在 assets/（.gitignore），按请求读盘发出 —— 既不占包体积、也不入库。
 *
 * 与 client 半侧的契约：client 去 GET `<ART_PREFIX>/art-manifest.json` 拿到
 * 「状态 → 文件名」的映射，再去 GET `<ART_PREFIX>/<文件名>` 取图。
 * 两者都拿不到时（比如全新克隆里 assets/ 是空的），client 自动退回内置程序化 SVG。
 */
const ART_PREFIX = "/dsh-handsome-fish/art";
/**
 * 素材目录。惰性解析，且允许用 HF_ASSETS_DIR 覆盖：
 *   · 自检可以把它指到 scripts/fixtures/，从而不依赖（不入库的）assets/ 是否存在；
 *   · 用户也可以把原画放在别处。
 */
let assetsDirCache;
function assetsDir() {
  if (assetsDirCache !== undefined) return assetsDirCache;
  try {
    assetsDirCache = process.env.HF_ASSETS_DIR
      ? resolve(process.env.HF_ASSETS_DIR)
      : resolve(fileURLToPath(new URL("../assets/", import.meta.url)));
  } catch (_) {
    assetsDirCache = null;
  }
  return assetsDirCache;
}
const ART_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  /* 清单（状态 → 文件名）走同一条路由，所以 json 也要能发 */
  ".json": "application/json; charset=utf-8",
};
/** 只接受"纯文件名"：不含路径分隔符、控制字符与 Windows 保留字符。 */
const SAFE_FILE_NAME = /^[^\\/:*?"<>|\u0000-\u001f]+$/;

/**
 * 发一张本地原画。安全上有两道锁：
 *   1. 文件名必须匹配 SAFE_FILE_NAME（挡掉 ../ 与盘符）
 *   2. 拼接并 resolve 之后的绝对路径必须仍在 assets 目录内（挡掉编码变形等漏网情况）
 */
function serveArt(req, res) {
  const common = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache" };
  const fail = (code, msg) => {
    res.writeHead(code, Object.assign({ "Content-Type": "text/plain; charset=utf-8" }, common));
    res.end(msg);
  };
  try {
    const method = req.method || "GET";
    if (method !== "GET" && method !== "HEAD") return fail(405, "method-not-allowed");
    const dir = assetsDir();
    if (!dir || !existsSync(dir)) return fail(404, "no local assets dir");

    let name = "";
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      name = decodeURIComponent(url.pathname.slice(ART_PREFIX.length).replace(/^\/+/, ""));
    } catch (_) {
      /* 解析失败就交给下面的校验拒掉 */
    }
    if (!name || !SAFE_FILE_NAME.test(name)) return fail(400, "bad file name");

    const abs = resolve(dir, name);
    if (abs !== dir && !abs.startsWith(dir + sep)) return fail(403, "forbidden");

    let st;
    try {
      st = statSync(abs);
    } catch (_) {
      return fail(404, "not found");
    }
    if (!st.isFile()) return fail(404, "not a file");
    const mime = ART_MIME[extname(abs).toLowerCase()];
    if (!mime) return fail(415, "unsupported type");

    res.writeHead(200, Object.assign({ "Content-Type": mime, "Content-Length": String(st.size) }, common));
    if (method === "HEAD") return res.end();
    createReadStream(abs).pipe(res);
  } catch (error) {
    try {
      res.destroy();
    } catch (_) {
      /* ignore */
    }
  }
}

/** 自进程启动以来的「一轮对话结束」计数；client 半侧只关心它是否增长。 */
let turnEndSeq = 0;/** 上一次计数时间，用于合并密集事件（子代理收尾、多会话同时结束）。 */
let lastTurnEndAt = 0;
/** 合并窗口（毫秒）：窗口内的重复 turn/end 只算一次，避免音效连响。 */
const COALESCE_MS = 1200;
/** 最近一次结算的轮次信息（仅用于诊断，不吐给前端）。 */
let lastTurn = null;

/**
 * 这些结束原因属于「簿记 / 崩溃恢复」，不是用户感知的一轮完成，不触发提示音：
 *   forked      —— 会话 fork 时为开放轮次补的收尾
 *   interrupted —— 硬中断后用修复逻辑补的收尾
 * 取值来源：api-catalog 的 TurnEndReasonMap
 * （completed / aborted / blocked / error / max-tokens / interrupted / forked）
 */
const SILENT_REASONS = { forked: true, interrupted: true };

const ROUTE_PATH = "/dsh-handsome-fish/events.json";

/**
 * 路由被请求的次数。唯一用途是诊断：它能直接回答「前端到底有没有在轮询」这个
 * 光看代码答不出来的问题 —— 页面刷新后 hits 会持续增长，没增长就说明 client
 * 半侧没跑起来（或 fetch 被载体拦了）。
 */
let hits = 0;

/** 与真实插件保持一致的 JSON 响应头（大写形态，便于跨源读取）。 */
const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
};

export function apply(ctx) {
  /* ---------------------------------------------------------------------
     1. 订阅会话事件流
        · session/event 是 Cordis 事件（不是服务方法），因此不需要 inject；
        · 带 { global: true } 绕开 dsh-scope 的 scope 过滤，保证收全所有会话
          （真实插件 dsh-cost-meter 就是这么写的）。
     --------------------------------------------------------------------- */
  try {
    const onSessionEvent = (session, event) => {
      try {
        if (!event || event.type !== "turn/end") return;
        const data = event.data || {};
        const reason = data.reason && data.reason.kind ? String(data.reason.kind) : "";
        lastTurn = {
          turn: typeof data.turn === "number" ? data.turn : null,
          reason,
          at: Date.now(),
        };
        if (SILENT_REASONS[reason]) return;
        const now = Date.now();
        if (now - lastTurnEndAt < COALESCE_MS) return;
        lastTurnEndAt = now;
        turnEndSeq += 1;
      } catch (error) {
        /* 单个事件处理失败不能影响宿主 */
        try {
          console.warn("[handsome-fish] turn/end handler failed:", error);
        } catch (_) {
          /* ignore */
        }
      }
    };
    ctx.on("session/event", onSessionEvent, { global: true });
  } catch (error) {
    try {
      console.warn("[handsome-fish] cannot subscribe to session/event:", error);
    } catch (_) {
      /* ignore */
    }
  }

  /* ---------------------------------------------------------------------
     2. 注册只读路由（webServer 缺席时静默跳过）
     --------------------------------------------------------------------- */
  try {
    ctx.inject(["webServer"], (webCtx) => {
      webCtx.effect(
        () =>
          webCtx.webServer.register({
            kind: "exact",
            path: ROUTE_PATH,
            handler: (req, res) => {
              try {
                hits += 1;
                const method = req.method || "GET";
                if (method !== "GET" && method !== "HEAD") {
                  res.writeHead(405, JSON_HEADERS);
                  res.end(JSON.stringify({ ok: false, error: "method-not-allowed" }));
                  return;
                }
                /* 只暴露计数与时间，不含任何会话内容、标题或凭据 */
                const body = JSON.stringify({
                  ok: true,
                  seq: turnEndSeq,
                  at: lastTurnEndAt,
                  hits,
                });
                res.writeHead(200, Object.assign({}, JSON_HEADERS, {
                  "Content-Length": Buffer.byteLength(body).toString(),
                }));
                res.end(method === "HEAD" ? undefined : body);
              } catch (error) {
                try {
                  res.destroy();
                } catch (_) {
                  /* ignore */
                }
              }
            },
          }),
        "handsome-fish: turn-end events route",
      );

      /* 本地原画路由（前缀）：assets/ 里的图按请求读盘发出，不入库、不占包体积。
         必须留在 inject 回调**内部** —— webCtx 只在这个作用域里存在。 */
      try {
        webCtx.effect(
          () => webCtx.webServer.register({ kind: "prefix", path: ART_PREFIX, handler: serveArt }),
          "handsome-fish: local art route",
        );
      } catch (error) {
        try {
          console.warn("[handsome-fish] cannot register art route:", error);
        } catch (_) {
          /* ignore */
        }
      }
    });
  } catch (error) {
    try {
      console.warn("[handsome-fish] cannot register events route:", error);
    } catch (_) {
      /* ignore */
    }
  }
}

/** 供测试/诊断使用：当前计数。 */
export function turnEndCount() {
  return turnEndSeq;
}
