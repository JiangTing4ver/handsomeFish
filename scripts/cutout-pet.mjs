#!/usr/bin/env node
/**
 * cutout-pet.mjs —— 把作者原画抠成挂件能用的透明 PNG
 *
 * 为什么需要它：挂件要的是「透明底、单人、4:3 画布」的图，而参考图基本都是
 * 「纯白底 + 角色」。所以不能简单地"把白色变透明" —— 简笔画风格里**角色的头也是白的**，
 * 那样会把头掏空。正确做法是**从图像四边 flood fill**：只有与边缘**连通**的白才算背景，
 * 被黑色描边围住的内部白色（头、躯干）会被保住。
 *
 * 实现要点：
 * - 纯 Node + headless Chrome，无任何图像库依赖（环境里本来就不该装）
 * - 源图以 **data URL** 内嵌进页面：file:// 页面里画 file:// 图会让 canvas 被污染，
 *   getImageData 会抛 SecurityError；data URL 不算跨源，能安全读像素
 * - 像素处理在页面的 canvas 里做，结果用 --default-background-color=00000000 截图导出，
 *   省掉"把几百 KB base64 从浏览器塞回 Node"的脆弱环节
 *
 * 用法：
 *   node scripts/cutout-pet.mjs <源图> <输出.png> [选项]
 *
 * 选项：
 *   --size 1024x768   输出画布（默认 4:3 的 1024x768；也可给 512 得正方形）
 *   --th 232          判定"白"的阈值（0-255，越低越激进；默认 232）
 *   --crop x,y,w,h    先在源图上裁一块（用于去掉气泡/桌面/另一个角色）
 *   --pad 0.05        角色四周留白比例（默认 0.05）
 *   --no-feather      关闭边缘软化（默认开：描边外侧的浅灰像素给半透明，避免锯齿）
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { openSync, closeSync, readFileSync as readFd } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
if (positional.length < 2) {
  console.error("用法: node scripts/cutout-pet.mjs <源图> <输出.png> [--crop x,y,w,h] [--size 1024x768]");
  process.exit(2);
}
const [srcArg, outArg] = positional;
const src = resolve(srcArg);
const out = resolve(outArg);
if (!existsSync(src)) {
  console.error(`源图不存在: ${src}`);
  process.exit(2);
}
function opt(name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
}
function flag(name) {
  return argv.includes(`--${name}`);
}

const sizeArg = String(opt("size", "1024x768"));
let OUT_W;
let OUT_H;
if (/^\d+$/.test(sizeArg)) {
  OUT_W = Number(sizeArg);
  OUT_H = Number(sizeArg);
} else if (/^\d+x\d+$/.test(sizeArg)) {
  [OUT_W, OUT_H] = sizeArg.split("x").map(Number);
} else {
  console.error(`--size 写法不认识：${sizeArg}（应为 1024x768 或 512）`);
  process.exit(2);
}

const CROP = (() => {
  const v = opt("crop", null);
  if (!v) return null;
  const parts = v.split(",").map((n) => Math.round(Number(n)));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    console.error(`--crop 写法不认识：${v}（应为 x,y,w,h）`);
    process.exit(2);
  }
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
})();

const TH = Number(opt("th", 232));
const PAD = Number(opt("pad", 0.05));
const FEATHER = !flag("no-feather");

/* ---------------- 找浏览器 ---------------- */
const CANDIDATES = [
  process.env.HF_CHROME,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];
const browser = CANDIDATES.find((p) => p && existsSync(p));
if (!browser) {
  console.error("找不到 Chrome / Edge。可用 HF_CHROME 环境变量指定路径。");
  process.exit(1);
}

/* ---------------- 生成页面 ---------------- */
const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" }[
  extname(src).toLowerCase()
];
if (!mime) {
  console.error(`不支持的源图格式: ${extname(src)}`);
  process.exit(2);
}
const dataUrl = `data:${mime};base64,${readFileSync(src).toString("base64")}`;

const page = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:${OUT_W}px;height:${OUT_H}px;overflow:hidden;background:transparent}
  canvas{display:block;width:${OUT_W}px;height:${OUT_H}px}
