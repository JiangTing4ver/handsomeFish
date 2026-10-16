# 待办清单（交接用）

> 这份文件的存在意义：**不依赖任何人的对话记忆**。
> 每次收工前把未完成的、以及"坑在哪、为什么这么做"写在这里；下次开工先读它。
>
> 当前状态：仓库干净，全部自检通过（`node scripts/check.mjs` + `node scripts/selftest-desktop.mjs`）。
> 最后更新：`4ad005b`（6 键 2×3 布局 + 好朋友召唤术）之后。

---

## 1. 删除内置线稿（手画的简笔画 SVG）

**为什么**：用户判断"能拿到作者原画时，就不该用手画的凑数"。**入口已关闭**
（画风下拉不再列它，见 `c638941`），但代码还在，定位是"完全没有素材时的兜底"。

**要删的东西**（都集中在 `lib/client.js`）：

| 目标 | 说明 |
|---|---|
| `xiaolanSimpleSVG()` | 角色本体（约 100 行） |
| 表情系统 | `EXPRESSIONS` / `STATE_EXPRESSION` / `simpleEyes` / `arcPath` / `simpleMouth` / `simpleFace` |
| 手臂姿势 | `ARM_POSES` / `simpleArmMarkup` / `simpleArms` |
| 调度层 | `faceFor` / `applyExpression` / `setExpression` / `revertToResting` / `currentSVG` |
| 相关 CSS | `.xl-torso` / `.xl-arm-*` / `.xl-head` / `.hf-face` / `.hf-eye` 及其关键帧（`.hf-bob`/`.hf-shadow` 被图片角色复用，**保留**） |

**删完必须处理**：

1. **没素材时的表现**：现在会退回线稿 → 改成**什么都不画 + 用气泡提示一次**
   「还没有角色图：把图放进 assets/ 或右键「换个角色图」」。**绝不能变回我画的东西。**
2. **`state.style`**：`svg` 这个值失去意义 → 只保留原画集的键；`SVG_STYLE` 常量与
   `syncStyleOptions()` 里的兜底分支一起清理。
3. **自检断言**（`desktop/renderer.html` 约 10 条）：两画风标记、六部件齐全、
   7 种表情、`api.face()` / `api.redraw()` 相关 —— 全部替换为"**没有内置线稿了**"+
   保留原画那条链路（`HF-ART` 已覆盖）。
4. **文档**：README 第六节那条"③ 改内置线稿的部件动画（历史遗留，即将删除）"要删掉；
   architecture §6.3 / §6.4 / §6.7 里关于两套内置画风的表格要重写。
5. **`docs/shots/` 的五张配图拍的都是线稿** → 删掉线稿后必须重拍或去掉：
   重拍意味着**把第三方美术提交进仓库**（用户定了不入库，所以只能去掉角色截图，
   README 只留菜单/气泡这类 UI 图 + 文字描述）。**这一步要问用户。**

**教训（上次失败的原因）**：第一版按"文本区间"切，切多了，把 `readArt` /
`carrierDefaultArt` / `row` / `var artDataUrl` 一起删掉，`apply()` 一跑就抛 ——
而 `node --check` **语法完全合法**（语法检查抓不到"删多了"）。
**改用花括号配对 + 对切下来的块做反向断言**（出现无关标识就中止）才对。
参考脚本：`_shots/cut-polished2.cjs`（已成功删掉"精致描画"那套）。

---

## 2. 补完「音效风格」的三处

四套预设（默认 / 柔和 / 复古 8-bit / 机械）已可用（`e8a0c76`），差三处：

1. **选中即试听**：`onMenuInput` 里加 `k === "soundStyle"` 分支 → 校验取值 +
   `audio.pop(1.15)`，200ms 后 `audio.ding()`。
2. **自检断言**：下拉存在、逐个切换 `state.soundStyle` 跟着变。
3. **文档**：README 功能表 + architecture §6.5（音效：Web Audio 现场合成）补"四套风格"。

---

## 3. 台词关闭时的提示

用户一度以为"气泡坏了"，其实是自己关掉了「台词」开关 —— **关掉后气泡静默消失，
界面没有任何提示**。做法：关掉时在菜单里标注状态（或首次关闭时给一句气泡提示）。

---

## 4. `_shots/` 清理（本地临时区，不入库）

64 个文件 / 2.8 MB。**必须保留**：

- 用户自己的工具与截图：`xl-lab.html`、`anim-check.html`、`xl2.png`、`xl_final.png`、
  `int1.png`、`int_menu.png`、`int_left.png`（曾误删过一次，已从回收站捞回）
- 可复用的生成器：`expr-sheet.html`（7 表情对照表）、各类 `*-cmp/sheet/check.html`
- 脚本：`cut-polished2.cjs`（下次删线稿要用）、`lines-report.cjs`（量台词长度）、
  `add-random-idle.cjs`、`add-friend-button.cjs`

**可删**：各种一次性对比 PNG、`client.before*.js` 备份、`find-interp.cjs`、`del-svg.cjs`。

---

## 5. 其它已知但未做的

| 项 | 说明 |
|---|---|
| 桌面壳的**拖动 / 点击穿透** | 用户截图已证实能跑，但这两项**未逐项确认** |
| 多显示器 | 只铺主显示器 workArea |
| 开机自启 / 打包 exe / 托盘图标 | 未实现 |
| 简笔套剩下没用上的素材 | `s2-greet`（有桌面线）、`s2-sit`（带椅子）、`s2-yawn`、`祝福小绿` 等；已抠但在 `assets/`（不入库），按需再登记进清单 |

---

## 交接时的一句话总结

角色素材**全部不在仓库里**（在 `assets/`，已 `.gitignore`）：仓库只含代码、文档、
自检素材（`scripts/fixtures/`）与文档配图。任何第三方美术都**不进 git**，
发布前需自行确认授权。
