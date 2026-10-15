#!/usr/bin/env node
/**
 * 把一张普通插画变成可直接当桌面宠物用的**透明 PNG**。
 * =============================================================================
 * 为什么需要它：AI 搜集来的素材几乎都是带背景的整幅作品（海报 / 封面 / 同人图），
 * 而浮在桌面上的宠物必须是透明底，否则屏幕上会出现一个方块。
 *
 * 做法（不需要装任何图像库、不需要机器学习模型）：
 *   用 headless Chrome 打开一个只画这张图的页面，把图裁成正方形并套一层柔边圆形
 *   蒙版；再用 `--default-background-color=00000000` 让截图本身带透明通道。
 *   出来就是一张 512×512 的透明 PNG —— 柔边遮罩把背景"化"掉，视觉上是刻意的
 *   圆形头像效果，而不是硬抠图留下的毛边。
 *
 * 用法：
 *   node scripts/make-pet-image.mjs <源图> <输出png> [--size 512] [--focus "50% 22%"] [--square]
 *   --focus   裁切时对准哪一点（CSS object-position），默认 "50% 20%"（偏上，适合人物头部）
 *   --square  不加圆形遮罩，只裁正方形
 */
import { spawnSync } from "node:child_process";
import { existsSync, openSync, closeSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(name);

const [src, out] = positional;
if (!src || !out) {
  console.error("用法: node scripts/make-pet-image.mjs <源图> <输出png> [--size 512] [--focus \"50% 22%\"] [--square]");
  process.exit(2);
}
if (!existsSync(src)) {
  console.error("找不到源图:", src);
  process.exit(2);
}

const size = parseInt(flag("--size", "512"), 10) || 512;
const focus = flag("--focus", "50% 20%");
const square = has("--square");

const CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];
const browser = CANDIDATES.find((p) => p && existsSync(p));
if (!browser) {
  console.error("找不到 Chrome / Edge。");
  process.exit(2);
}

/* 页面：只画这张图，裁成正方形（object-fit: cover），可选柔边圆形遮罩。
   柔边从 72% 开始淡出到 100%，既保留主体，又让边缘自然消失。 */
const mask = square
  ? "none"
  : "radial-gradient(closest-side, #000 70%, rgba(0,0,0,0.55) 88%, transparent 100%)";

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden;background:transparent;}
  .wrap{width:${size}px;height:${size}px;
    -webkit-mask-image:${mask};mask-image:${mask};
    -webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;
    -webkit-mask-size:100% 100%;mask-size:100% 100%;}
  img{width:100%;height:100%;object-fit:cover;object-position:${focus};display:block;}
</style></head><body>
  <div class="wrap"><img src="${pathToFileURL(resolve(src)).href}"></div>
</body></html>`;

const tmpDir = join(tmpdir(), `hf-pet-${Date.now()}`);
mkdirSync(tmpDir, { recursive: true });
const htmlPath = join(tmpDir, "page.html");
const logPath = join(tmpDir, "chrome.log");
writeFileSync(htmlPath, html, "utf8");

const absOut = resolve(out);
mkdirSync(dirname(absOut), { recursive: true });
rmSync(absOut, { force: true });

const logFd = openSync(logPath, "w");
try {
  spawnSync(
    browser,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--default-background-color=00000000", // ← 关键：让截图带透明通道
      `--window-size=${size},${size}`,
      "--virtual-time-budget=4000",
      `--screenshot=${absOut}`,
      pathToFileURL(htmlPath).href,
    ],
    { stdio: ["ignore", logFd, logFd], timeout: 90_000 },
  );
} finally {
  closeSync(logFd);
}

if (!existsSync(absOut)) {
  console.error("截图失败。Chrome 日志尾部：");
  console.error(readFileSync(logPath, "utf8").split(/\r?\n/).slice(-12).join("\n"));
  process.exit(1);
}

/* 用 PNG 头直接读尺寸与颜色类型，不依赖任何库：
   IHDR 从第 16 字节开始：宽(4) 高(4) 位深(1) 颜色类型(1)
   颜色类型 6 = RGBA（有透明通道），2 = RGB（没有） */
const buf = readFileSync(absOut);
const isPng = buf.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
const width = buf.readUInt32BE(16);
const height = buf.readUInt32BE(20);
const bitDepth = buf[24];
const colorType = buf[25];
const colorName = { 0: "灰度", 2: "RGB(无透明)", 3: "调色板", 4: "灰度+Alpha", 6: "RGBA(带透明)" }[colorType] || `未知(${colorType})`;

console.log(`源图:   ${src}`);
console.log(`输出:   ${absOut}`);
console.log(`尺寸:   ${width}x${height}  位深 ${bitDepth}  颜色类型 ${colorName}`);
console.log(`体积:   ${(buf.length / 1024).toFixed(1)} KB  ${buf.length > 1.5 * 1024 * 1024 ? "⚠ 超过 1.5MB 上限，调小 --size" : "✓ 在 1.5MB 上限内"}`);
console.log(`PNG:    ${isPng ? "✓ 合法" : "✗ 不是 PNG"}`);

rmSync(tmpDir, { recursive: true, force: true });
process.exit(colorType === 6 ? 0 : 1);
