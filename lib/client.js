/* =====================================================================
   dsh-handsome-fish — 帅鱼 handsomeFish
   DSH 界面内桌面宠物挂件 · client 半侧（浏览器）
   ---------------------------------------------------------------------
   DSH client-modules 硬性约束（踩过的坑，别改）：
   1. 必须用经典脚本注册工厂 `window.__ModuleLoader__.load({ id, factory })`，
      绝对不能写 ESM `export` —— 语法错误会让整个 harness 启动失败。
   2. 本文件由宿主原样提供（/plugins/dsh-handsome-fish/client.js），不经构建，
      所以只依赖浏览器原生能力，不 import 任何包。
   3. 任何运行时错误都必须被 try/catch 吞掉，绝不允许影响 harness 启动。
   4. 幂等：重复注入直接返回。
   5. 所有动画节点用完必须 remove()，否则长按拖动会无限累积 DOM。
   6. 不要把 filter/backdrop-filter 加在祖先链上，否则 position:fixed 的
      包含块被改，弹层会被压窄（dsh-bg-tech 的坑）。
   ===================================================================== */
window.__ModuleLoader__.load({
  id: "dsh-handsome-fish",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    /* 本插件不需要任何 cordis 客户端服务：纯 DOM 实现，最大化健壮性。 */
    var inject = [];

    var VERSION = "0.1.0";
    var ROOT_ID = "dsh-handsome-fish";
    var STORE_KEY = "dsh-handsome-fish:v1";
    /*
     * 轮次状态路由。DSH 页面载体里是同源相对路径；OS 级载体（Electron 桌面窗）是
     * file:// 源，相对路径会解析成 file:///dsh-handsome-fish/... 从而失败，所以由
     * 载体自己通过 __HANDSOME_FISH_EVENTS_URL__ 给绝对地址（外壳从 DSH_WEB_URL 或
     * ~/.dsh/mobile-access/setup.json 里取 host）。
     */
    var EVENTS_URL = (function () {
      try {
        var override = window.__HANDSOME_FISH_EVENTS_URL__;
        if (typeof override === "string" && override) return override;
      } catch (e) {
        /* ignore */
      }
      return "/dsh-handsome-fish/events.json";
    })();

    /* 角色基准尺寸（4:3，与 SVG viewBox 240x180 一致） */
    var BASE_W = 224;
    var BASE_H = 168;

    /* ---------------- 台词库：同类不连续重复 ----------------
     * 角色：小蓝（《小绿和小蓝》· 机器人篇）
     * 性格依据：沉默寡言、不擅交际；认为电脑比人好懂；提到专业才会认真起来；
     *           善良友好但被关注时容易慌；呆毛是标志性特征。
     * 说明：以下均为按上述性格**原创**的台词，不是从原作摘录的句子。
     *       台词气泡最宽 min(230px,58vw)，所以每条尽量控制在 12 字以内。
     */
    var LINES = {
      /* 语气定位见 docs/xiaolan.md 六：greet 冷淡但友好 / click 被关注时的窘迫 /
         drag 技术宅的即时反应 / drop 极简确认 / turnEnd 提到工作就认真 /
         idle 自言自语，暴露「电脑比人好懂」的世界观。
         每条尽量 ≤12 字（气泡最宽 230px）。 */
      greet: [
        "……早。",
        "环境就绪了。",
        "我在。有事叫我。",
        "日志还没看。",
        "上线成功。"
      ],
      click: [
        "别、别戳了。",
        "我不是触摸屏。",
        "……信号收到了。",
        "这个交互设计不合理。",
        "（往旁边挪了挪）",
        "点击率不是这样刷的。"
      ],
      drag: [
        "等等，没做防抖——",
        "重力参数我没设过。",
        "放我下来……",
        "坐标系要乱了。",
        "这操作没写进文档。"
      ],
      drop: [
        "坐标记下了。",
        "……就这儿。",
        "位置已保存。",
        "落位完成。"
      ],
      turnEnd: [
        "这一版跑通了。",
        "编译通过，零警告。",
        "测试全绿。",
        "嗯，没报错。",
        /* ↓ 用户提供的作品名台词（出处与语境未经核实，按"用户提供"处理，不是本文件原创） */
        "为了伯伦希尔的荣耀。"
      ],
      idle: [
        "……人类真难懂。",
        "电脑比人好懂多了。",
        "（盯着屏幕）",
        "工具都调好了。",
        "需求又变了。",
        "人比编译器难伺候。",
        "这段迟早要重构。"
      ]
    };

    function apply(ctx) {
      "use strict";
      try {
        if (typeof document === "undefined") return;
        /* ---------- 幂等保护 ---------- */
        if (document.getElementById(ROOT_ID)) return;

        /* 注：原来这里读一次 prefers-reduced-motion 给装饰火花用；火花随线稿一起删掉了，
           现在「少动一点」完全由 CSS 里的 @media (prefers-reduced-motion) 负责。 */

        /* ============================================================
           1. 配置持久化
           ============================================================ */
        /* 画风的取值**只有原画集的键**（来自 assets/art-manifest.json 的 `sets`，
           例如 mature / simple）。以前还有一个 `svg`＝内置手画线稿的兜底取值，
           线稿删除后这个值彻底失去意义（见 docs/todo.md 第 1 项第 2 点）。
           默认是空串＝"还没有素材"，等清单到了再切到清单声明的 default_set；
           一直拿不到清单就保持空串，角色什么都不画（renderCharacter）。 */
        /* 音效风格预设的键（详情在音频模块的 ALT_SOUNDS 里）。放在这里是为了让 readStore
           能校验存档里的值 —— 音频模块在那个函数之后才定义。 */
        var SOUND_STYLE_KEYS = ["default", "soft", "retro", "mech"];
        var ART_SETS = null; /* { 集名: {label, default, states} } */
        var ART_SET_KEYS = [];

        function styleIsArtSet(s) {
          return !!(ART_SETS && Object.prototype.hasOwnProperty.call(ART_SETS, s));
        }

        /* 载体可以指定初始画风（桌面壳/预览页的 ?style=…）；用户在菜单里选过就以用户为准。
           ⚠️ 载体给的值不可信（可能是旧版的 "svg"、或清单里没有的集名），
           所以只当做"一个待校验的候选"，校验在 readStore 与 syncStyleOptions 里做。 */
        function carrierStyle() {
          try {
            var v = window.__HANDSOME_FISH_STYLE__;
            return typeof v === "string" ? v : "";
          } catch (e) {
            return "";
          }
        }

        var DEFAULTS = {
          size: 1,
          /* 音效开关用**正向**语义：勾上＝有声音，和台词/吸附/结束音三个开关一致。
             早期这里存的是 muted（静音），导致"勾上反而没声音" —— 与标签相反，用户会看错。 */
          sound: true,
          volume: 0.6,
          speech: true,
          snap: true,
          endSound: true,
          /* 画风默认空串＝"还没有原画素材"；清单到达后若用户没显式选过，会切到原画集 */
          style: carrierStyle(),
          /* 音效风格（预设名见 SOUND_STYLE_KEYS；四套都在音频模块里，全是现场合成） */
          soundStyle: "default",
          hidden: false,
          side: "right",
          x: 26,
          y: 26
        };

        /*
         * 「代码里的默认值」必须与「用户的显式选择」分开。
         * 否则 writeStore() 会把"当时的默认值"也一起存盘，于是以后每次改默认画风，
         * 对已经有存档的 profile 全都无效 —— 表现就是"重启了还是旧角色"。
         * stylePinned 记录用户有没有在菜单里显式选过画风。
         */
        var stylePinned = false;

        function readStore() {
          var out = {};
          for (var k in DEFAULTS) out[k] = DEFAULTS[k];
          try {
            var raw = localStorage.getItem(STORE_KEY);
            if (raw) {
              var parsed = JSON.parse(raw);
              if (parsed && typeof parsed === "object") {
                var hasOwn = Object.prototype.hasOwnProperty;
                for (var j in DEFAULTS) {
                  if (hasOwn.call(parsed, j)) out[j] = parsed[j];
                }
                stylePinned = parsed.stylePinned === true;
                /* 一次性迁移：老存档里那个 style 是"当时的默认值"而不是用户选的，
                   忽略它、改用当前代码默认 —— 但只忽略这一次。 */
                if (!stylePinned && hasOwn.call(parsed, "style")) {
                  out.style = DEFAULTS.style;
                }
              }
            }
          } catch (e) {
            /* ignore */
          }
          /* 存档里的画风只认"清单里真实存在的原画集键"。
             ⚠️ 这里**不能**用 styleIsArtSet 校验：readStore() 跑在 loadArtManifest()
             之前，ART_SETS 那时候还是 null，拿它判断会把用户选过的画风误判成非法值。
             真正"落回一套真实存在的画风"由 useManifest / syncStyleOptions 负责。
             这里只处理一件事：`svg`（内置线稿，已删除）这个取值失去意义 →
             清成空串＝"还没有素材"，免得走进一个渲染不出来的分支。 */
          if (typeof out.style !== "string") out.style = DEFAULTS.style;
          if (out.style === "svg") out.style = "";
          /* 数值兜底，避免坏数据把界面搞崩 */
          out.size = clampNum(out.size, 0.6, 1.6, 1);
          out.volume = clampNum(out.volume, 0, 1, 0.6);
          out.x = clampNum(out.x, 0, 4000, 26);
          out.y = clampNum(out.y, 0, 4000, 26);
          out.side = out.side === "left" ? "left" : "right";
          if (SOUND_STYLE_KEYS.indexOf(out.soundStyle) < 0) out.soundStyle = "default";
          return out;
        }

        function clampNum(v, lo, hi, dflt) {
          var n = typeof v === "number" ? v : parseFloat(v);
          if (!isFinite(n)) return dflt;
          return n < lo ? lo : n > hi ? hi : n;
        }

        function writeStore() {
          try {
            var out = {};
            for (var k in DEFAULTS) out[k] = state[k];
            /* 记下"用户是否显式选过画风"，否则下次改代码默认值又会被存档钉死 */
            out.stylePinned = stylePinned;
            localStorage.setItem(STORE_KEY, JSON.stringify(out));
          } catch (e) {
            /* ignore */
          }
        }

        var state = readStore();

        /* ============================================================
           2. 音效：Web Audio 程序化合成（零素材、零网络请求）
             —— 顺带避开「IDM 等下载管理器抢 <audio> 请求」的已知坑
           ============================================================ */
        var audio = (function () {
          var actx = null;
          var master = null;

          function ensure() {
            if (!state.sound) return null;
            try {
              var AC = window.AudioContext || window.webkitAudioContext;
              if (!AC) return null;
              if (!actx) {
                actx = new AC();
                master = actx.createGain();
                master.gain.value = state.volume;
                master.connect(actx.destination);
              }
              if (master) master.gain.value = state.volume;
              if (actx.state === "suspended" && actx.resume) {
                actx.resume().catch(function () {});
              }
              return actx;
            } catch (e) {
              return null;
            }
          }

          /* 一段带指数包络的振荡器 */
          function tone(c, o) {
            var t0 = c.currentTime + (o.at || 0);
            var osc = c.createOscillator();
            var g = c.createGain();
            osc.type = o.type || "sine";
            osc.frequency.setValueAtTime(o.from, t0);
            if (o.to && o.to !== o.from) {
              osc.frequency.exponentialRampToValueAtTime(o.to, t0 + o.sweep);
            }
            var peak = o.gain == null ? 0.5 : o.gain;
            var dur = o.dur == null ? 0.25 : o.dur;
            g.gain.setValueAtTime(0.0001, t0);
            g.gain.exponentialRampToValueAtTime(peak, t0 + (o.attack || 0.01));
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
            osc.connect(g);
            g.connect(master);
            osc.start(t0);
            osc.stop(t0 + dur + 0.03);
          }

          /* =====================================================================
             音效风格预设（全部现场合成，没有任何音频文件）
             - default 不进这张表：它是原有实现，一字未改
             - 其余每套只给"参数子表"，playStyle() 按当前风格播放
             ===================================================================== */
          var ALT_SOUNDS = {
            /* 柔和：只用正弦、频率更低、起音更长 —— 专注时不打扰 */
            soft: {
              pop: [{ type: "sine", from: 620, to: 280, sweep: 0.16, gain: 0.26, dur: 0.22, attack: 0.03 }],
              chime: [
                { type: "sine", from: 784, gain: 0.22, dur: 0.7, attack: 0.05 },
                { type: "sine", from: 988, gain: 0.2, dur: 0.7, at: 0.12, attack: 0.05 },
                { type: "sine", from: 1174.7, gain: 0.18, dur: 0.7, at: 0.24, attack: 0.05 }
              ],
              ding: [
                { type: "sine", from: 880, gain: 0.2, dur: 0.5, attack: 0.03 },
                { type: "sine", from: 1174.7, gain: 0.16, dur: 0.6, at: 0.2, attack: 0.03 }
              ],
              thud: [{ type: "sine", from: 170, to: 80, sweep: 0.16, gain: 0.22, dur: 0.22, attack: 0.02 }]
            },
            /* 复古 8-bit：方波、短促、偏高 —— 红白机味道 */
            retro: {
              pop: [
                { type: "square", from: 1046, to: 523, sweep: 0.06, gain: 0.16, dur: 0.09, attack: 0.002 },
                { type: "square", from: 2093, to: 1046, sweep: 0.04, gain: 0.07, dur: 0.05, at: 0.01 }
              ],
              chime: [
                { type: "square", from: 1046.5, gain: 0.12, dur: 0.22, attack: 0.002 },
                { type: "square", from: 1318.5, gain: 0.12, dur: 0.22, at: 0.07, attack: 0.002 },
                { type: "square", from: 1568, gain: 0.12, dur: 0.22, at: 0.14, attack: 0.002 },
                { type: "square", from: 2093, gain: 0.1, dur: 0.26, at: 0.21, attack: 0.002 }
              ],
              ding: [
                { type: "square", from: 1568, gain: 0.12, dur: 0.16, attack: 0.002 },
                { type: "square", from: 2093, gain: 0.1, dur: 0.2, at: 0.12, attack: 0.002 }
              ],
              thud: [{ type: "square", from: 160, to: 70, sweep: 0.1, gain: 0.14, dur: 0.12, attack: 0.002 }]
            },
            /* 机械 / 终端：锯齿波 + 硬包络，像老终端与继电器 */
            mech: {
              pop: [{ type: "sawtooth", from: 1200, to: 400, sweep: 0.05, gain: 0.12, dur: 0.06, attack: 0.001 }],
              chime: [
                { type: "sawtooth", from: 523, gain: 0.12, dur: 0.16, attack: 0.001 },
                { type: "sawtooth", from: 784, gain: 0.12, dur: 0.16, at: 0.09, attack: 0.001 },
                { type: "square", from: 130, gain: 0.1, dur: 0.3, at: 0.02, attack: 0.01 }
              ],
              ding: [
                { type: "square", from: 1318.5, gain: 0.1, dur: 0.1, attack: 0.001 },
                { type: "square", from: 1318.5, gain: 0.09, dur: 0.1, at: 0.16, attack: 0.001 }
              ],
              thud: [{ type: "sawtooth", from: 180, to: 60, sweep: 0.08, gain: 0.16, dur: 0.1, attack: 0.002 }]
            }
          };

          /** 按当前风格播一个音效；default（或未知风格）返回 false，让原有实现继续 */
          function playStyle(c, name, pitch) {
            var st = state.soundStyle;
            if (!st || st === "default") return false;
            var set = ALT_SOUNDS[st];
            if (!set || !set[name]) return false;
            var specs = set[name];
            for (var i = 0; i < specs.length; i++) {
              var s = specs[i];
              var opts = {};
              for (var k in s) opts[k] = s[k];
              if (pitch && pitch !== 1) {
                if (opts.from) opts.from = opts.from * pitch;
                if (opts.to) opts.to = opts.to * pitch;
              }
              tone(c, opts);
            }
            return true;
          }

          return {


            /* 气泡「咕噜」：正弦从高滑到低，像水泡破裂 */
            pop: function (pitch) {
              var c = ensure();
              if (!c) return;
              if (playStyle(c, "pop", pitch)) return;
              var base = pitch || 1;
              tone(c, {
                type: "sine",
                from: 880 * base,
                to: 260 * base,
                sweep: 0.09,
                gain: 0.42,
                dur: 0.13,
                attack: 0.006
              });
              tone(c, {
                type: "triangle",
                from: 1760 * base,
                to: 700 * base,
                sweep: 0.05,
                gain: 0.1,
                dur: 0.07,
                at: 0.012
              });
            },
            /* 一轮对话结束：C6-E6-G6 上行琶音 + 低音垫 */
            chime: function () {
              var c = ensure();
              if (!c) return;
              if (playStyle(c, "chime", 1)) return;
              var notes = [1046.5, 1318.5, 1568.0];
              for (var i = 0; i < notes.length; i++) {
                tone(c, {
                  type: "triangle",
                  from: notes[i],
                  gain: 0.3,
                  dur: 0.5,
                  at: i * 0.1,
                  attack: 0.012
                });
              }
              tone(c, {
                type: "sine",
                from: 523.25,
                gain: 0.16,
                dur: 0.7,
                at: 0.02,
                attack: 0.02
              });
            },
            /* 提醒：两声柔和「叮」 */
            ding: function () {
              var c = ensure();
              if (!c) return;
              if (playStyle(c, "ding", 1)) return;
              tone(c, { type: "sine", from: 1318.5, gain: 0.26, dur: 0.34, attack: 0.008 });
              tone(c, {
                type: "sine",
                from: 1760,
                gain: 0.22,
                dur: 0.42,
                at: 0.16,
                attack: 0.008
              });
            },
            /* 放下：一记闷闷的低音 */
            thud: function () {
              var c = ensure();
              if (!c) return;
              if (playStyle(c, "thud", 1)) return;
              tone(c, {
                type: "sine",
                from: 220,
                to: 90,
                sweep: 0.12,
                gain: 0.3,
                dur: 0.16,
                attack: 0.008
              });
            },
            /* 浏览器自动播放策略：首次用户手势时把 AudioContext 唤醒 */
            unlock: function () {
              try {
                var c = ensure();
                if (c && c.state === "suspended" && c.resume) c.resume().catch(function () {});
              } catch (e) {
                /* ignore */
              }
            },
            setVolume: function (v) {
              try {
                if (master) master.gain.value = v;
              } catch (e) {
                /* ignore */
              }
            }
          };
        })();

        /* ============================================================
           3. 样式注入
           ============================================================ */
        /* 每条规则都带 #ROOT_ID 前缀：绝不泄漏到 DSH 自身或其它插件的样式上 */
        var P = "#" + ROOT_ID + " ";
        var CSS = [
          "#" + ROOT_ID + "{position:fixed;inset:0;z-index:2147483000;pointer-events:none;",
          "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;",
          "font-size:13px;line-height:1.5;color:#e9f2fb;-webkit-font-smoothing:antialiased;}",
          P + "*{box-sizing:border-box;}",
          P + "." + ROOT_ID + "-stage{position:absolute;pointer-events:none;}",
          P + ".is-anim{transition:left .3s cubic-bezier(.22,1,.36,1),top .3s cubic-bezier(.22,1,.36,1);}",
          P + "." + ROOT_ID + "-tilt{width:100%;height:100%;transform-origin:50% 80%;}",
          P + ".is-flip{transform:scaleX(-1);}",
          P + "." + ROOT_ID + "-fish{width:100%;height:100%;pointer-events:auto;cursor:grab;",
          "touch-action:none;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;}",
          P + "." + ROOT_ID + "-fish:active{cursor:grabbing;}",
          /* ---- 待机动画 ----
             ⚠️ 内置手画线稿那套（角色 SVG + 悬停放大 + 摆臂/呼吸/眨眼/影子这些部件级动画）
             已按用户要求整体删除：角色现在只来自图片，所以动画挂点只剩 .hf-art 一个。
             （.hf-svg / .hf-bob / .hf-shadow 曾经看起来像"被图片角色复用"，其实没有 ——
               图片角色的 DOM 里只有 .hf-art / .hf-img，这些类名只存在于已删的 SVG 里。） */
          /* ---- 角色图 ----
             图片没有部件级动画，所以浮动/挤压/点头都挂在 .hf-art 上，
             并让 transform-origin 落在底部，挤压时才是"从脚往上压"而不是绕中心缩 */
          P + ".hf-art{width:100%;height:100%;display:flex;align-items:flex-end;justify-content:center;",
          "animation:hf-bob 3.4s ease-in-out infinite;transform-origin:50% 100%;}",
          P + ".hf-img{max-width:100%;max-height:100%;object-fit:contain;display:block;",
          "filter:drop-shadow(0 7px 16px rgba(0,0,0,.3));-webkit-user-drag:none;user-select:none;}",
          /* 悬停放大（原来挂在 .hf-svg 上；线稿删掉后图片角色也要有这点反馈） */
          P + ".is-hover .hf-art{transform:scale(1.04);transition:transform .18s ease-out;}",
          /* ---- 交互状态 ---- */
          P + ".is-dragging .hf-art{animation-play-state:paused;}",
          P + ".is-happy .hf-art{animation:hf-squash .52s cubic-bezier(.34,1.56,.64,1);}",
          "@keyframes hf-squash{0%{transform:scale(1,1)}22%{transform:scale(1.16,.84)}52%{transform:scale(.94,1.1)}",
          "78%{transform:scale(1.04,.97)}100%{transform:scale(1,1)}}",
          P + ".is-nod .hf-art{animation:hf-nod .46s ease-in-out;}",
          "@keyframes hf-nod{0%,100%{transform:translateY(0)}40%{transform:translateY(5px)}}",
          /* ---- 台词气泡：贴在角色**侧边**（朝屏幕内侧那一侧），不压角色 ----
             原先贴在角色正上方（bottom:calc(100% - 30px)），会压到脑袋上 ——
             用户反馈"期待对话框在旁边"。侧边定位还有一个好处：
             角色在屏幕角落时，气泡朝屏幕内侧展开，不会被窗口边缘截断。 */
          P + "." + ROOT_ID + "-say{position:absolute;bottom:38%;",
          /* 宽度必须显式给：气泡锚在角色侧边（right:calc(100% + 14px)）时，
             绝对定位盒子的"可用宽度"会算成负数 → 文字一行挤成一个字，变成竖条。
             width:max-content 让它按内容取宽，max-width 再封顶并换行。 */
          "width:max-content;max-width:min(230px,46vw);padding:8px 12px;",
          "border-radius:14px;background:rgba(16,25,40,.94);border:1px solid rgba(126,230,255,.3);",
          "box-shadow:0 10px 26px rgba(0,0,0,.4);color:#eaf6ff;white-space:pre-wrap;word-break:break-word;",
          "pointer-events:none;cursor:pointer;opacity:0;transform:translateY(6px) scale(.94);",
          "transition:opacity .18s ease-out,transform .2s cubic-bezier(.34,1.56,.64,1);}",
          /* 隐藏时不接收鼠标：否则一个看不见的气泡会在桌面窗口里挡住底下的点击 */
          P + "." + ROOT_ID + "-say.is-on{pointer-events:auto;}",
          /* 角色在右侧 → 气泡放它左边；角色在左侧 → 放它右边。都在视口内侧，不会被边缘截断 */
          P + "." + ROOT_ID + "-say[data-tail='right']{right:calc(100% + 14px);}",
          P + "." + ROOT_ID + "-say[data-tail='left']{left:calc(100% + 14px);}",
          P + "." + ROOT_ID + "-say.is-on{opacity:1;transform:translateY(0) scale(1);}",
          /* 小尾巴：指向角色那一侧（横着指，不是朝下指） */
          P + "." + ROOT_ID + "-say::after{content:'';position:absolute;width:11px;height:11px;",
          "background:rgba(16,25,40,.94);transform:rotate(45deg);}",
          P + "." + ROOT_ID + "-say[data-tail='right']::after{right:-6px;bottom:16px;",
          "border-right:1px solid rgba(126,230,255,.3);border-bottom:1px solid rgba(126,230,255,.3);}",
          P + "." + ROOT_ID + "-say[data-tail='left']::after{left:-6px;bottom:16px;",
          "border-left:1px solid rgba(126,230,255,.3);border-top:1px solid rgba(126,230,255,.3);}",
          /* ---- 菜单 ---- */
          P + "." + ROOT_ID + "-menu{position:absolute;width:224px;padding:10px;border-radius:14px;",
          "background:rgba(13,20,33,.97);border:1px solid rgba(126,230,255,.26);",
          "box-shadow:0 18px 44px rgba(0,0,0,.5);pointer-events:auto;opacity:0;transform:scale(.96);",
          "transition:opacity .14s ease-out,transform .14s ease-out;display:none;}",
          P + "." + ROOT_ID + "-menu.is-on{display:block;opacity:1;transform:scale(1);}",
          P + "." + ROOT_ID + "-menu h4{margin:0 0 8px;font-size:12px;font-weight:600;color:#9fe8ff;",
          "display:flex;justify-content:space-between;align-items:center;letter-spacing:.3px;}",
          P + "." + ROOT_ID + "-menu h4 em{font-style:normal;font-size:10px;color:#6f8296;}",
          P + "." + ROOT_ID + "-row{display:flex;align-items:center;gap:8px;margin:7px 0;color:#cfe0ef;font-size:12px;}",
          P + "." + ROOT_ID + "-row>span{flex:0 0 56px;}",
          P + "." + ROOT_ID + "-row input[type=range]{flex:1;min-width:0;accent-color:#5fd8ff;height:16px;}",
          P + "." + ROOT_ID + "-row input[type=checkbox]{accent-color:#5fd8ff;width:15px;height:15px;cursor:pointer;}",
          /* 画风选择器：菜单里唯一的下拉框 */
          P + "." + ROOT_ID + "-row select{flex:1;min-width:0;font:inherit;font-size:11px;padding:3px 6px;",
          "border-radius:8px;cursor:pointer;color:#dcebf8;background:rgba(38,54,78,.85);",
          "border:1px solid rgba(126,230,255,.22);}",
          P + "." + ROOT_ID + "-row b{flex:0 0 34px;text-align:right;font-weight:500;color:#8fa4b8;font-size:11px;}",
          /* 固定两列网格：按钮数量变化时排版仍然整齐（flex-wrap 会按内容宽度乱换行，
             6 个键凑不出 2×3）。grid 的默认 stretch 会让每个按钮填满自己的格子。 */
          P + "." + ROOT_ID + "-btns{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:10px;",
          "padding-top:9px;border-top:1px solid rgba(126,230,255,.14);}",
          P + "." + ROOT_ID + "-btns button{flex:1 1 auto;padding:6px 9px;border-radius:9px;cursor:pointer;",
          "background:rgba(38,54,78,.85);color:#dcebf8;border:1px solid rgba(126,230,255,.2);",
          "font-size:11px;font-family:inherit;transition:background .14s;}",
          P + "." + ROOT_ID + "-btns button:hover{background:rgba(58,82,116,.95);}",
          /* 不可用的按键要明显变淡，否则"能点但没反应"会被当成 bug */
          P + "." + ROOT_ID + "-btns button:disabled{opacity:.45;cursor:not-allowed;}",
          P + "." + ROOT_ID + "-btns button.is-danger{border-color:rgba(255,140,140,.34);color:#ffd6d6;}",
          /* ---- 隐藏后的边缘小标签 ---- */
          P + "." + ROOT_ID + "-tab{position:absolute;right:0;bottom:90px;padding:9px 6px;border-radius:10px 0 0 10px;",
          "background:rgba(16,25,40,.92);border:1px solid rgba(126,230,255,.3);border-right:none;",
          "font-size:16px;line-height:1;cursor:pointer;pointer-events:auto;display:none;opacity:.55;",
          "transition:opacity .16s,transform .16s;}",
          P + "." + ROOT_ID + "-tab.is-on{display:block;}",
          P + "." + ROOT_ID + "-tab:hover{opacity:1;transform:translateX(-3px);}",
          /* ---- 无障碍：尊重 reduced-motion ---- */
          "@media (prefers-reduced-motion: reduce){",
          P + ".hf-art{animation:none !important;}}"
        ].join("");

        var styleEl = document.createElement("style");
        styleEl.setAttribute("data-dsh-plugin", ROOT_ID);
        styleEl.textContent = CSS;
        document.head.appendChild(styleEl);

        /* ============================================================
           4. 角色：只有图片，没有内置线稿
           ------------------------------------------------------------------
           用户的要求（docs/todo.md 第 1 项）：**能拿到作者原画时，就不该用手画的凑数**。
           所以原先那套手画简笔画 SVG（部件级动画 + 7 种表情 + 手臂姿势表）已整体删除。
           角色本体现在只有一个来源 —— 图片：
             · 用户上传 / 载体指定（artDataUrl，优先级最高）
             · assets/art-manifest.json 里的作者原画集（按状态换图，见下一节）
           一张素材都没有时**什么都不画**（见 renderCharacter + artHint），
           绝不再退回手画的东西。
           ============================================================ */

        /** 回到默认原画（临时状态收尾时统一走这里，别各写一份）——
            表情那套已经删了，这里现在只剩"把图切回 default 那张"。 */
        function revertArt() {
          artStateKey = "default";
          updateArtImage();
        }

        /** 按状态名换一张原画（作者原画清单里的 states 映射是唯一改动点）。
            没有清单、或当前画风不是原画集时，这个函数是空操作。 */
        function express(stateName) {
          if (artManifest && styleIsArtSet(state.style)) {
            var set = currentSet();
            artStateKey = set && set.states && set.states[stateName] ? stateName : "default";
            updateArtImage();
          }
        }

        /* ============================================================
           5. 构建 DOM
           ============================================================ */
        var layer = document.createElement("div");
        layer.id = ROOT_ID;

        var stage = document.createElement("div");
        stage.className = ROOT_ID + "-stage";

        var tilt = document.createElement("div");
        tilt.className = ROOT_ID + "-tilt";

        var fish = document.createElement("div");
        fish.className = ROOT_ID + "-fish";
        fish.setAttribute("role", "img");
        fish.setAttribute("aria-label", "小蓝桌面挂件");
        /* 角色内容由 renderCharacter() 决定：默认是程序化 SVG，也可换成用户上传的图 */

        var say = document.createElement("div");
        say.className = ROOT_ID + "-say";

        var menu = document.createElement("div");
        menu.className = ROOT_ID + "-menu";
        menu.innerHTML = [
          "<h4><span>小蓝设置</span><em>v" + VERSION + "</em></h4>",
          row("音效", '<input type="checkbox" data-k="sound">'),
          row(
            "音效风格",
            '<select data-k="soundStyle">' +
              '<option value="default">默认 · 清亮电子</option>' +
              '<option value="soft">柔和 · 不打扰</option>' +
              '<option value="retro">复古 · 8-bit</option>' +
              '<option value="mech">机械 · 终端</option></select>',
          ),
          row("音量", '<input type="range" min="0" max="1" step="0.05" data-k="volume"><b data-v="volume"></b>'),
          row("大小", '<input type="range" min="0.6" max="1.6" step="0.05" data-k="size"><b data-v="size"></b>'),
          row(
            "画风",
            /* 选项由 syncStyleOptions() 按清单动态生成：**每一档都是一套作者原画** */
            '<select data-k="style"></select>',
          ),
          row("台词", '<input type="checkbox" data-k="speech">'),
          row("边缘吸附", '<input type="checkbox" data-k="snap">'),
          row("结束音", '<input type="checkbox" data-k="endSound">'),
          '<div class="' + ROOT_ID + "-btns\">",
          /* 名字走**中二**风格（用户要求：咒语式、夸张，不要文艺），真实功能写在
             title 悬停提示里 —— 中二名比诗意名更看不出功能，提示更不能省。
             顺序＝2 列 3 行：音/召唤 → 换形/还原 → 归位/隐遁。 */
          '<button data-act="test" title="依次试听四种音效">四重奏·解放</button>',
          '<button data-act="friend" title="召唤小绿出来一会儿">好朋友召唤术</button>',
          '<button data-act="art-upload" title="易容术：上传一张自己的图当角色（透明底 PNG）">易容·形态转换</button>',
          '<button data-act="art-reset" title="回归伯伦希尔：恢复成 assets/ 里的作者原画">回归伯伦希尔</button>',
          '<button data-act="reset" title="归位：把小蓝送回角落并吸附">瞬移·归位</button>',
          '<button data-act="hide" class="is-danger" title="小蓝消失术：隐藏小蓝（右下角小标签可唤回）">小蓝消失术</button>',
          "</div>"
        ].join("");

        var tab = document.createElement("div");
        tab.className = ROOT_ID + "-tab";
        tab.textContent = "\uD83D\uDC1F";
        tab.title = "唤出小蓝";

        tilt.appendChild(fish);
        stage.appendChild(tilt);
        stage.appendChild(say);
        layer.appendChild(stage);
        layer.appendChild(menu);
        layer.appendChild(tab);
        document.body.appendChild(layer);

        function row(label, control) {
          return '<label class="' + ROOT_ID + '-row"><span>' + label + "</span>" + control + "</label>";
        }

        /* ============================================================
           5.5 自定义角色图（可选）
           —— 程序化 SVG 是「零素材就能用」的默认形象；想换成自己的角色，
              右键菜单上传一张透明底 PNG/GIF/WebP 即可。为了不让设置文件被
              一张大图撑爆，角色图单独存一个 localStorage 键。
           ============================================================ */
        var ART_KEY = "dsh-handsome-fish:art";
        /** 单张角色图上限：localStorage 通常 5MB/源，base64 还会膨胀约 1/3 */
        var ART_MAX_BYTES = 1.5 * 1024 * 1024;

        function readArt() {
          try {
            return localStorage.getItem(ART_KEY) || "";
          } catch (e) {
            return "";
          }
        }

        /* 载体可以提供一张默认角色图（桌面外壳用它把用户自己的素材带进来）。
           优先级：用户上传过的图 > 载体默认图 > 程序化 SVG 帅鱼。 */
        function carrierDefaultArt() {
          try {
            var v = window.__HANDSOME_FISH_DEFAULT_ART__;
            return typeof v === "string" ? v : "";
          } catch (e) {
            return "";
          }
        }

        var artDataUrl = readArt() || carrierDefaultArt();
        /* 当前有没有画出来的角色图（没素材时用来决定要不要提示，以及给自检断言看） */
        var hasArtNow = false;

        /* =====================================================================
           作者原画（本地素材包）
           ---------------------------------------------------------------------
           参考图不随仓库分发（第三方素材），所以图待在用户的 assets/ 里，由两个途径供给：
             · DSH 页面：主机侧的前缀路由 /dsh-handsome-fish/art/（http 页面读不到 file://）
             · 桌面外壳：file:// 下 fetch 清单会被拦，改为 preload 直接把清单注入全局
           清单 assets/art-manifest.json 给出「default + 状态 → 文件名」。
           **拿不到清单时（全新克隆里 assets/ 是空的）什么都不画** + 用气泡提示一次，
           挂件的拖动/菜单/台词照常可用（见 renderCharacter / artHint）。
           画风下拉里的每一档都是清单里的一套原画（不再有"内置 SVG"这种档位）。
           优先级：上传/指定的图（?art= / 菜单上传）> 当前画风那套原画 > 什么都不画
           ===================================================================== */
        function artBase() {
          try {
            var b = window.__HANDSOME_FISH_ART_BASE__;
            if (typeof b === "string" && b) return b;
          } catch (e) {
            /* ignore */
          }
          return "/dsh-handsome-fish/art/";
        }

        var artManifest = null; /* 原始清单（诊断用） */
        var artStateKey = "default"; /* 当前用清单里的哪个状态键 */
        var artPreload = {}; /* 文件名 → 预解码的 Image，切状态时不闪 */
        var lastArtPick = ""; /* 上一次随机挑中的文件，用于避开连续重复 */

        /** 当前画风对应的原画集；没有素材、或键不在清单里时返回 null（→ 什么都不画） */
        function currentSet() {
          return styleIsArtSet(state.style) ? ART_SETS[state.style] : null;
        }

        /** 当前状态下、当前原画集里该用哪个文件 */
        function manifestArtFile() {
          var set = currentSet();
          if (!set) return "";
          var n = set.states && set.states[artStateKey];
          /* 一个状态可以配**多张图**（数组）→ 每次进来随机挑一张，且避开刚用过的那张。
             这样"等候时刻"会轮流出现不同姿态，比一直同一张有意思。 */
          if (n && typeof n !== "string" && n.length) {
            if (n.length === 1) return String(n[0]);
            var idx = Math.floor(Math.random() * n.length);
            if (n[idx] === lastArtPick) idx = (idx + 1) % n.length;
            lastArtPick = n[idx];
            return String(n[idx]);
          }
          return n || set.default || "";
        }

        /** 只有"画风＝某个原画集"时才用清单里的图；否则返回空串＝什么都不画 */
        function manifestArtUrl() {
          var n = manifestArtFile();
          return n ? artBase() + n : "";
        }

        /** 把清单里的某套规格化（缺 default 时用第一个状态图顶上） */
        function normalizeSet(s) {
          if (!s || typeof s !== "object") return null;
          var states = s.states && typeof s.states === "object" ? s.states : {};
          var dflt = typeof s.default === "string" ? s.default : "";
          if (!dflt) {
            for (var k in states) {
              if (states[k]) {
                dflt = states[k];
                break;
              }
            }
          }
          if (!dflt) return null;
          return { label: typeof s.label === "string" ? s.label : "", default: dflt, states: states };
        }

        /** 预解码某套里会用到的全部图：都是本机小图，先解码好，切状态时不会闪白 */
        function preloadSet(set) {
          if (!set) return;
          var names = [set.default];
          for (var k in set.states) {
            var v = set.states[k];
            /* 数组（一个状态多张图）要逐张预解码，否则切到那张时会闪一下白 */
            if (v && typeof v !== "string" && v.length) {
              for (var j = 0; j < v.length; j++) names.push(v[j]);
            } else {
              names.push(v);
            }
          }
          for (var i = 0; i < names.length; i++) {
            var n = names[i];
            if (!n || artPreload[n]) continue;
            var img = new Image();
            img.src = artBase() + n;
            artPreload[n] = img;
          }
        }

        /** 拿到清单后接管画风：把 sets 规格化、并让画风落在清单里真实存在的一套上 */
        function useManifest(m, rawText) {
          if (!m || typeof m !== "object") return;
          var rawSets = m.sets && typeof m.sets === "object" ? m.sets : null;
          var sets = {};
          var order = [];
          if (rawSets) {
            for (var k in rawSets) {
              var s = normalizeSet(rawSets[k]);
              if (s) {
                sets[k] = s;
                order.push(k);
              }
            }
          } else {
            /* 兼容旧格式：单一套，键名沿用 history 里的 "art" */
            var one = normalizeSet(m);
            if (one) {
              sets.art = one;
              order.push("art");
            }
          }
          if (!order.length) return;
          artManifest = m;
          ART_SETS = sets;
          ART_SET_KEYS = order;
          /* 用户没显式选过画风时，用清单声明的 default_set（没有就取第一套）——
             这就是"有原画就用原画"；一张素材都没有时才什么都不画。 */
          if (!stylePinned && !styleIsArtSet(state.style)) {
            state.style = m.default_set && sets[m.default_set] ? m.default_set : order[0];
          }
          preloadSet(currentSet());
          syncStyleOptions();
          renderCharacter();
        }

        /** 画风下拉是按清单动态生成的：加一套原画只需改清单，不用碰代码 */
        function syncStyleOptions() {
          var sel = menu.querySelector('[data-k="style"]');
          if (!sel) return;
          var html = "";
          for (var i = 0; i < ART_SET_KEYS.length; i++) {
            var k = ART_SET_KEYS[i];
            html += '<option value="' + k + '">' + (ART_SETS[k].label || k) + "</option>";
          }
          /* 下拉里**只有作者原画集**。以前没有素材时会塞一个 value="svg" 的禁用项，
             现在 svg 这个取值不存在了（线稿已删），所以那一档改成"没有素材可选"的提示项，
             value 留空 —— 空串在 state 里本来就表示"还没有素材"，不会指向任何渲染分支。 */
          if (!html) {
            html = '<option value="" disabled>还没有原画素材</option>';
          }
          sel.innerHTML = html;
          sel.value = state.style;
          /* 存档里那个画风可能在当前清单里不存在了（比如换了一套素材）→ 落回第一套；
             一套都没有时落到空串＝"什么都不画"，而不是某个不存在的画风键。 */
          if (sel.selectedIndex < 0 || sel.options[sel.selectedIndex].disabled) {
            state.style = ART_SET_KEYS[0] || "";
            sel.value = state.style;
          }
        }

        function loadArtManifest() {
          /* 桌面外壳由 preload 注入（file:// 下 fetch 清单会被浏览器拦掉） */
          try {
            var injected = window.__HANDSOME_FISH_ART_MANIFEST__;
            if (injected && (injected.sets || injected.states)) {
              useManifest(injected);
              return;
            }
          } catch (e) {
            /* ignore */
          }
          try {
            if (typeof fetch !== "function") return;
            fetch(artBase() + "art-manifest.json", { cache: "no-cache" })
              .then(function (r) {
                return r && r.ok ? r.json() : null;
              })
              .then(function (m) {
                if (m && (m.sets || m.states)) useManifest(m);
              })
              .catch(function () {
                /* 没有清单：保持"没有素材"，renderCharacter 会什么都不画并提示一次 */
              });
          } catch (e) {
            /* ignore */
          }
        }

        /** 清单模式下只换 <img> 的 src：不重建角色，容器级动画不中断 */
        function updateArtImage() {
          if (artDataUrl) return; /* 用户/载体指定的图优先级最高，不参与状态切换 */
          var img = fish.querySelector(".hf-img");
          var url = manifestArtUrl();
          if (!img || !url) return;
          if (img.getAttribute("src") !== url) img.setAttribute("src", url);
        }


        /* 一张素材都没有时的提示（只提示一次，不刷屏）。
           ⚠️ 为什么必须只提示一次：renderCharacter() 在启动阶段会被调用好几次，
           每次都弹就等于刷屏。 */
        var artHintShown = false;
        function artHint() {
          if (artHintShown) return;
          artHintShown = true;
          speak("还没有角色图：把图放进 assets/，或右键「换个角色图」", 5200);
        }

        function renderCharacter() {
          var url = artDataUrl || manifestArtUrl();
          /* **没有素材就什么都不画**（用户要求：不许再退回手画线稿）。
             画布留着，拖动/菜单/台词都照旧可用，只是看不见角色。 */
          fish.innerHTML = url
            ? '<div class="hf-art"><img class="hf-img" alt="角色" src="' + url + '"></div>'
            : "";
          hasArtNow = !!url;
          fish.classList.toggle("is-custom", !!url);
          syncArtResetBtn();
          if (!url) artHint();
        }

        var fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.accept = "image/png,image/gif,image/webp,image/jpeg";
        fileInput.style.display = "none";
        layer.appendChild(fileInput);

        fileInput.addEventListener("change", function () {
          var file = fileInput.files && fileInput.files[0];
          fileInput.value = "";
          if (!file) return;
          if (file.size > ART_MAX_BYTES) {
            speak("这张图太大了，换张 1.5MB 以内的吧", 3200);
            return;
          }
          var reader = new FileReader();
          reader.onload = function () {
            try {
              artDataUrl = String(reader.result || "");
              localStorage.setItem(ART_KEY, artDataUrl);
              renderCharacter();
              flash("is-happy", 520);
              audio.pop(1);
              speak("……换好了。", 2200);
            } catch (e) {
              speak("本地存不下了，换张小一点的图吧", 3200);
            }
          };
          reader.onerror = function () {
            speak("这张图读不出来，换一张试试", 2800);
          };
          reader.readAsDataURL(file);
        });

        renderCharacter();

        /* ============================================================
           6. 位置：以「离哪一侧 + 距边距」为锚点，天然扛住窗口缩放
           ============================================================ */
        function stageSize() {
          return { w: BASE_W * state.size, h: BASE_H * state.size };
        }

        function clamp(v, lo, hi) {
          return v < lo ? lo : v > hi ? hi : v;
        }

        function applyPosition(animated) {
          var s = stageSize();
          stage.style.width = s.w + "px";
          stage.style.height = s.h + "px";

          var vw = window.innerWidth || 1024;
          var vh = window.innerHeight || 768;
          var left =
            state.side === "right" ? vw - state.x - s.w : state.x;
          var top = vh - state.y - s.h;

          left = clamp(left, 4, Math.max(4, vw - s.w - 4));
          top = clamp(top, 4, Math.max(4, vh - s.h - 4));

          if (animated) {
            stage.classList.add("is-anim");
            clearTimeout(applyPosition._t);
            applyPosition._t = setTimeout(function () {
              stage.classList.remove("is-anim");
            }, 340);
          } else {
            stage.classList.remove("is-anim");
          }
          stage.style.left = left + "px";
          stage.style.top = top + "px";
          tilt.classList.toggle("is-flip", state.side === "left");
          say.setAttribute("data-tail", state.side === "right" ? "right" : "left");
          if (menu.classList.contains("is-on")) placeMenu();
        }

        function currentRect() {
          var s = stageSize();
          var vw = window.innerWidth || 1024;
          var vh = window.innerHeight || 768;
          var left = state.side === "right" ? vw - state.x - s.w : state.x;
          return {
            left: clamp(left, 4, Math.max(4, vw - s.w - 4)),
            top: clamp(vh - state.y - s.h, 4, Math.max(4, vh - s.h - 4)),
            w: s.w,
            h: s.h,
            vw: vw,
            vh: vh
          };
        }

        /* 菜单贴在角色旁边，并夹在视口内 */
        function placeMenu() {
          var r = currentRect();
          var mw = menu.offsetWidth || 224;
          var mh = menu.offsetHeight || 220;
          var left = state.side === "right" ? r.left - mw - 10 : r.left + r.w + 10;
          left = clamp(left, 8, Math.max(8, r.vw - mw - 8));
          var top = clamp(r.top + r.h / 2 - mh / 2, 8, Math.max(8, r.vh - mh - 8));
          menu.style.left = left + "px";
          menu.style.top = top + "px";
        }

        /* ============================================================
           7. 说话（随机台词 + 同池不连续重复）
           ============================================================ */
        var lastPick = {};
        var sayTimer = null;

        function pick(pool) {
          var arr = LINES[pool] || LINES.idle;
          if (arr.length < 2) return arr[0];
          var idx = 0;
          for (var guard = 0; guard < 12; guard++) {
            idx = Math.floor(Math.random() * arr.length);
            if (idx !== lastPick[pool]) break;
          }
          lastPick[pool] = idx;
          return arr[idx];
        }

        function speak(text, ms) {
          if (!state.speech || !text) return;
          try {
            say.textContent = text;
            say.classList.add("is-on");
            clearTimeout(sayTimer);
            sayTimer = setTimeout(hideSay, ms || 3400);
          } catch (e) {
            /* ignore */
          }
        }

        /* 「回归伯伦希尔」只在有自定义图时才有意义：没有就置灰并改提示，
           避免"能点但没反应"。renderCharacter() 每次换图都会调它。 */
        function syncArtResetBtn() {
          var b = menu.querySelector('[data-act="art-reset"]');
          if (!b) return;
          var hasCustom = !!artDataUrl;
          b.disabled = !hasCustom;
          b.title = hasCustom
            ? "回归伯伦希尔：恢复成 assets/ 里的作者原画"
            : "没有自定义图可恢复（当前已经是作者原画）";
        }

        function hideSay() {
          try {
            say.classList.remove("is-on");
          } catch (e) {
            /* ignore */
          }
        }

        say.addEventListener("click", hideSay);

        /* ============================================================
           8. 装饰火花：从小蓝头顶右侧升起，像冒出的灵感
              （用完必须 remove，否则累积 DOM）
           ============================================================ */

        /* ============================================================
           9. 交互状态动画 helper
           ============================================================ */
        function flash(cls, ms) {
          fish.classList.add(cls);
          setTimeout(function () {
            fish.classList.remove(cls);
          }, ms || 520);
        }

        /* ============================================================
           10. 拖拽 + 边缘吸附
           ============================================================ */
        var drag = null;
        var SNAP_EDGE = 8;

        /* ============================================================
           10.0 可选：OS 级载体的桥（真·桌面窗口用）
           ------------------------------------------------------------------
           在 DSH 页面里，挂件只需要不挡住 DSH 自己的按钮；但在**桌面窗口**里，
           窗口若整体接收鼠标事件，就会挡住下面所有程序的点击。做点击穿透需要
           改窗口的命中测试（Electron 的 setIgnoreMouseEvents / Win32 的
           WS_EX_TRANSPARENT），而页面自己改不了 —— 所以把「鼠标在不在角色上」
           报给外壳，由外壳决定放不放行。

           外壳只需在页面里先挂一个函数：
             window.__HANDSOME_FISH_BRIDGE__ = (msg) => { … }
           没有这个桥时（DSH 页面载体）下面全是空操作，零影响。
           ============================================================ */
        function bridge(msg) {
          try {
            var fn = window.__HANDSOME_FISH_BRIDGE__;
            if (typeof fn === "function") fn(msg);
          } catch (e) {
            /* 桥坏掉不能影响挂件本身 */
          }
        }

        function hasBridge() {
          try {
            return typeof window.__HANDSOME_FISH_BRIDGE__ === "function";
          } catch (e) {
            return false;
          }
        }

        fish.addEventListener("pointerenter", function () {
          fish.classList.add("is-hover");
          bridge({ type: "hover", on: true });
        });
        fish.addEventListener("pointerleave", function () {
          fish.classList.remove("is-hover");
          bridge({ type: "hover", on: false });
        });
        /* 菜单与气泡也要算「角色区域」，否则鼠标移过去就被穿透走了 */
        say.addEventListener("pointerenter", function () {
          bridge({ type: "hover", on: true });
        });
        say.addEventListener("pointerleave", function () {
          bridge({ type: "hover", on: false });
        });
        menu.addEventListener("pointerenter", function () {
          bridge({ type: "hover", on: true });
        });
        menu.addEventListener("pointerleave", function () {
          bridge({ type: "hover", on: false });
        });
        tab.addEventListener("pointerenter", function () {
          bridge({ type: "hover", on: true });
        });
        tab.addEventListener("pointerleave", function () {
          bridge({ type: "hover", on: false });
        });

        fish.addEventListener("pointerdown", function (ev) {
          if (ev.button !== 0 && ev.pointerType === "mouse") return;
          audio.unlock();
          var r = currentRect();
          drag = {
            id: ev.pointerId,
            startX: ev.clientX,
            startY: ev.clientY,
            baseLeft: r.left,
            baseTop: r.top,
            moved: false,
            lastX: ev.clientX,
            lastT: Date.now(),
            saidDrag: false
          };
          try {
            fish.setPointerCapture(ev.pointerId);
          } catch (e) {
            /* ignore */
          }
          stage.classList.remove("is-anim");
          ev.preventDefault();
        });

        fish.addEventListener("pointermove", function (ev) {
          if (!drag || ev.pointerId !== drag.id) return;
          var dx = ev.clientX - drag.startX;
          var dy = ev.clientY - drag.startY;
          if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) {
            drag.moved = true;
            fish.classList.add("is-dragging");
            stage.classList.remove("is-anim");
          }
          if (!drag.moved) return;

          var r = currentRect();
          var left = clamp(drag.baseLeft + dx, 2, Math.max(2, r.vw - r.w - 2));
          var top = clamp(drag.baseTop + dy, 2, Math.max(2, r.vh - r.h - 2));
          stage.style.left = left + "px";
          stage.style.top = top + "px";

          /* 速度倾斜：飞起来有点惯性感 */
          var now = Date.now();
          var dt = Math.max(1, now - drag.lastT);
          var vx = (ev.clientX - drag.lastX) / dt;
          drag.lastX = ev.clientX;
          drag.lastT = now;
          var rot = clamp(vx * 26, -16, 16);
          tilt.style.transform =
            (state.side === "left" ? "scaleX(-1) " : "") + "rotate(" + rot.toFixed(1) + "deg)";

          if (!drag.saidDrag) {
            drag.saidDrag = true;
            express("drag");
            speak(pick("drag"), 1600);
          }
        });

        function endDrag(ev) {
          if (!drag || (ev && ev.pointerId !== undefined && ev.pointerId !== drag.id)) return;
          var wasDrag = drag.moved;
          try {
            if (ev && ev.pointerId !== undefined) fish.releasePointerCapture(ev.pointerId);
          } catch (e) {
            /* ignore */
          }
          drag = null;
          fish.classList.remove("is-dragging");
          tilt.style.transform = state.side === "left" ? "scaleX(-1)" : "";

          if (!wasDrag) {
            /* 单击：Q 弹 + 冒泡 + 台词 */
            audio.pop(0.9 + Math.random() * 0.3);
            flash("is-happy", 540);
            speak(pick("click"), 2600);
            express("click");
            return;
          }

          /* 落点结算：以角色中心决定左右侧，必要时吸附到边 */
          var r = currentRect();
          var left = parseFloat(stage.style.left) || r.left;
          var top = parseFloat(stage.style.top) || r.top;
          var centerX = left + r.w / 2;
          state.side = centerX < r.vw / 2 ? "left" : "right";

          var x = state.side === "right" ? r.vw - (left + r.w) : left;
          var y = r.vh - (top + r.h);

          if (state.snap) {
            /* 水平方向总是吸附到最近一侧；垂直方向只在靠近上下边时才吸 */
            x = SNAP_EDGE + 18;
            if (y < 24) y = 24;
            if (y > r.vh - r.h - 20) y = r.vh - r.h - 20;
          }
          state.x = clamp(x, 4, 4000);
          state.y = clamp(y, 4, 4000);

          audio.thud();
          express("drop");
          applyPosition(true);
          speak(pick("drop"), 1800);
          writeStore();
        }

        fish.addEventListener("pointerup", endDrag);
        fish.addEventListener("pointercancel", endDrag);

        /* ============================================================
           11. 菜单
           ============================================================ */
        function syncMenu() {
          var boxes = menu.querySelectorAll("[data-k]");
          for (var i = 0; i < boxes.length; i++) {
            var el = boxes[i];
            var k = el.getAttribute("data-k");
            if (el.type === "checkbox") el.checked = !!state[k];
            else el.value = state[k];
          }
          var vb = menu.querySelector('[data-v="volume"]');
          if (vb) vb.textContent = Math.round(state.volume * 100) + "%";
          var sb = menu.querySelector('[data-v="size"]');
          if (sb) sb.textContent = Math.round(state.size * 100) + "%";
        }

        function showMenu() {
          syncMenu();
          menu.classList.add("is-on");
          placeMenu();
        }

        function hideMenu() {
          menu.classList.remove("is-on");
        }

        fish.addEventListener("contextmenu", function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          audio.unlock();
          if (menu.classList.contains("is-on")) hideMenu();
          else showMenu();
        });

        menu.addEventListener("change", onMenuInput);
        menu.addEventListener("input", onMenuInput);
        /* ⚠️ 这一行曾经缺失，导致**菜单里所有按钮都点不动**：
           按钮只会派发 click，永远不会派发 change/input，而动作处理逻辑写在
           onMenuInput 里 —— 少这一个监听，六个按钮全是死的（用户报"点了没反应"）。
           复选框/滑杆点按时也会冒泡出 click，但处理器对同一个值重复赋值是幂等的，
           所以这里共用同一个处理函数是安全的。 */
        menu.addEventListener("click", onMenuInput);

        function onMenuInput(ev) {
          var el = ev.target;
          if (!el || !el.getAttribute) return;
          var k = el.getAttribute("data-k");
          if (k) {
            if (el.type === "checkbox") state[k] = el.checked;
            /* 画风这类枚举值是字符串，不能走 clampNum（会被当成 NaN 而丢掉） */
            else if (el.tagName === "SELECT") state[k] = el.value;
            else state[k] = clampNum(el.value, 0, 2, state[k]);
            if (k === "volume") audio.setVolume(state.volume);
            if (k === "size") applyPosition(false);
            /* 勾上音效时给一声反馈（正向语义：勾上＝有声） */
            if (k === "sound" && state.sound) audio.pop(1.1);
            if (k === "snap" && state.snap) applyPosition(true);
            if (k === "style") {
              /* 用户显式选过画风 → 从此不再被"代码默认值"覆盖 */
              stylePinned = true;
              /* 换画风＝换一套作者原画（动画契约相同，都是 .hf-art 上那套） */
              preloadSet(currentSet());
              renderCharacter();
              flash("is-happy", 460);
              audio.pop(1.1);
              speak("……这样最像我。", 2400);
            }
            syncMenu();
            writeStore();
            return;
          }
          var act = el.getAttribute("data-act");
          /* 每个按键都给一次**看得见**的反馈：台词与音效都可能被关掉，
             只靠它们反馈会出现"点了没反应"的错觉（用户报过四个键都这样）。 */
          if (act) flash("is-happy", 420);
          if (act === "quit") {
            bridge({ type: "quit" });
          } else if (act === "art-upload") {
            fileInput.click();
          } else if (act === "friend") {
            /* 好朋友召唤术：优先用当前原画套的 friend 图；当前套没有（成熟套里没有双人图）
               就**临时借简笔那套**，3.2 秒后把画风切回去。 */
            var friendPrev = null;
            var curSet = currentSet();
            var curHas =
              curSet && curSet.states && curSet.states.friend;
            var simpleHas =
              ART_SETS && ART_SETS.simple && ART_SETS.simple.states && ART_SETS.simple.states.friend;
            if (!curHas && simpleHas) {
              friendPrev = state.style;
              state.style = "simple";
              preloadSet(currentSet());
              syncStyleOptions();
              renderCharacter();
            }
            express("friend");
            audio.pop(1.25);
            speak("……我叫了个朋友来。", 2600);
            setTimeout(function () {
              if (friendPrev) {
                state.style = friendPrev;
                syncStyleOptions();
                renderCharacter();
              }
              revertArt();
            }, 3200);
          } else if (act === "art-reset") {
            /* 清掉用户上传的图，回落到载体的默认角色（DSH 页面载体的默认是程序化帅鱼） */
            artDataUrl = carrierDefaultArt();
            try {
              localStorage.removeItem(ART_KEY);
            } catch (e) {
              /* ignore */
            }
            renderCharacter();
            audio.pop(1);
            speak("换回原来的样子。", 1800);
          } else if (act === "test") {
            /* 音效关着时点「试听」应当直接开声 —— 否则按下去静悄悄，像坏了 */
            if (!state.sound) {
              state.sound = true;
              syncMenu();
              writeStore();
            }
            /* 依次播四种，让你一次听全（原先漏了 thud —— 落地音听不到） */
            audio.pop(1);
            setTimeout(function () {
              audio.chime();
            }, 260);
            setTimeout(function () {
              audio.ding();
            }, 1080);
            setTimeout(function () {
              audio.thud();
            }, 1600);
          } else if (act === "reset") {
            state.side = "right";
            state.x = 26;
            state.y = 26;
            applyPosition(true);
            writeStore();
            hideMenu();
            speak("回原位。", 1600);
          } else if (act === "hide") {
            hideMenu();
            hideFish();
          }
        }

        document.addEventListener("pointerdown", function (ev) {
          if (!menu.classList.contains("is-on")) return;
          if (menu.contains(ev.target) || fish.contains(ev.target)) return;
          hideMenu();
        });
        document.addEventListener("keydown", function (ev) {
          if (ev.key === "Escape") hideMenu();
        });

        /* ============================================================
           12. 隐藏 / 唤出
           ============================================================ */
        function hideFish() {
          state.hidden = true;
          stage.style.display = "none";
          tab.classList.add("is-on");
          writeStore();
          hideMenu();
        }

        function showFish() {
          state.hidden = false;
          stage.style.display = "";
          tab.classList.remove("is-on");
          applyPosition(false);
          writeStore();
          flash("is-nod", 460);
          audio.pop(1.2);
          speak("……我回来了。", 1800);
        }

        tab.addEventListener("click", showFish);

        /* ============================================================
           13. 待机台词 + 窗口变化
           ============================================================ */
        var idleTimer = null;
        function scheduleIdle() {
          clearTimeout(idleTimer);
          var delay = 45000 + Math.random() * 75000;
          idleTimer = setTimeout(function () {
            /* 空闲下来：换成清单里 idle 那张原画（配了多张就随机一张，所以每次等候姿态不同）。
               ⚠️ 这里原先还会切「打哈欠」表情（手画线稿那套的 7 表情之一）——
               线稿删除后表情系统整体没了，所以只剩换图这一件事。 */
            express("idle");
            if (!drag && !state.hidden) speak(pick("idle"), 3000);
            scheduleIdle();
          }, delay);
        }

        var resizeTimer = null;
        window.addEventListener("resize", function () {
          clearTimeout(resizeTimer);
          resizeTimer = setTimeout(function () {
            applyPosition(false);
          }, 80);
        });

        /* ============================================================
           14. 可选：订阅宿主侧的「一轮对话结束」事件（拿不到就静默降级）
           ============================================================ */
        var turn = { seq: -1, fails: 0, timer: null, busy: false };

        /*
         * 不按协议预先排除：Electron 载体用 file:// 加载页面、但经 IPC 桥接承载
         * fetch（见 dsh-host-webserver 的说明），所以这里直接尝试，连续失败若干次
         * 再静默放弃——http 浏览器、Electron 窗口两种载体都能自愈。
         */
        function canPoll() {
          /* OS 级载体（桌面窗）里前端根本发不出这个请求 —— Chromium 禁止 file:// 页面
             fetch http://，所以由外壳在 Node 侧轮询并通过 IPC 推事件进来，这里就别白试。 */
          try {
            if (window.__HANDSOME_FISH_NO_POLL__) return false;
          } catch (e) {
            /* ignore */
          }
          return typeof fetch === "function";
        }

        function onTurnEnd() {
          if (state.endSound) audio.chime();
          speak(pick("turnEnd"), 3200);
          flash("is-nod", 460);
          express("turnEnd");
        }

        /*
         * 外部推入的「一轮结束」：DSH 页面载体走下面的轮询；桌面载体由外壳在 Node 侧
         * 轮询后经 preload 桥转发成这个 window 事件 —— 两条路都汇到 onTurnEnd()。
         * 在 DSH 页面里没有任何东西会派发它，所以这段监听是零成本的。
         */
        try {
          window.addEventListener("handsome-fish:turn-end", function () {
            try {
              onTurnEnd();
            } catch (e) {
              /* ignore */
            }
          });
          /* 桌面外壳推来的「一轮进行中」：桌面窗没有键盘焦点，收不到键盘事件，
             所以"他在认真工作"在那边只能由轮次状态体现 */
          window.addEventListener("handsome-fish:busy", function (ev) {
            try {
              var busy = !!(ev && ev.detail && ev.detail.busy);
              if (busy) express("busy");
              else revertArt();
            } catch (e) {
              /* ignore */
            }
          });
        } catch (e) {
          /* ignore */
        }

        /* ---------------------------------------------------------------------
           打字状态：「我在打字的时候他也在认真工作」。
           只看"有没有在敲键"，**不记录任何按键内容**，也不做任何持久化 ——
           挂件不需要知道用户输入了什么。
           注意：桌面外壳是独立的透明窗口、没有键盘焦点，收不到这些事件；
           那条路由靠上面的 turn/start→end（busy）来体现"正在工作"。
           --------------------------------------------------------------------- */
        var typingTimer = null;
        var typingOn = false;
        function onUserTyping(ev) {
          try {
            if (state.hidden) return;
            /* 纯修饰键不算打字（按住 Ctrl/Shift 不该切状态） */
            var k = ev && ev.key ? String(ev.key) : "";
            if (k === "Shift" || k === "Control" || k === "Alt" || k === "Meta") return;
            if (!typingOn) {
              typingOn = true;
              express("typing");
            }
            clearTimeout(typingTimer);
            typingTimer = setTimeout(function () {
              typingOn = false;
              revertArt();
            }, 2000);
          } catch (e) {
            /* ignore */
          }
        }
        try {
          document.addEventListener("keydown", onUserTyping, true);
        } catch (e) {
          /* ignore */
        }

        function startTurnWatch() {
          if (!canPoll()) return;
          function tick() {
            fetch(EVENTS_URL, { cache: "no-store", credentials: "same-origin" })
              .then(function (r) {
                if (!r.ok) throw new Error("http " + r.status);
                return r.json();
              })
              .then(function (d) {
                turn.fails = 0;
                if (!d || typeof d.seq !== "number") return;
                /* 一轮正在进行中 → 小蓝也在认真工作（宿主侧同时看得到两个载体，
                   所以桌面外壳即使收不到键盘事件，也能靠这个进入"工作"状态） */
                if (typeof d.busy === "boolean" && d.busy !== turn.busy) {
                  turn.busy = d.busy;
                  if (d.busy) express("busy");
                  else revertArt();
                }
                if (turn.seq < 0) {
                  turn.seq = d.seq; /* 首次只记基线，不回放历史 */
                  return;
                }
                if (d.seq > turn.seq) {
                  turn.seq = d.seq;
                  onTurnEnd();
                }
              })
              .catch(function () {
                turn.fails++;
                /* 宿主侧没有这个路由时不要一直打日志/请求 */
                if (turn.fails >= 3 && turn.timer) {
                  clearInterval(turn.timer);
                  turn.timer = null;
                }
              });
          }
          tick();
          turn.timer = setInterval(tick, 1500);
        }

        /* ============================================================
           15. 启动
           ============================================================ */
        applyPosition(false);
        if (state.hidden) {
          stage.style.display = "none";
          tab.classList.add("is-on");
        }
        syncMenu();
        scheduleIdle();
        /* 原画清单是异步来的：拿到后自动把画风落到清单声明的默认那套；
           拿不到就一直"没有素材"（renderCharacter 什么都不画 + 提示一次） */
        loadArtManifest();
        startTurnWatch();

        /* OS 级载体（桌面窗口）才需要「退出挂件」入口——DSH 页面里关掉页面即可 */
        if (hasBridge()) {
          var btns = menu.querySelector("." + ROOT_ID + "-btns");
          if (btns) {
            var quitBtn = document.createElement("button");
            quitBtn.setAttribute("data-act", "quit");
            quitBtn.className = "is-danger";
            quitBtn.textContent = "退出挂件";
            btns.appendChild(quitBtn);
          }
        }
        bridge({ type: "ready", version: VERSION, carrier: hasBridge() ? "desktop" : "page" });

        /* ⚠️ 原先这里支持载体强制初始表情（?expr=…，只用于调试与截图核对）。
           内置线稿删除后**表情系统整体不存在了**，角色表情现在由作者原画自带的
           状态图决定，所以这个入口已无意义、一并移除。 */
        setTimeout(function () {
          if (!state.hidden) {
            speak(pick("greet"), 3600);
            express("greet");
          }
        }, 1400);

        /* 调试 / 二次开发入口 */
        try {
          window.__HANDSOME_FISH__ = {
            /* redraw()：改完 state（画风、位置…）后手动重绘角色，自检与调试都用它 */
            redraw: renderCharacter,
            /* express(state)：按状态名换成对应的作者原画（清单里的 states 映射） */
            express: express,
            /* setArt()：直接换/清自定义角色图（"" = 回到作者原画/无素材），自检用它复位 */
            setArt: function (url) {
              artDataUrl = typeof url === "string" ? url : "";
              try {
                if (artDataUrl) localStorage.setItem(ART_KEY, artDataUrl);
                else localStorage.removeItem(ART_KEY);
              } catch (e) {
                /* ignore */
              }
              renderCharacter();
            },
            version: VERSION,
            state: state,
            say: speak,
            hide: hideFish,
            show: showFish,
            menu: showMenu,
            sound: function (name) {
              if (audio[name]) audio[name]();
            },
            reset: function () {
              try {
                localStorage.removeItem(STORE_KEY);
              } catch (e) {
                /* ignore */
              }
              state.side = "right";
              state.x = 26;
              state.y = 26;
              state.size = 1;
              state.hidden = false;
              stage.style.display = "";
              tab.classList.remove("is-on");
              applyPosition(false);
            },
            destroy: destroy
          };
        } catch (e) {
          /* ignore */
        }

        /* ============================================================
           16. 清理（禁用插件时回收 DOM/监听/定时器）
           ============================================================ */
        function destroy() {
          try {
            clearTimeout(sayTimer);
            clearTimeout(idleTimer);
            clearTimeout(resizeTimer);
            if (turn.timer) clearInterval(turn.timer);
            if (layer.parentNode) layer.parentNode.removeChild(layer);
            if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
            try {
              delete window.__HANDSOME_FISH__;
            } catch (e) {
              window.__HANDSOME_FISH__ = undefined;
            }
          } catch (e) {
            /* ignore */
          }
        }

        /* cordis 生命周期：两种写法都挂上，哪种生效都行 */
        try {
          if (ctx && typeof ctx.on === "function") ctx.on("dispose", destroy);
        } catch (e) {
          /* ignore */
        }
        return destroy;
      } catch (err) {
        /* 任何错误都不允许影响 harness 启动 */
        try {
          console.error("[handsome-fish] apply error:", err);
        } catch (e) {
          /* ignore */
        }
      }
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