</style></head><body>
<canvas id="c" width="${OUT_W}" height="${OUT_H}"></canvas>
<script>
const OUT_W = ${OUT_W}, OUT_H = ${OUT_H};
const TH = ${TH}, PAD = ${PAD}, FEATHER = ${FEATHER};
const CROP = ${CROP ? JSON.stringify(CROP) : "null"};
const src = new Image();
src.onload = () => { try { run(); } catch (e) { log("FAIL " + e.name + ": " + e.message); } };
src.onerror = () => log("FAIL 源图无法解码");
src.src = ${JSON.stringify(dataUrl)};

function log(s) { console.log("HF-CUT| " + s); }

function run() {
  const sx = CROP ? CROP.x : 0, sy = CROP ? CROP.y : 0;
  const sw = CROP ? CROP.w : src.naturalWidth, sh = CROP ? CROP.h : src.naturalHeight;
  if (sx < 0 || sy < 0 || sx + sw > src.naturalWidth || sy + sh > src.naturalHeight) {
    log("FAIL --crop 超出源图范围（源图 " + src.naturalWidth + "x" + src.naturalHeight + "）");
    return;
  }
  // 先在离屏 canvas 上按源分辨率取像素
  const off = document.createElement("canvas");
  off.width = sw; off.height = sh;
  const octx = off.getContext("2d", { willReadFrequently: true });
  octx.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
  let id;
  try { id = octx.getImageData(0, 0, sw, sh); }
  catch (e) { log("FAIL canvas 被污染（浏览器禁止读像素）: " + e.name); return; }
  const d = id.data;

  /* ---- 1) 从四边 flood fill，把"与边缘连通的白"判为背景 ---- */
  const white = (p) => {
    const i = p * 4;
    return d[i] >= TH && d[i + 1] >= TH && d[i + 2] >= TH;
  };
  const seen = new Uint8Array(sw * sh);
  const stack = [];
  const push = (p) => { if (!seen[p]) stack.push(p); };
  for (let x = 0; x < sw; x++) { push(x); push((sh - 1) * sw + x); }
  for (let y = 0; y < sh; y++) { push(y * sw); push(y * sw + sw - 1); }
  let cleared = 0;
  while (stack.length) {
    const p = stack.pop();
    if (seen[p]) continue;
    seen[p] = 1;
    if (!white(p)) continue;
    d[p * 4 + 3] = 0;
    cleared++;
    const x = p % sw, y = (p - x) / sw;
    if (x > 0) push(p - 1);
    if (x < sw - 1) push(p + 1);
    if (y > 0) push(p - sw);
    if (y < sh - 1) push(p + sw);
  }

  /* ---- 2) 边缘软化：紧邻透明区、且本身偏白的像素按亮度给半透明（抗锯齿过渡）---- */
  if (FEATHER) {
    const a0 = Uint8ClampedArray.from(d);
    const alphaAt = (x, y) => (x < 0 || y < 0 || x >= sw || y >= sh ? 0 : a0[(y * sw + x) * 4 + 3]);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const i = (y * sw + x) * 4;
        if (a0[i + 3] === 0) continue;
        if (alphaAt(x - 1, y) && alphaAt(x + 1, y) && alphaAt(x, y - 1) && alphaAt(x, y + 1)) continue;
        const lum = 0.299 * a0[i] + 0.587 * a0[i + 1] + 0.114 * a0[i + 2];
        if (lum > 150) d[i + 3] = Math.round(255 * (1 - (lum - 150) / 105));
      }
    }
  }

  /* ---- 3) 求角色包围盒 ---- */
  let minX = sw, minY = sh, maxX = -1, maxY = -1, opaque = 0;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (d[(y * sw + x) * 4 + 3] > 8) {
        opaque++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) { log("FAIL 抠完什么都不剩（阈值 " + TH + " 可能太低）"); return; }
  const bw = maxX - minX + 1, bh = maxY - minY + 1;

  /* ---- 4) 等比放进输出画布（4:3），留白 ---- */
  const availW = OUT_W * (1 - PAD * 2), availH = OUT_H * (1 - PAD * 2);
  const scale = Math.min(availW / bw, availH / bh);
  const dw = Math.round(bw * scale), dh = Math.round(bh * scale);
  const dx = Math.round((OUT_W - dw) / 2), dy = Math.round((OUT_H - dh) / 2);

  const c = document.getElementById("c");
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, OUT_W, OUT_H);
  ctx.imageSmoothingQuality = "high";
  // 用 putImageData 恢复处理后的像素，再整体缩放绘制
  const tmp = document.createElement("canvas");
  tmp.width = sw; tmp.height = sh;
  tmp.getContext("2d").putImageData(id, 0, 0);
  ctx.drawImage(tmp, minX, minY, bw, bh, dx, dy, dw, dh);

  const total = sw * sh;
  log("源图 " + src.naturalWidth + "x" + src.naturalHeight +
      (CROP ? " → 裁切 " + sw + "x" + sh + " @" + sx + "," + sy : "") +
      " | 阈值 " + TH + " | 边缘软化 " + (FEATHER ? "开" : "关"));
  log("清掉背景 " + (100 * cleared / total).toFixed(1) + "% | 角色包围盒 " + bw + "x" + bh +
      " @" + minX + "," + minY + " | 不透明 " + (100 * opaque / total).toFixed(1) + "%");
  log("输出 " + OUT_W + "x" + OUT_H + " | 角色绘制 " + dw + "x" + dh + " @" + dx + "," + dy +
      " | 缩放 " + (scale * 100).toFixed(1) + "%");
  log("DONE");
  document.title = "HF-CUT-DONE";
}
</script></body></html>`;

const pagePath = join(tmpdir(), `hf-cut-${Date.now()}.html`);
const logPath = join(tmpdir(), `hf-cut-${Date.now()}.log`);
writeFileSync(pagePath, page, "utf8");
mkdirSync(dirname(out), { recursive: true });
rmSync(out, { force: true });

console.log(`源图:   ${src}`);
console.log(`输出:   ${out}  (${OUT_W}x${OUT_H})`);
console.log(`浏览器: ${browser}\n`);

const fd = openSync(logPath, "w");
try {
  spawnSync(
    browser,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      "--allow-file-access-from-files",
      `--window-size=${OUT_W},${OUT_H}`,
      "--default-background-color=00000000",
      "--virtual-time-budget=15000",
      "--enable-logging=stderr",
      "--v=0",
      `--screenshot=${out}`,
      `file:///${pagePath.replace(/\\/g, "/")}`,
    ],
    { stdio: ["ignore", fd, fd], timeout: 120_000 },
  );
} finally {
  closeSync(fd);
}

