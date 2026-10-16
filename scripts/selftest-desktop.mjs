#!/usr/bin/env node
/**
 * handsomeFish 桌面载体自检
 * =============================================================================
 * 不需要装 Electron：用 headless Chrome/Edge 加载 desktop/renderer.html?selftest=1，
 * 页面把断言结果同时写进 DOM 和 stderr 的 HF-SELFTEST 行，这里抓 stderr。
 *
 * 两个实现细节是刻意的：
 *   · 用 .mjs 而不是 .ps1 —— Windows 默认执行策略会拦未签名的 .ps1；
 *   · 子进程的 stderr 直接接到一个**文件描述符**，不走管道 —— 受限沙箱里
 *     带管道的 stdio 会 EPERM，接 fd 不受影响。
 *
 * 用法：node scripts/selftest-desktop.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, openSync, closeSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, homedir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 解析 DSH 宿主的 base URL，和 desktop/main.js 用同一套三级来源。
 * 拿到它之后，自检会额外去 fetch 一次真实的状态路由 —— 这是「桌面窗里有没有结束音」
 * 的决定性证据：桌面窗是 file:// 源，能不能跨到 http://127.0.0.1 是必须实测的。
 */
function resolveDshBase() {
  const env = process.env.DSH_WEB_URL;
  if (typeof env === "string" && /^https?:\/\//i.test(env)) return env.replace(/\/+$/, "");
  try {
    const file = join(homedir(), ".dsh", "mobile-access", "setup.json");
    if (existsSync(file)) {
      const origin = JSON.parse(readFileSync(file, "utf8"))?.upstreamOrigin;
      if (typeof origin === "string" && /^https?:\/\//i.test(origin)) return origin.replace(/\/+$/, "");
    }
  } catch {
    /* ignore */
  }
  return "";
}

const dshBase = resolveDshBase();
const eventsUrl = dshBase ? `${dshBase}/dsh-handsome-fish/events.json` : "";

/* 带 ?art= 跑：角色现在**只有图片这一条路**（内置手画线稿已按用户要求删除），
   所以主动指一张已入库的自检图，把「素材能不能真的解码」+「file:// 相对路径能不能解析」
   都覆盖掉。用的是 scripts/fixtures/art-4x3.png：我们自己画的 4:3 透明底小图（可入库）。
   注意别改成 assets/ 下那些试验品 —— 它们派生自第三方参考图，不入库，全新克隆里不存在。
   （原先还带 ?svg=1 强制走内置线稿来保证"确定性路径"；线稿删除后那个开关已一并移除。） */
const TEST_ART = "../scripts/fixtures/art-4x3.png";

const PAGE =
  "file:///" +
  join(ROOT, "desktop", "renderer.html").replace(/\\/g, "/") +
  "?selftest=1" +
  "&art=" + encodeURIComponent(TEST_ART) +
  (eventsUrl ? "&events=" + encodeURIComponent(eventsUrl) : "");

const CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

const browser = CANDIDATES.find((p) => p && existsSync(p));
if (!browser) {
  console.error("找不到 Chrome / Edge，无法自检。");
  process.exit(1);
}

const logPath = join(tmpdir(), `hf-selftest-${Date.now()}.log`);
const shotPath = join(tmpdir(), `hf-selftest-${Date.now()}.png`);
/**
 * 每次用**独立的浏览器 profile**：桌面外壳与 preview 都是 file:// 源、共用同一份
 * localStorage，自检里 setArt("") 会清掉真实存档 —— 测试不该动用户的设置。
 * 而且**每个页面各自一份**（见 runPageWithRetry）：否则第①步里下拉测试存下的画风
 * 会漏到第③步，让"作者原画"那条断言误报失败 —— 测试之间不该通过存档串味。
 */

const MIGRATION_PAGE =
  "file:///" + join(ROOT, "scripts", "fixtures", "store-migration-test.html").replace(/\\/g, "/");

const AUTHOR_ART_PAGE =
  "file:///" + join(ROOT, "scripts", "fixtures", "author-art-test.html").replace(/\\/g, "/");

console.log(`浏览器: ${browser}`);
console.log(`页面:   ${PAGE}\n`);

/**
 * 跑一次 Chrome 并取回匹配前缀的行。
 * 为什么要容忍重试：headless Chrome 多实例并发时会偶发地什么都不输出
 * （实测过一次：同时还在跑生成对比图的 Chrome，自检那次抓到 0 行而误报失败）。
 * 验证工具自己不可靠是最糟的情况，所以只在两次都空时才判失败。
 */
function runChrome(fd, page, profileDir) {
  try {
    /* stdio 的 stderr 直接接到文件描述符，不建管道 —— 受限沙箱里带管道的 stdio 会 EPERM */
    spawnSync(
      browser,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--hide-scrollbars",
        `--user-data-dir=${profileDir}`,
        "--window-size=900,600",
        "--virtual-time-budget=3000",
        "--enable-logging=stderr",
        "--v=0",
        `--screenshot=${shotPath}`,
        page,
      ],
      { stdio: ["ignore", fd, fd], timeout: 90_000 },
    );
  } catch {
    /* 超时/启动失败都交给调用方判断 */
  }
}

function readLines(prefix) {
  return readFileSync(logPath, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes(prefix))
    .map((l) => l.slice(l.indexOf(prefix)).replace(/", source:.*$/, ""));
}

/** 带一次重试地跑一个页面，返回它打印的标记行。**每个页面各自一份临时 profile**（互不串味） */
function runPageWithRetry(page, prefix) {
  const profileDir = join(
    tmpdir(),
    `hf-selftest-profile-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  );
  let out = [];
  let raw = "";
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      rmSync(logPath, { force: true });
      const fd = openSync(logPath, "w");
      try {
        runChrome(fd, page, profileDir);
      } finally {
        closeSync(fd);
      }
      raw = readFileSync(logPath, "utf8");
      out = readLines(prefix);
      if (out.length > 0) break;
      if (attempt === 1) console.log("(第一次没抓到输出，重试一次…)\n");
    }
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }
  return { lines: out, raw };
}

let status = 1;

/* ---------- ① 桌面载体自检 ---------- */
const main = runPageWithRetry(PAGE, "HF-SELFTEST");
const lines = main.lines;
if (lines.length === 0) {
  console.error("没抓到 HF-SELFTEST —— 页面可能没加载起来。日志尾部：");
  console.error(main.raw.split(/\r?\n/).slice(-15).join("\n"));
} else {
  for (const l of lines) console.log(l.replace(/^HF-SELFTEST\| /, "  ").replace(/^HF-SELFTEST /, ">> "));
  status = lines.some((l) => l.startsWith("HF-SELFTEST OK")) ? 0 : 1;
  console.log("");
  console.log(status === 0 ? "桌面载体自检通过。" : "桌面载体自检失败。");
}

/* ---------- ② 存档迁移回归测试（代码默认值 vs 用户显式选择）---------- */
const mig = runPageWithRetry(MIGRATION_PAGE, "HF-MIG");
console.log("");
if (mig.lines.length === 0) {
  console.error("没抓到 HF-MIG —— 迁移测试页没加载起来。");
  status = 1;
} else {
  for (const l of mig.lines) console.log("  " + l);
  const ok = mig.lines.some((l) => l.endsWith("verdict=PASS"));
  console.log(ok ? "存档迁移测试通过。" : "存档迁移测试失败。");
  if (!ok) status = 1;
}

/* ---------- ③ 作者原画清单（按状态换原画）---------- */
const artPass = runPageWithRetry(AUTHOR_ART_PAGE, "HF-ART");
console.log("");
if (artPass.lines.length === 0) {
  console.error("没抓到 HF-ART —— 作者原画测试页没加载起来。");
  status = 1;
} else {
  for (const l of artPass.lines) console.log("  " + l);
  const artOk = artPass.lines.some((l) => l.endsWith("verdict=PASS"));
  console.log(artOk ? "作者原画清单测试通过。" : "作者原画清单测试失败。");
  if (!artOk) status = 1;
}

rmSync(logPath, { force: true });
rmSync(shotPath, { force: true });
process.exit(status);
