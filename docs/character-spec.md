# 角色素材规格 + AI 生图提示词

> 📌 **现状**：挂件的内置角色已经是**小蓝**（手写程序化 SVG，见 [xiaolan.md](xiaolan.md)），
> **不需要外部素材就能跑**。本文是「我想换成自己的角色图」这条可选路径的规格说明。
>
> ⚠️ 下面第三节的提示词是按**原来的帅鱼**写的。要生成小蓝，请把角色描述替换成：
> 蓝色蓬松中发 + 呆毛 + 蓝眼睛 + 蓝白卫衣，并改成 **4:3 半身坐姿**构图
> （理由见 [asset-checklist.md](asset-checklist.md) 2.2 与 [xiaolan.md](xiaolan.md) 4.2）。

给你的帅鱼换成自己的形象。按下面的规格产出的图，**右键 → 换个角色图** 传进去就能直接用。

---

## 一、技术规格（硬要求）

| 项 | 要求 | 说明 |
|---|---|---|
| 格式 | **PNG**（静图）/ **GIF 或 动态 WebP**（动图） | JPG 不行——它没有透明通道，会在深色界面上留一个白方块 |
| 背景 | **完全透明** | 不是白色、不是棋盘格、不是"接近透明" |
| 画布 | **正方形**，建议 512×512（或 1024×1024 再降到 512） | 挂件按正方形区域 `object-fit: contain` 摆放，非正方形会留大片空白 |
| 体积 | **≤ 1.5 MB** | 超过会被拒绝（要进 `localStorage`，base64 还会膨胀约 1/3） |
| 主体占比 | 角色外接矩形占画布 **约 78%–86%**，四周留均匀透明边 | 留白太多 → 显示得很小；贴边 → 浮动动画时容易被裁 |
| 朝向 | **头朝左**（默认形象就是朝左） | 贴到屏幕左侧时挂件会整体水平镜像，所以只需出一张朝左的 |
| 视觉重心 | 角色底部**留 6%–8% 透明边** | 内置浮动动画会让它上下晃，底部留白避免"踩空" |

**尺寸自检**：把图传到挂件里，若看起来明显比默认形象小/大，或上下浮动时被切边，就是画布留白或占比不对。

---

## 二、动图规格（可选，效果最好）

| 项 | 建议 |
|---|---|
| 循环 | **无缝循环**（首尾帧一致或能自然衔接），否则每次循环会"抖"一下 |
| 帧数 | 8–24 帧。挂件已自带整体上下浮动，所以动图本身**只需要做小幅度局部动作** |
| 动作 | 尾鳍摆动 / 眨眼 / 腮部呼吸 / 嘴巴开合，**四选一即可**，别做大幅位移 |
| 帧率 | 8–12 fps 就够（挂件是氛围物件，不是游戏） |
| 体积 | 动图最容易超 1.5MB：优先减帧数、缩画布到 384×384，不要靠压色调 |

> 静态图也完全可用：挂件会给它加整体浮动动画。动图的价值在于尾巴/眼睛是活的。

---

## 三、AI 生图提示词

下面三套按风格分。**中英都给了**——多数模型对英文提示词更稳，中文模型（如即梦、通义万相、可图）用中文版更准。

三套都假设同一个角色设定：
> 一条自信又憨憨的胖金鱼，橙金色渐变身体、奶白肚皮、半透明珊瑚色鱼鳍，戴黑色墨镜（镜片上有青色反光），嘴角上扬，整体圆润可爱。

### 方案 A：扁平矢量贴纸风（推荐，最贴近默认形象，也最容易抠干净）

**English**
```
flat vector sticker of a chubby confident goldfish mascot, side view facing left,
warm orange-gold gradient body, cream belly, translucent coral fins,
wearing black sunglasses with a cyan highlight streak on the lens,
slight confident smirk, big rounded body, clean thick outline,
bold simple shapes, cel shading with one soft highlight on top,
centered, full body, isolated on pure transparent background,
die-cut sticker style, no shadow on the background, square canvas, high resolution
```

**中文**
```
扁平矢量贴纸风格，一条圆胖自信的金鱼吉祥物，正侧面朝左，
橙金色渐变身体、奶白色肚皮、半透明珊瑚色鱼鳍，
戴黑色墨镜，镜片上有青色高光，嘴角微微上扬显得很自信，
身体圆润，干净粗描边，简单的赛璐璐上色加一道顶部柔光，
居中完整全身，纯透明背景，模切贴纸质感，背景不要投影，正方形画布，高分辨率
```

### 方案 B：厚涂手绘卡通（更有温度，适合当"宠物"）

**English**
```
hand-painted cartoon mascot illustration of a plump friendly goldfish, side view facing left,
warm orange-to-gold gradient scales, soft cream belly, flowing translucent coral fins,
wearing round black sunglasses, a small knowing smile, glossy highlights on the body,
soft painterly shading, warm rim light along the top edge,
charming children's-book character design, centered full body,
isolated on pure transparent background, no ground shadow, square canvas, high resolution
```