const raw = readFd(logPath, "utf8");
const lines = raw
  .split(/\r?\n/)
  .filter((l) => l.includes("HF-CUT|"))
  .map((l) => l.slice(l.indexOf("HF-CUT|") + 7).replace(/", source:.*$/, "").trim());

for (const l of lines) console.log("  " + l);

if (!lines.some((l) => l === "DONE")) {
  console.error("\n抠图失败（页面没跑到 DONE）。Chrome 日志尾部：");
  console.error(raw.split(/\r?\n/).slice(-14).join("\n"));
  rmSync(pagePath, { force: true });
  rmSync(logPath, { force: true });
  process.exit(1);
}

if (!existsSync(out)) {
  console.error("\n像素处理成功，但截图没写出来。Chrome 日志尾部：");
  console.error(raw.split(/\r?\n/).slice(-14).join("\n"));
  rmSync(pagePath, { force: true });
  rmSync(logPath, { force: true });
  process.exit(1);
}

rmSync(pagePath, { force: true });
rmSync(logPath, { force: true });

/* ---- 交付前的体检：必须是带透明通道的 PNG，且体积别失控 ---- */
const png = readFileSync(out);
const isPng = png.length > 8 && png.readUInt32BE(0) === 0x89504e47;
const colorType = isPng ? png[25] : -1; /* 6 = RGBA */
const kb = png.length / 1024;
console.log(`\n  颜色类型 ${colorType === 6 ? "RGBA（带透明通道）✓" : colorType === 2 ? "RGB（没有透明通道）✗" : colorType}`);
console.log(`  体积 ${kb.toFixed(1)} KB ${kb > 1536 ? "⚠ 超过 1.5MB 上限" : ""}`);
if (!isPng || colorType !== 6) {
  console.error("输出不是带透明通道的 PNG，挂件用不了。");
  process.exit(1);
}
console.log("抠图完成。");
