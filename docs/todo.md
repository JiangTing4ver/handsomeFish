# 待办清单（交接用）

> 这份文件的存在意义：**不依赖任何人的对话记忆**。
> 每次收工前把未完成的、以及"坑在哪、为什么这么做"写在这里；下次开工先读它。
>
> 当前状态：仓库干净，全部自检通过（`node scripts/check.mjs` + `node scripts/selftest-desktop.mjs`）。
> 最后更新：删掉**内置手画线稿**之后。

---

## 0. 刚做完的：删除内置手画线稿 ✅

**为什么**：用户判断"能拿到作者原画时，就不该用手画的凑数"。入口先关闭（`c638941`），
现在**代码也整体删掉了**。

删掉的：`xiaolanSimpleSVG()`、表情系统（`EXPRESSIONS` / `STATE_EXPRESSION` /
`simpleEyes` / `arcPath` / `simpleMouth` / `simpleFace` / `faceFor` / `applyExpression` /
`setExpression` / `revertToResting`）、手臂（`ARM_POSES` / `simpleArmMarkup` / `simpleArms`）、
部件级动画 CSS（`.xl-arm-*` / `.xl-torso` / `.hf-eye` / `.hf-shadow` / `.hf-bubbles`）、
装饰火花 `spawnBubbles`、`SVG_STYLE` 常量、`?svg=1` / `?expr=` 两个调试开关。

**删完的行为**：没素材 → 什么都不画 + 气泡提示一次（`artHint()`，只提示一次）；
`state.style` 只认清单里真实存在的原画集键（存档里钉着 `svg` 的会清成空串）；
空闲时不再切"打哈欠"表情，只换成 `idle` 那张原画。

**这一刀留下的三条经验**（下次删大块代码照着做）：

1. **不要按"文本区间"切**。第一次就是按区间切多，把 `readArt` / `carrierDefaultArt` /
   `row` / `var artDataUrl` 一起删了，`apply()` 一跑就抛 —— 而 `node --check` 语法完全合法。
   正确做法：**唯一锚点定位 + 对被切下来的块做反向断言**（出现无关标识就中止），
   所有替换先在内存里做完，全部通过才写盘。脚本留在 `_shots/cut-lineart.cjs`。
2. **反向断言要用"这一刀真正删掉的东西"**，不要图省事列一大串全局符号：
   我第一次列了 `xiaolanSimpleSVG`（它属于后面那一刀），脚本直接中止 —— 这是好事，
   因为它证明断言真的在起作用。
3. **交接文档里的结论也要实测**。`handoff.md` 原来写着「`.hf-bob` / `.hf-shadow` 被图片角色
   复用，保留」——实测图片角色的 DOM 只有 `.hf-art` / `.hf-img`，那两个类名只存在于已删的
   SVG 里，是纯死 CSS。（已按正确结论删掉，并在 §6.4 记下来。）

---

## 1. `docs/shots/` 配图待重拍（**用户已决定：先留着，他自己换**）

现状：`default.png` / `left-snap.png` / `menu.png` / `custom-art.png` 四张拍的**都是已删掉的
手画线稿**；其中 `default.png` 的画面根本不是 README 标题说的"作者原画"。
`expressions.png`（7 表情对照）随表情系统一起作废，**已删除**。

已做的临时处理：README 里那四张图的 **caption 加了「⚠️ 待重拍」**，免得图与文字互相打脸。

用户的选择是**先都留着**（他要自己换），所以别自作主张删。
要重拍的话注意：**别把第三方原画截进图里提交**（仓库政策），可以拍空背景的菜单/气泡，
或只留文字描述。

---

## 2. 补完「音效风格」的三处 ✅

四套预设（默认 / 柔和 / 复古 8-bit / 机械）已可用（`e8a0c76`），三处都补齐了：

1. ✅ **选中即试听**：`onMenuInput` 里 `k === "soundStyle"` 分支 → 校验取值 +
   `audio.pop(1.15)`，600ms 后 `audio.ding()`。
2. ✅ **自检断言**：下拉存在、四套预设齐全、逐个切换 `state.soundStyle` 跟着变。
3. ✅ **文档**：README 功能表 + architecture §6.5 补上"四套风格"与试听说明。

> ⚠️ 写这类断言时记住：`change` 事件**必须 `bubbles: true`**。
> 菜单的监听器挂在 `menu` 父元素上，不冒泡就永远到不了 `onMenuInput` ——
> 表现是"state 完全不跟着走"，很容易误判成功能没实现（这次就误判了一轮）。

---

## 3. 台词关闭时的提示

用户一度以为"气泡坏了"，其实是自己关掉了「台词」开关 —— **关掉后气泡静默消失，
界面没有任何提示**。做法：关掉时在菜单里标注状态（或首次关闭时给一句气泡提示）。

> 注意：`artHint()`（没素材时的提示）走的是 `speak()`，所以**台词开关关掉时那条提示也看不见**。
> 这是刻意的（关了台词就是不想看气泡），但如果你觉得应该无视开关，就在 `artHint()` 里
> 直接操作 `say` 元素。

---

## 4. `_shots/` 清理（本地临时区，不入库）—— 已清过一轮 ✅

原本 73 个文件 / 3.04 MB → 清到 **41 个 / 0.66 MB**。
删掉的是**一次性产物**：各类对比截图（`showcase*` / `candidates-*` / `state-map` /
`refs-sheet` / `cutout-check` / `simple-set*` / `two-sets` / `th-cmp` / `close-cmp` /
`cmp2` / `cmp-polished` / `zoom-smile` / `friend-cmp` / `simple-v2|v3` / `new-assets` /
`ray` / `t14` / `bubble-*` / `light-check` / `say-side` / `s2-*`）、
三份 `client.before*.js` 备份、以及 `find-interp.cjs` / `del-svg.cjs`。
**是移到回收站，不是永久删除**（这个目录曾误删过用户的东西，已从回收站捞回过）。

**保留**（用户点名的工具与截图、可复用生成器、所有 `.cjs`）：

- 用户自己的工具与截图：`xl-lab.html`、`anim-check.html`、`xl2.png`、`xl_final.png`、
  `int1.png`、`int_menu.png`、`int_left.png`
- 各种 `*-cmp/sheet/check/*-set*.html` 画廊页（配 `preview.html?art=` 还能用）
- 脚本：`cut-lineart.cjs`（这次删线稿用的**反向断言模板**，下次删大块代码照它写）、
  `cut-polished2.cjs`、`lines-report.cjs`（量台词长度）、`add-random-idle.cjs`、
  `add-friend-button.cjs`、`add-sound-styles.cjs`、`fix-silent-buttons.cjs`、
  `fix-sound-styles.cjs`

> 注：`expr-sheet.html` / `expressions.html` / `simple-v2.html` 用的是 `?expr=`，
> 那个参数随表情系统一起删了 —— 页面还在、但已经出不了图，属于"留着当历史"。

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
发布前需自行确认授权。**没素材时挂件什么都不画**（内置线稿已删除）。