**中文**
```
厚涂手绘卡通风格，一条圆润友善的金鱼吉祥物，正侧面朝左，
橙金渐变鳞片、柔和奶白肚皮、飘逸的半透明珊瑚色鱼鳍，
戴圆框黑色墨镜，嘴角带着心照不宣的小微笑，身体有油润高光，
柔和的手绘光影，顶部一道暖色轮廓光，
治愈系绘本角色设计，居中完整全身，纯透明背景，不要地面投影，正方形画布，高分辨率
```

### 方案 C：像素风（复古掌机感，适合挂在开发者工具里）

**English**
```
pixel art sprite of a chubby goldfish mascot with sunglasses, side view facing left,
32-bit era style, limited warm palette (orange, gold, cream, coral),
black sunglasses with a single cyan highlight pixel row,
crisp pixel edges, no anti-aliasing, no dithering gradients,
centered full body, isolated on pure transparent background,
square canvas, integer-scaled to high resolution
```

**中文**
```
像素画风精灵图，一条戴墨镜的圆胖金鱼吉祥物，正侧面朝左，
32 位机风格，限定暖色调色板（橙、金、奶白、珊瑚），
黑色墨镜上有一行青色高光像素，
像素边缘锐利、无抗锯齿、无抖动渐变，
居中完整全身，纯透明背景，正方形画布，按整数倍放大到高分辨率
```

### 负面提示词（三套通用）

**English**
```
white background, gray background, checkerboard pattern, visible background, drop shadow on background,
text, watermark, signature, logo, frame, border, multiple fish, collage, split view,
human body, legs, arms, hands, anthropomorphic standing, 3d render, plastic toy,
blurry, low resolution, jpeg artifacts, cropped fins, cut off edges, facing right
```

**中文**
```
白底、灰底、棋盘格、能看到背景、地面投影、
文字、水印、签名、logo、边框、多只鱼、拼图、分屏、
人的身体、腿、手、拟人站立、3D 渲染、塑料玩具质感、
模糊、低分辨率、JPEG 压缩痕迹、鱼鳍被裁、边缘被切、朝右
```

---

## 四、拿到图之后的后处理清单

AI 生图通常不会直接给出可用的透明底，按顺序做：

1. **抠背景** → 透明通道。本地工具：Photoshop「主体选择」、GIMP「按颜色选择」、`rembg`（Python 命令行，一条命令搞定）
2. **裁到主体外接矩形**，然后**四周补 8% 透明边**
3. **补成正方形**：在长边两侧补透明，让画布变成正方形
4. **缩到 512×512**（缩放在补边之后做，避免二次留白）
5. **导出 PNG-24（带 Alpha）**，确认文件 ≤1.5MB；超了就降到 384×384
6. **用深色底检查**：把图贴到深色背景上看一眼——边缘有没有白边/灰边（AI 抠图的典型残留）

---

## 五、接进挂件

1. 右键右下角的帅鱼 → **换个角色图**
2. 选你处理好的 PNG / GIF / WebP
3. 立刻替换。不想要了就右键 → **默认角色**

存的位置：`localStorage["dsh-handsome-fish:art"]`（和设置分开存，换回默认会清掉它）。

---

## 六、验收清单

传进去之后对着看一遍：

- [ ] 深色界面下没有白边/灰边（抠图残留）
- [ ] 大小和默认形象相当，不显得过小（留白过多）
- [ ] 上下浮动到最高点时，鳍和尾巴没被切掉
- [ ] 拖到屏幕左侧时镜像正常（朝右看），形状不别扭
- [ ] 点一下有 Q 弹挤压（这个效果作用在容器上，和素材无关，但能看出是否贴边）
- [ ] 台词气泡在角色上方居中对齐，没有压住角色的头
- [ ] 换成动图后循环处不"抖"

---

## 七、想微调内置的程序化形象？

如果你不想找图，只想把默认那条鱼改得更合心意，改这里更快：

| 想改 | 位置（`lib/client.js`） |
|---|---|
| 身体形状 | `BODY_D` 常量（一条 SVG 路径，clipPath 与实体共用） |
| 配色 | `function fishSVG()` 里 `<defs>` 的 `hf-body` / `hf-belly` / `hf-fin` / `hf-fin-deep` / `hf-lens` 五个渐变 |
| 墨镜 / 眼睛 / 眉毛 | `class="hf-shades"` / `hf-eye` / `hf-brow` 三组 |
| 高光与体积感 | 身体 clip 组里的轮廓高光路径与头部柔光椭圆 |
| 各部件动画 | CSS 里的 `@keyframes hf-bob / hf-wag / hf-sway / hf-flap / hf-blink` |
| 台词 | `LINES` 对象（`greet` / `click` / `drag` / `drop` / `turnEnd` / `idle` 六个池子） |

改完 `Ctrl+F5` 硬刷新即可看到效果，不用重启 DSH。
