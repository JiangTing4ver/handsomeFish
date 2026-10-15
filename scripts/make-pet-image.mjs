#!/usr/bin/env node
/**
 * 把一张普通插画变成可直接当桌面宠物用的**透明 PNG**。
 * =============================================================================
 * 为什么需要它：搜来的素材几乎都是带背景的整幅作品（海报 / 封面 / 同人图），
 * 而浮在桌面上的宠物必须是透明底，否则屏幕上会出现一个方块。
 *
 * 做法（不需要装任何图像库、不需要机器学习模型）：
 *   用 headless Chrome 打开一个只画这张图的页面，按目标画布裁切（object-fit: cover），
 *   可选套一层柔边蒙版；再用 `--default-background-color=00000000` 让截图本身带透明通道。
 *   柔边遮罩把背景"化"掉，视觉上是刻意的椭圆/圆形头像效果，而不是硬抠图留下的毛边。
 *
 * 画布比例默认 **4:3（1024×768）**：挂件舞台是 224×168 = 4:3，用正方形会白白浪费 25%
 * 宽度（见 docs/asset-checklist.md 2.2 / 2.3.1）。压体积时降到 512×384，别再往下。
 *
 * 用法：
 *   node scripts/make-pet-image.mjs <源图> <输出png> [选项]
 *     --size 1024x768    画布尺寸；也可只写一个数（如 --size 512 = 正方形 512×512）
 *     --focus "50% 22%"  裁切对准哪一点（CSS object-position），默认 "50% 20%"（偏上，适合人物头部）
 *     --no-mask          不套柔边蒙版。**图本身已经是透明底的角色时应该用它** ——
 *                        蒙版是用来"化掉"整幅插画背景的，用在干净素材上反而会切掉边缘
 *     --square           旧名，等价于 --no-mask
 *
 * 退出码：0 = 产出了带透明通道的合法 PNG；1 = 颜色类型不是 RGBA；2 = 参数/环境问题。
 */
import { spawnSync } from "node:child_process";
import { existsSync, openSync, closeSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(name);

const USAGE =
  '用法: node scripts/make-pet-image.mjs <源图> <输出png> [--size 1024x768] [--focus "50% 22%"] [--no-mask]';

const [src, out] = positional;
if (!src || !out) {
  console.error(USAGE);
  process.exit(2);
}
if (!existsSync(src)) {
  console.error("找不到源图:", src);
  process.exit(2);
}

/* --size 支持 "1024x768" 与 "512" 两种写法 */
const sizeArg = String(flag("--size", "1024x768")).toLowerCase();
let canvasW;
let canvasH;
if (/^\d+x\d+$/.test(sizeArg)) {
  [canvasW, canvasH] = sizeArg.split("x").map((n) => parseInt(n, 10));
} else if (/^\d+$/.test(sizeArg)) {
  canvasW = canvasH = parseInt(sizeArg, 10);
} else {
  console.error(`--size 写法不认识：${sizeArg}（应为 1024x768 或 512）`);
  process.exit(2);
}
if (!(canvasW > 0) || !(canvasH > 0)) {
  console.error("--size 必须是正整数");
  process.exit(2);
}

const focus = flag("--focus", "50% 20%");
const noMask = has("--no-mask") || has("--square");

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
  console.error("找不到 Chrome / Edge。");
  process.exit(2);
}

/* 页面：只画这张图，按画布裁切。柔边从 70% 开始淡出到 100%，既保留主体又让边缘自然消失。
   注意 `closest-side` 在非正方形画布上会自然变成**椭圆**，正好贴合 4:3。 */
const mask = noMask
  ? "none"
  : "radial-gradient(closest-side, #000 70%, rgba(0,0,0,0.55) 88%, transparent 100%)";

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:${canvasW}px;height:${canvasH}px;overflow:hidden;background:transparent;}
  .wrap{width:${canvasW}px;height:${canvasH}px;
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
      `--window-size=${canvasW},${canvasH}`,
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
const pngW = buf.readUInt32BE(16);
const pngH = buf.readUInt32BE(20);
const bitDepth = buf[24];
const colorType = buf[25];
const colorName =
  { 0: "灰度", 2: "RGB(无透明)", 3: "调色板", 4: "灰度+Alpha", 6: "RGBA(带透明)" }[colorType] ||
  `未知(${colorType})`;
const tooBig = buf.length > 1.5 * 1024 * 1024;

console.log(`源图:     ${src}`);
console.log(`输出:     ${absOut}`);
console.log(`画布:     ${pngW}x${pngH}  比例 ${(pngW / pngH).toFixed(2)}  位深 ${bitDepth}  颜色类型 ${colorName}`);
console.log(`蒙版:     ${noMask ? "未套（素材本身应是透明底）" : "柔边椭圆/圆形已套（用于化掉整幅插画的背景）"}`);
console.log(`体积:     ${(buf.length / 1024).toFixed(1)} KB  ${tooBig ? "⚠ 超过 1.5MB 上限，降到 --size 512x384" : "✓ 在 1.5MB 上限内"}`);
console.log(`PNG:      ${isPng ? "✓ 合法" : "✗ 不是 PNG"}`);

rmSync(tmpDir, { recursive: true, force: true });
if (!isPng) process.exit(1);
if (colorType !== 6) {
  console.error("✗ 没有透明通道 —— 对挂件没用（JPG 源必然会这样）。");
  process.exit(1);
}
process.exit(0);
