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

/* 带 ?art= 跑：默认形象是内置程序化 SVG，图片通道只有显式指定时才走 ——
   所以自检里主动指一张，把「素材能不能真的解码」这条也覆盖掉。
   （assets/ 里这些是从参考素材转出来的试验品，不是默认形象。） */
const TEST_ART = "../assets/pet-xiaolv.png";

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

console.log(`浏览器: ${browser}`);
console.log(`页面:   ${PAGE}\n`);

/**
 * 跑一次 Chrome 并取回 HF-SELFTEST 行。
 * 为什么要容忍重试：headless Chrome 多实例并发时会偶发地什么都不输出
 * （实测过一次：同时还在跑生成对比图的 Chrome，自检那次抓到 0 行而误报失败）。
 * 验证工具自己不可靠是最糟的情况，所以只在两次都空时才判失败。
 */
function runChrome(fd) {
  try {
    /* stdio 的 stderr 直接接到文件描述符，不建管道 —— 受限沙箱里带管道的 stdio 会 EPERM */
    spawnSync(
      browser,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--window-size=900,600",
        "--virtual-time-budget=3000",
        "--enable-logging=stderr",
        "--v=0",
        `--screenshot=${shotPath}`,
        PAGE,
      ],
      { stdio: ["ignore", fd, fd], timeout: 90_000 },
    );
  } catch {
    /* 超时/启动失败都交给下面的判断 */
  }
}

function readResult() {
  return readFileSync(logPath, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("HF-SELFTEST"))
    .map((l) => l.slice(l.indexOf("HF-SELFTEST")).replace(/", source:.*$/, ""));
}

let lines = [];
let raw = "";
for (let attempt = 1; attempt <= 2; attempt++) {
  rmSync(logPath, { force: true });
  const fd = openSync(logPath, "w");
  try {
    runChrome(fd);
  } finally {
    closeSync(fd);
  }
  raw = readFileSync(logPath, "utf8");
  lines = readResult();
  if (lines.length > 0) break;
  if (attempt === 1) console.log("(第一次没抓到输出，重试一次…)\n");
}
let status = 1;

if (lines.length === 0) {
  console.error("没抓到 HF-SELFTEST —— 页面可能没加载起来。日志尾部：");
  console.error(raw.split(/\r?\n/).slice(-15).join("\n"));
} else {
  for (const l of lines) console.log(l.replace(/^HF-SELFTEST\| /, "  ").replace(/^HF-SELFTEST /, ">> "));
  status = lines.some((l) => l.startsWith("HF-SELFTEST OK")) ? 0 : 1;
  console.log("");
  console.log(status === 0 ? "桌面载体自检通过。" : "桌面载体自检失败。");
}

rmSync(logPath, { force: true });
rmSync(shotPath, { force: true });
process.exit(status);
