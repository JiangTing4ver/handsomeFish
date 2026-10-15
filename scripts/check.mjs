#!/usr/bin/env node
/**
 * handsomeFish 静态自检 —— 在安装/重启之前，把能静态查出来的坑全查掉。
 *
 * 对应 dsh-bg-tech 笔记里那张踩坑清单的「可静态检测」项：
 *   #1 client bundle 必须是经典脚本（写 ESM export 会让整个 harness 启动失败）
 *   #2 file: 是复制不是链接（这里检查 junction，安装脚本用 junction 规避）
 *   #6 cordis.patch.yml 必须是顶层数组，且插入的 name 要和 package.json 的 name 一致
 *   #7 新增 bundle 必须重启 profile（安装脚本会提醒）
 *
 * 用法：node scripts/check.mjs
 */
import { readFileSync, existsSync, lstatSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";
import os from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
let failed = 0;

function check(label, fn) {
  try {
    results.push({ ok: true, label, detail: String(fn() ?? "") });
  } catch (error) {
    failed += 1;
    results.push({ ok: false, label, detail: error.message });
  }
}

/** 需要 await 的检查（例如要真的等一个合并窗口过去） */
async function checkAsync(label, fn) {
  try {
    results.push({ ok: true, label, detail: String((await fn()) ?? "") });
  } catch (error) {
    failed += 1;
    results.push({ ok: false, label, detail: error.message });
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

const pkgPath = join(ROOT, "package.json");
const clientPath = join(ROOT, "lib", "client.js");
const hostPath = join(ROOT, "lib", "index.js");
const patchPath = join(ROOT, "cordis.patch.yml");

/* ------------------------------------------------------------ 1. 文件齐备 */
check("关键文件齐备", () => {
  const missing = [pkgPath, clientPath, hostPath, patchPath].filter((p) => !existsSync(p));
  assert(missing.length === 0, `缺少：${missing.join(", ")}`);
  return "package.json / lib/index.js / lib/client.js / cordis.patch.yml";
});

/* -------------------------------------------------------- 2. package.json */
let pkg = null;
check("package.json 结构", () => {
  pkg = readJson(pkgPath);
  assert(typeof pkg.name === "string" && pkg.name, "name 缺失");
  assert(pkg.type === "module", "type 必须是 'module'（host 半侧是 ESM）");
  assert(pkg.dsh?.bundle?.patch, "缺少 dsh.bundle.patch");
  assert(existsSync(join(ROOT, pkg.dsh.bundle.patch)), `dsh.bundle.patch 指向的文件不存在：${pkg.dsh.bundle.patch}`);
  assert(pkg.dsh?.client?.platform === "web", "dsh.client.platform 必须是 'web'");
  assert(Array.isArray(pkg.dsh.client.inject), "dsh.client.inject 必须是数组");
  assert(pkg.exports?.["./client"], "exports 缺少 './client' —— client-modules 靠它找浏览器 bundle");
  assert(existsSync(join(ROOT, pkg.exports["./client"])), `'./client' 指向的文件不存在：${pkg.exports["./client"]}`);
  return `${pkg.name}@${pkg.version}`;
});

/* --------------------- 3. client bundle 必须能被当作「经典脚本」解析（最关键） */
check("lib/client.js 是合法经典脚本（无 ESM export/import）", () => {
  const src = readFileSync(clientPath, "utf8");
  assert(!/^\s*(export|import)\s/m.test(src), "出现 ESM export/import —— 会导致整个 harness 启动失败");
  /* vm.Script 强制按经典脚本解析：比 `node --check`（受 type:module 影响）更严格 */
  new vm.Script(src, { filename: "lib/client.js" });
  assert(src.includes("window.__ModuleLoader__.load"), "没有 window.__ModuleLoader__.load 注册调用");
  return `${(src.length / 1024).toFixed(1)} KB，经典脚本解析通过`;
});

/* --------------------------------------- 4. 注册 id 必须等于包名（模块身份） */
check("ModuleLoader 注册 id 与包名一致", () => {
  const src = readFileSync(clientPath, "utf8");
  const m = /__ModuleLoader__\.load\(\s*\{\s*id:\s*["']([^"']+)["']/.exec(src);
  assert(m, "无法解析注册 id");
  assert(m[1] === pkg.name, `注册 id "${m[1]}" ≠ 包名 "${pkg.name}"`);
  return m[1];
});

/* ---------------------------------- 5. client bundle 必须自带容错（不影响宿主） */
check("client bundle 有幂等与错误兜底", () => {
  const src = readFileSync(clientPath, "utf8");
  assert(/getElementById\(ROOT_ID\)\)\s*return/.test(src), "缺少幂等保护（重复注入会叠出多只鱼）");
  assert(/catch\s*\(err\)/.test(src), "缺少顶层 try/catch 兜底");
  assert(/exports\.apply\s*=/.test(src) && /exports\.inject\s*=/.test(src), "缺少 exports.apply / exports.inject");
  return "幂等 + 顶层 catch + exports 齐备";
});

/* -------------------------------- 6. cordis.patch.yml 必须是顶层数组、名字对得上 */
check("cordis.patch.yml 是顶层数组且插入项与包名一致", () => {
  const raw = readFileSync(patchPath, "utf8");
  const meaningful = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
  assert(meaningful.length > 0, "有效内容为空 —— 会解析成 null 并导致启动报错");
  assert(
    meaningful.some((l) => /^-\s/.test(l)),
    "第一层没有 '- ' 开头的条目 —— 必须是顶层 YAML 数组",
  );
  assert(
    meaningful.some((l) => /^name:\s*['"]?/.test(l) || /^-\s*name:/.test(l)),
    "没有找到 name 字段",
  );
  assert(raw.includes(pkg.name), `文件里没有出现包名 "${pkg.name}"`);
  return "顶层数组 + insert 条目 OK";
});

/* ------------------------------------------- 7. host 半侧真的能作为 ESM 加载 */
let hostModule = null;
try {
  hostModule = await import(pathToFileURL(hostPath).href);
  check("lib/index.js 可作为 ESM 加载", () => {
    assert(typeof hostModule.apply === "function", "缺少 export function apply");
    assert(typeof hostModule.turnEndCount === "function", "缺少 export turnEndCount");
    assert(hostModule.turnEndCount() === 0, "模块顶层不应产生计数副作用");
    return "apply/turnEndCount 就绪，无顶层副作用";
  });
} catch (error) {
  failed += 1;
  results.push({ ok: false, label: "lib/index.js 可作为 ESM 加载", detail: error.message });
}

/* ------------------------------------------- 8. host 半侧的 apply 能安全空跑 */
check("host apply 在无 webServer 的组合里安全空跑", () => {
  const listeners = [];
  const stub = {
    on(name, fn) {
      listeners.push(name);
      return () => {};
    },
    inject(names, cb) {
      /* webServer 缺席：回调不应被调用 */
      void names;
      void cb;
      return () => {};
    },
  };
  hostModule.apply(stub);
  assert(listeners.includes("session/event"), "没有订阅 session/event");
  return "订阅 session/event；无 webServer 时不抛错";
});

/* --------------------------------- 9. host 半侧端到端逻辑（事件→计数→路由） */
const hostHarness = (() => {
  const captured = { listeners: [], routes: [], effects: [], injects: [] };
  const stubCtx = {
    on(name, cb, opts) {
      captured.listeners.push({ name, cb, opts });
      return () => {};
    },
    inject(names, cb) {
      captured.injects.push(names);
      const webCtx = {
        effect(fn, label) {
          captured.effects.push(label);
          fn();
          return () => {};
        },
        webServer: {
          register(route) {
            captured.routes.push(route);
            return () => {};
          },
        },
      };
      cb(webCtx);
      return () => {};
    },
  };
  hostModule.apply(stubCtx);
  return captured;
})();

check("host 半侧：订阅 session/event 且带 global", () => {
  const sub = hostHarness.listeners.find((l) => l.name === "session/event");
  assert(sub, "没有订阅 session/event");
  assert(sub.opts && sub.opts.global === true, "缺少 { global: true }，可能被 scope 过滤漏事件");
  return "session/event + { global: true }";
});

check("host 半侧：路由挂在 inject(['webServer']) 的作用域里", () => {
  assert(
    hostHarness.injects.some((n) => n.includes("webServer")),
    "没有用 ctx.inject(['webServer'], …) 局部等待服务",
  );
  const route = hostHarness.routes[0];
  assert(route, "没有注册任何路由");
  assert(route.kind === "exact", `kind 应为 exact，实际 ${route.kind}`);
  assert(route.path === "/dsh-handsome-fish/events.json", `路径不对：${route.path}`);
  assert(typeof route.handler === "function", "handler 不是函数");
  return `${hostHarness.effects[0] || "route"}`;
});

await checkAsync("host 半侧：turn/end → 计数递增（含合并与静默原因）", async () => {
  const sub = hostHarness.listeners.find((l) => l.name === "session/event");
  const fire = (reason) => sub.cb({ id: "s1" }, { type: "turn/end", data: { turn: 1, reason: { kind: reason } } });

  const before = hostModule.turnEndCount();
  fire("completed");
  const afterFirst = hostModule.turnEndCount();
  assert(afterFirst === before + 1, `completed 应 +1：${before} → ${afterFirst}`);

  /* 合并窗口内再来一次，不应重复计数 */
  fire("completed");
  assert(hostModule.turnEndCount() === afterFirst, "1200ms 合并窗口没有生效");

  /* 簿记类原因应被过滤 */
  fire("forked");
  fire("interrupted");
  assert(hostModule.turnEndCount() === afterFirst, "forked/interrupted 应被静默过滤");

  /* 非 turn/end 事件完全不受影响 */
  sub.cb({ id: "s1" }, { type: "assistant/message", data: {} });
  assert(hostModule.turnEndCount() === afterFirst, "非 turn/end 事件不应计数");

  /* 越过合并窗口后应再次递增（这一步会真的等 1.25 秒） */
  await new Promise((r) => setTimeout(r, 1250));
  fire("completed");
  assert(hostModule.turnEndCount() === afterFirst + 1, "越过合并窗口后没有递增");

  return `${before} → ${hostModule.turnEndCount()}（合并窗口与静默原因均生效）`;
});

await checkAsync("host 半侧：路由返回合法 JSON 且只读", async () => {
  const route = hostHarness.routes[0];
  const call = (method) => {
    const res = {
      status: null,
      headers: null,
      body: null,
      writeHead(code, headers) {
        this.status = code;
        this.headers = headers;
      },
      end(body) {
        this.body = body;
      },
      destroy() {},
    };
    route.handler({ method, url: route.path }, res);
    return res;
  };

  const ok = call("GET");
  assert(ok.status === 200, `GET 应 200，实际 ${ok.status}`);
  const payload = JSON.parse(ok.body);
  assert(payload.ok === true && typeof payload.seq === "number", `载荷形状不对：${ok.body}`);
  assert(
    String(ok.headers["Content-Type"]).includes("application/json"),
    "Content-Type 不是 application/json",
  );
  assert(ok.headers["Access-Control-Allow-Origin"] === "*", "缺少 CORS 头");
  /* 只读：不暴露会话内容/标题/凭据。允许的字段是白名单，多一个都要显式改这里 */
  const ALLOWED = "at,hits,ok,seq";
  assert(
    Object.keys(payload).sort().join(",") === ALLOWED,
    `不应暴露白名单外的字段：${Object.keys(payload).join(",")}（白名单 ${ALLOWED}）`,
  );
  assert(typeof payload.hits === "number" && payload.hits >= 1, "hits 应是递增的请求计数");

  const bad = call("POST");
  assert(bad.status === 405, `写方法应 405，实际 ${bad.status}`);

  const head = call("HEAD");
  assert(head.status === 200 && head.body === undefined, "HEAD 不应带 body");

  return `GET 200 {ok,seq,at} · POST 405 · HEAD 200 空体`;
});

/* ---------------- 10. 桌面外壳的轮次监视器（纯 Node 逻辑，可脱离 Electron 单测） */
await checkAsync("桌面外壳轮次监视器：基线 / 递增触发 / 去重", async () => {
  const { createTurnWatcher } = createRequire(import.meta.url)("../desktop/turn-watch.js");

  const seqs = [3, 3, 4, 4, 4, 5];
  let call = 0;
  let tickFn = null;
  const fired = [];
  const logs = [];

  const watcher = createTurnWatcher({
    url: "http://stub/events.json",
    fetchImpl: async () => {
      const seq = seqs[Math.min(call, seqs.length - 1)];
      call += 1;
      return { ok: true, status: 200, json: async () => ({ ok: true, seq }) };
    },
    onTurnEnd: (payload) => fired.push(payload.seq),
    log: (m) => logs.push(m),
    /* 不真的起定时器：把回调抓下来手工驱动 */
    setIntervalImpl: (fn) => {
      tickFn = fn;
      return 1;
    },
    clearIntervalImpl: () => {},
  });

  const flush = () => new Promise((r) => setTimeout(r, 0));

  watcher.start(); /* 第 1 次：seq=3 → 只记基线，不该触发 */
  await flush();
  assert(fired.length === 0, `首次不应触发，实际触发了 ${fired.join(",")}`);

  /* seqs 后续依次是 #1=3 / #2=4 / #3=4 / #4=4 / #5=5 → 只有 4 和 5 是"变大" */
  for (let i = 0; i < 5; i++) {
    tickFn();
    await flush();
  }
  /* seqs 后续依次是 3 / 4 / 4 / 5 → 只有 4 和 5 是"变大" */
  assert(fired.join(",") === "4,5", `应只在 4 与 5 触发，实际 ${fired.join(",")}`);
  assert(logs.some((l) => l.includes("基线 seq=3")), "没有记录基线日志");
  return `基线 3 → 触发 ${fired.join(",")}`;
});

await checkAsync("桌面外壳轮次监视器：连续失败后退避停止", async () => {
  const { createTurnWatcher } = createRequire(import.meta.url)("../desktop/turn-watch.js");

  let tickFn = null;
  const logs = [];
  const watcher = createTurnWatcher({
    url: "http://stub/events.json",
    fetchImpl: async () => {
      throw new Error("boom");
    },
    onTurnEnd: () => {},
    log: (m) => logs.push(m),
    maxFailures: 2,
    setIntervalImpl: (fn) => {
      tickFn = fn;
      return 1;
    },
    clearIntervalImpl: () => {},
  });

  const flush = () => new Promise((r) => setTimeout(r, 0));
  watcher.start();
  await flush();
  tickFn();
  await flush();

  const stats = watcher.stats();
  assert(stats.stopped === true, "连续 2 次失败后应停止轮询（DSH 没在跑时不该一直打请求）");
  assert(
    logs.some((l) => l.includes("已停止轮询")),
    "停止时应有明确日志，否则用户无从判断桌面窗为什么没结束音",
  );
  return `失败 ${stats.failures} 次后停止`;
});

/* --------------------- 11. 文档相对链接可达（防止文档腐烂） */
check("文档相对链接与图片可达", () => {
  const docs = [
    "README.md",
    "desktop/README.md",
    "docs/architecture.md",
    "docs/xiaolan.md",
    "docs/asset-checklist.md",
    "docs/character-spec.md",
  ];
  const broken = [];
  const linkRe = /\[[^\]]*\]\(([^)]+)\)/g; /* 同时匹配 [文字](链接) 与 ![图](路径) */
  for (const rel of docs) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) {
      broken.push(`${rel}（文档本身不存在）`);
      continue;
    }
    for (const m of readFileSync(abs, "utf8").matchAll(linkRe)) {
      const raw = m[1].trim();
      if (/^(https?:|mailto:|#)/i.test(raw)) continue; /* 外链与纯锚点跳过 */
      const target = raw.split("#")[0];
      if (!target) continue;
      const resolved = resolve(dirname(abs), decodeURIComponent(target));
      if (!existsSync(resolved)) broken.push(`${rel} → ${raw}`);
    }
  }
  assert(broken.length === 0, `失效链接：\n      ${broken.join("\n      ")}`);
  return `${docs.length} 份文档，链接与图片全部可达`;
});

/* --------------------------------- 12. desktop profile 安装状态（只报告信息） */
check("desktop profile 安装状态", () => {
  const dir = join(os.homedir(), ".dsh", "profiles", "desktop");
  const profilePkg = join(dir, "package.json");
  if (!existsSync(profilePkg)) throw new Error(`找不到 ${profilePkg}`);
  const profile = readJson(profilePkg);
  const bundles = profile?.dsh?.profile?.bundles ?? [];
  const linkPath = join(dir, "node_modules", pkg.name);

  let link = "未出现在 node_modules";
  if (existsSync(linkPath)) {
    const st = lstatSync(linkPath);
    if (st.isSymbolicLink()) {
      let target = "";
      try {
        target = readlinkSync(linkPath);
      } catch {
        target = "(无法读取目标)";
      }
      link = `symlink → ${target}`;
    } else if (st.isDirectory()) {
      link = "已存在（目录，非链接）";
    }
  }
  const registered = bundles.includes(pkg.name);
  return `${registered ? "已在 bundles" : "未登记 bundles"}；node_modules ${link}`;
});

/* -------------------------------------------------------------------- 输出 */
const pad = Math.max(...results.map((r) => r.label.length));
console.log("\nhandsomeFish 自检\n" + "─".repeat(pad + 28));
for (const r of results) {
  console.log(`${r.ok ? " OK " : "FAIL"}  ${r.label.padEnd(pad)}  ${r.detail}`);
}
console.log("─".repeat(pad + 28));
console.log(failed === 0 ? "全部通过。\n" : `${failed} 项失败。\n`);
process.exit(failed === 0 ? 0 : 1);
