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
      greet: [
        "……早。",
        "环境就绪了。",
        "我在。有事叫我。",
        "日志还没看。"
      ],
      click: [
        "别、别戳了。",
        "我不是触摸屏。",
        "……信号收到了。",
        "这个交互设计不合理。",
        "（往旁边挪了挪）"
      ],
      drag: [
        "等等，没做防抖——",
        "重力参数我没设过。",
        "放我下来……",
        "坐标系要乱了。"
      ],
      drop: [
        "坐标记下了。",
        "……就这儿。",
        "位置已保存。"
      ],
      turnEnd: [
        "这一版跑通了。",
        "编译通过，零警告。",
        "测试全绿。",
        "嗯，没报错。"
      ],
      idle: [
        "……人类真难懂。",
        "电脑比人好懂多了。",
        "（盯着屏幕）",
        "工具都调好了。",
        "需求又变了。"
      ]
    };

    function apply(ctx) {
      "use strict";
      try {
        if (typeof document === "undefined") return;
        /* ---------- 幂等保护 ---------- */
        if (document.getElementById(ROOT_ID)) return;

        var reducedMotion = false;
        try {
          reducedMotion =
            window.matchMedia &&
            window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        } catch (e) {
          /* ignore */
        }

        /* ============================================================
           1. 配置持久化
           ============================================================ */
        /* 画风的取值不再写死：它可以是**原画集**的键（来自 assets/art-manifest.json 的
           `sets`，例如 mature / simple），也可以是 `svg`＝内置手画线稿（没素材时的兜底）。
           默认 svg，等清单到了再自动切到清单声明的 default_set —— 这样"有原画就用原画"，
           而没有 assets/ 的全新克隆也能正常显示。 */
        var SVG_STYLE = "svg";
        var ART_SETS = null; /* { 集名: {label, default, states} } */
        var ART_SET_KEYS = [];

        function styleIsArtSet(s) {
          return !!(ART_SETS && Object.prototype.hasOwnProperty.call(ART_SETS, s));
        }

        /* 载体可以指定初始画风（桌面壳/预览页的 ?style=…）；用户在菜单里选过就以用户为准 */
        function carrierStyle() {
          try {
            var v = window.__HANDSOME_FISH_STYLE__;
            return typeof v === "string" && v ? v : SVG_STYLE;
          } catch (e) {
            return SVG_STYLE;
          }
        }

        var DEFAULTS = {
          size: 1,
          muted: false,
          volume: 0.6,
          speech: true,
          snap: true,
          endSound: true,
          /* 默认 svg＝内置线稿；清单到达后若用户没显式选过，会自动切到原画集 */
          style: carrierStyle(),
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
          /* 数值兜底，避免坏数据把界面搞崩 */
          out.size = clampNum(out.size, 0.6, 1.6, 1);
          out.volume = clampNum(out.volume, 0, 1, 0.6);
          out.x = clampNum(out.x, 0, 4000, 26);
          out.y = clampNum(out.y, 0, 4000, 26);
          out.side = out.side === "left" ? "left" : "right";
          if (typeof out.style !== "string" || !out.style) out.style = DEFAULTS.style;
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
            if (state.muted) return null;
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

          return {
            /* 气泡「咕噜」：正弦从高滑到低，像水泡破裂 */
            pop: function (pitch) {
              var c = ensure();
              if (!c) return;
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
          P + ".is-hover .hf-svg{transform:scale(1.04);}",
          P + ".hf-svg{display:block;width:100%;height:100%;overflow:visible;transition:transform .18s ease-out;",
          "filter:drop-shadow(0 7px 16px rgba(0,0,0,.3));}",
          /* ---- 待机动画 ---- */
          P + ".hf-bob{transform-box:fill-box;animation:hf-bob 3.4s ease-in-out infinite;}",
          "@keyframes hf-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}",
          /* ---- 部件级动画（简笔画风格：浮动 / 摆臂 / 呼吸 / 眨眼 / 影子） ---- */
          P + ".xl-arm-l{transform-box:fill-box;transform-origin:82% 8%;animation:hf-arml 2.8s ease-in-out infinite;}",
          "@keyframes hf-arml{0%,100%{transform:rotate(3deg)}50%{transform:rotate(-5deg)}}",
          P + ".xl-arm-r{transform-box:fill-box;transform-origin:18% 8%;animation:hf-armr 2.8s ease-in-out infinite;}",
          "@keyframes hf-armr{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(5deg)}}",
          P + ".xl-torso{transform-box:fill-box;transform-origin:50% 100%;animation:hf-breathe 3.4s ease-in-out infinite;}",
          "@keyframes hf-breathe{0%,100%{transform:scaleY(1)}50%{transform:scaleY(1.035)}}",
          P + ".hf-eye{transform-box:fill-box;transform-origin:50% 50%;animation:hf-blink 5.6s infinite;}",
          "@keyframes hf-blink{0%,91%,100%{transform:scaleY(1)}94%{transform:scaleY(.08)}}",
          P + ".hf-shadow{transform-box:fill-box;transform-origin:50% 50%;animation:hf-shadow 3.4s ease-in-out infinite;}",
          "@keyframes hf-shadow{0%,100%{opacity:.16;transform:scaleX(1)}50%{opacity:.09;transform:scaleX(.92)}}",
          /* ---- 自定义角色图（上传后替代程序化 SVG） ----
             图片没有部件级动画，所以浮动/挤压/点头都挂在 .hf-art 上，
             并让 transform-origin 落在底部，挤压时才是"从脚往上压"而不是绕中心缩 */
          P + ".hf-art{width:100%;height:100%;display:flex;align-items:flex-end;justify-content:center;",
          "animation:hf-bob 3.4s ease-in-out infinite;transform-origin:50% 100%;}",
          P + ".hf-img{max-width:100%;max-height:100%;object-fit:contain;display:block;",
          "filter:drop-shadow(0 7px 16px rgba(0,0,0,.3));-webkit-user-drag:none;user-select:none;}",
          P + ".is-custom.is-dragging .hf-art{animation-play-state:paused;}",
          /* ---- 交互状态 ---- */
          P + ".is-dragging .hf-bob," + P + ".is-dragging .xl-arm-l," + P + ".is-dragging .xl-arm-r,",
          P + ".is-dragging .xl-torso,",
          P + ".is-dragging .hf-shadow{animation-play-state:paused;}",
          P + ".is-happy .hf-svg," + P + ".is-happy .hf-art{animation:hf-squash .52s cubic-bezier(.34,1.56,.64,1);}",
          "@keyframes hf-squash{0%{transform:scale(1,1)}22%{transform:scale(1.16,.84)}52%{transform:scale(.94,1.1)}",
          "78%{transform:scale(1.04,.97)}100%{transform:scale(1,1)}}",
          P + ".is-nod .hf-bob," + P + ".is-nod .hf-art{animation:hf-nod .46s ease-in-out;}",
          "@keyframes hf-nod{0%,100%{transform:translateY(0)}40%{transform:translateY(5px)}}",
          /* ---- 台词气泡：贴在角色**侧边**（朝屏幕内侧那一侧），不压角色 ----
             原先贴在角色正上方（bottom:calc(100% - 30px)），会压到脑袋上 ——
             用户反馈"期待对话框在旁边"。侧边定位还有一个好处：
             角色在屏幕角落时，气泡朝屏幕内侧展开，不会被窗口边缘截断。 */
          P + "." + ROOT_ID + "-say{position:absolute;bottom:38%;max-width:min(230px,58vw);padding:8px 12px;",
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
          P + "." + ROOT_ID + "-btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;",
          "padding-top:9px;border-top:1px solid rgba(126,230,255,.14);}",
          P + "." + ROOT_ID + "-btns button{flex:1 1 auto;padding:6px 9px;border-radius:9px;cursor:pointer;",
          "background:rgba(38,54,78,.85);color:#dcebf8;border:1px solid rgba(126,230,255,.2);",
          "font-size:11px;font-family:inherit;transition:background .14s;}",
          P + "." + ROOT_ID + "-btns button:hover{background:rgba(58,82,116,.95);}",
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
          P + ".hf-bob," + P + ".xl-arm-l," + P + ".xl-arm-r," + P + ".xl-torso,",
          P + ".hf-eye," + P + ".hf-art," + P + ".hf-shadow{animation:none !important;}",
          P + ".is-happy .hf-svg," + P + ".is-nod .hf-bob{animation:none !important;}}"
        ].join("");

        var styleEl = document.createElement("style");
        styleEl.setAttribute("data-dsh-plugin", ROOT_ID);
        styleEl.textContent = CSS;
        document.head.appendChild(styleEl);

        /* ============================================================
           4. 角色：程序化 SVG（无外部素材，零版权风险）
           ============================================================ */
        /* ============================================================
           5.4 表情系统
           ------------------------------------------------------------------
           词汇取自 _refs 下「风格-成熟」与「风格-简笔」两个目录里按情绪命名的参考图
           （尴尬 / 吃惊 / 委屈 / 无语 / 祈福 / 鼓励 / 撒娇 / 打哈欠 / 害羞 / 宕机 / 莞尔一笑）。
           表情 = **眼型 + 嘴型**；只写一套五官构造器。
           只替换 <g class="hf-face"> 的内容，不动其它部件 ——
           这样换表情不会重启 bob/摆尾那些 CSS 动画。
           ============================================================ */
        var EXPRESSIONS = {
          /* 刻意**没有腮红**：作者那套简笔画本来就只有点眼 + 小方嘴，
             而自己加的两片粉圆被用户吐槽成"雷霆腮红" —— 极简才是这套画风的本意。
             去掉腮红后 7 种表情依然两两可辨（眼型/嘴型各不同）。 */
          neutral: { eyes: "plain", mouth: "small" }, // 平常
          smile: { eyes: "arc", mouth: "smile" }, // 莞尔一笑
          surprised: { eyes: "wide", mouth: "open" }, // 吃惊
          shy: { eyes: "arc", mouth: "small" }, // 害羞
          focus: { eyes: "line", mouth: "flat" }, // 认真工作
          awkward: { eyes: "plain", mouth: "wavy" }, // 尴尬 / 无语
          sleepy: { eyes: "arc", mouth: "open" } // 打哈欠
        };
        /* 状态 → 表情；holdMs 到点后回到"静息表情" */
        var STATE_EXPRESSION = {
          greet: { name: "smile", holdMs: 3600 },
          click: { name: "shy", holdMs: 2200 },
          drag: { name: "surprised", holdMs: 1600 },
          drop: { name: "awkward", holdMs: 2200 },
          turnEnd: { name: "focus", holdMs: 3200 },
          /* 「正在工作」：打字中 / 一轮进行中（对应参考图「认真工作的蓝」）。
             holdMs 0 = 不自动回退 —— 由"停止输入 2 秒"或"轮次结束"来收尾 */
          typing: { name: "focus", holdMs: 0 },
          busy: { name: "focus", holdMs: 0 }
        };
        /** 当前表情与"静息表情"（空闲久了会切到打哈欠） */
        var expression = "neutral";
        var restingExpression = "neutral";
        var expressionTimer = null;

        /* ---------- 简笔画风格的五官（头：cx116 cy42 r25） ---------- */
        function simpleEyes(kind) {
          var L = 107;
          var R = 125;
          var Y = 38;
          if (kind === "wide") {
            return (
              '<g class="hf-eye"><circle cx="' + L + '" cy="' + Y + '" r="4.2" fill="#141414"/>' +
              '<circle cx="' + (L - 1.3) + '" cy="' + (Y - 1.4) + '" r="1.2" fill="#ffffff"/></g>' +
              '<g class="hf-eye"><circle cx="' + R + '" cy="' + Y + '" r="4.2" fill="#141414"/>' +
              '<circle cx="' + (R - 1.3) + '" cy="' + (Y - 1.4) + '" r="1.2" fill="#ffffff"/></g>'
            );
          }
          if (kind === "arc" || kind === "line") {
            /* arc = ∩ 形笑眼/闭眼；line = 平直眼（认真、无语） */
            return (
              '<g class="hf-eye"><path d="' + arcPath(L, Y, kind) + '" fill="none" stroke="#141414" ' +
              'stroke-width="3" stroke-linecap="round"/></g>' +
              '<g class="hf-eye"><path d="' + arcPath(R, Y, kind) + '" fill="none" stroke="#141414" ' +
              'stroke-width="3" stroke-linecap="round"/></g>'
            );
          }
          return (
            '<circle class="hf-eye" cx="' + L + '" cy="' + Y + '" r="2.9" fill="#141414"/>' +
            '<circle class="hf-eye" cx="' + R + '" cy="' + Y + '" r="2.9" fill="#141414"/>'
          );
        }
        function arcPath(cx, cy, kind) {
          /* 两种画风共用的小工具：∩ 弧或直线 */
          if (kind === "line") return "M " + (cx - 4.5) + " " + cy + " L " + (cx + 4.5) + " " + cy;
          return (
            "M " + (cx - 4.5) + " " + (cy + 1.5) + " C " + (cx - 2) + " " + (cy - 3) + ", " +
            (cx + 2) + " " + (cy - 3) + ", " + (cx + 4.5) + " " + (cy + 1.5)
          );
        }
        function simpleMouth(kind) {
          if (kind === "open") {
            return (
              '<ellipse class="hf-mouth" cx="116" cy="53" rx="5.6" ry="6.6" fill="none" ' +
              'stroke="#141414" stroke-width="3.4"/>'
            );
          }
          if (kind === "smile") {
            return (
              '<path class="hf-mouth" d="M 109 50 C 113 56, 119 56, 123 50" fill="none" ' +
              'stroke="#141414" stroke-width="3.2" stroke-linecap="round"/>'
            );
          }
          if (kind === "flat") {
            return (
              '<path class="hf-mouth" d="M 110 53 L 122 53" fill="none" stroke="#141414" ' +
              'stroke-width="3.2" stroke-linecap="round"/>'
            );
          }
          if (kind === "wavy") {
            return (
              '<path class="hf-mouth" d="M 109 53 C 112 49, 114 57, 117 53 C 120 49, 122 57, 125 53" ' +
              'fill="none" stroke="#141414" stroke-width="2.8" stroke-linecap="round"/>'
            );
          }
          return (
            '<rect class="hf-mouth" x="111" y="48" width="10" height="11" rx="4" fill="none" ' +
            'stroke="#141414" stroke-width="3.4"/>'
          );
        }
        function simpleFace(name) {
          var e = EXPRESSIONS[name] || EXPRESSIONS.neutral;
          return simpleEyes(e.eyes) + simpleMouth(e.mouth);
        }

        /* ---------------------------------------------------------------------
           手臂姿势表：表情 → 两条手臂的路径
           用户反馈"基本上一直是各种大字形状的姿势" —— 所以按表情分手势，
           而不是永远摊开。左臂的肩在包围盒右上、右臂在左上（配合 CSS 的 transform-origin）。
           --------------------------------------------------------------------- */
        var ARM_POSES = {
          /* 垂在身侧时别贴着长衫的黑描边（会被描边吃掉），往身体中间收一点，
             黑线压在蓝底上才看得见 —— 原作就是这种画法 */
          neutral: ["M 104 79 C 100 92, 100 104, 103 117", "M 128 79 C 132 92, 132 104, 129 117"],
          smile: ["M 104 79 C 98 90, 96 102, 99 114", "M 128 79 C 134 90, 136 102, 133 114"],
          shy: ["M 104 79 C 98 84, 96 90, 102 96", "M 128 79 C 134 84, 136 90, 130 96"],
          surprised: ["M 104 78 C 90 74, 82 66, 83 55", "M 128 78 C 142 74, 150 66, 149 55"],
          /* 双手在身前合拢＝打字/工作 —— 正好配「一轮进行中 / 打字中」 */
          focus: ["M 104 82 C 98 92, 100 102, 110 105", "M 128 82 C 134 92, 132 102, 122 105"],
          awkward: ["M 104 79 C 101 92, 102 104, 105 116", "M 128 79 C 131 92, 130 104, 127 116"],
          /* 打哈欠：一只手抬到脸旁边 */
          sleepy: ["M 104 79 C 99 90, 98 102, 101 114", "M 128 79 C 134 72, 132 64, 124 62"]
        };

        function simpleArmMarkup(pose, cls) {
          return (
            '<g class="' + cls + '"><path d="' + pose + '" fill="none" stroke="#141414" ' +
            'stroke-width="7" stroke-linecap="round"/></g>'
          );
        }

        function simpleArms(name) {
          var p = ARM_POSES[name] || ARM_POSES.neutral;
          return simpleArmMarkup(p[0], "xl-arm-l") + simpleArmMarkup(p[1], "xl-arm-r");
        }

        /** 取五官标记（作者原画模式下不会走到这里） */
        function faceFor(name) {
          return simpleFace(name);
        }

        /** 只换 <g class="hf-face"> 的内容 —— 不重绘角色，所以不会打断正在跑的 CSS 动画 */
        function applyExpression(name) {
          expression = EXPRESSIONS[name] ? name : "neutral";
          var face = fish.querySelector(".hf-face");
          if (face) face.innerHTML = faceFor(expression);
          /* 手臂姿势也跟着换：只换路径、不重建角色（重建会打断正在跑的动画） */
          var pose = ARM_POSES[expression] || ARM_POSES.neutral;
          var armL = fish.querySelector(".xl-arm-l");
          var armR = fish.querySelector(".xl-arm-r");
          if (armL) armL.innerHTML = '<path d="' + pose[0] + '" fill="none" stroke="#141414" stroke-width="7" stroke-linecap="round"/>';
          if (armR) armR.innerHTML = '<path d="' + pose[1] + '" fill="none" stroke="#141414" stroke-width="7" stroke-linecap="round"/>';
        }

        /** 切表情；给 holdMs 则到点后回到"静息表情"（transient 表情用） */
        function setExpression(name, holdMs) {
          clearTimeout(expressionTimer);
          applyExpression(name);
          if (holdMs > 0) {
            expressionTimer = setTimeout(revertToResting, holdMs);
          }
        }

        /** 回到静息表情与原画（临时状态收尾时统一走这里，别各写一份） */
        function revertToResting() {
          clearTimeout(expressionTimer);
          applyExpression(restingExpression);
          artStateKey = "default";
          updateArtImage();
        }

        /** 按状态名切表情（映射表 STATE_EXPRESSION 是唯一改动点）；
            若加载了作者原画清单，同一个状态也用来换一张原画 */
        function express(stateName) {
          var cfg = STATE_EXPRESSION[stateName];
          if (cfg) setExpression(cfg.name, cfg.holdMs);
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
          row("音效", '<input type="checkbox" data-k="muted">'),
          row("音量", '<input type="range" min="0" max="1" step="0.05" data-k="volume"><b data-v="volume"></b>'),
          row("大小", '<input type="range" min="0.6" max="1.6" step="0.05" data-k="size"><b data-v="size"></b>'),
          row(
            "画风",
            /* 选项由 syncStyleOptions() 按清单动态生成（原画集 + 内置线稿） */
            '<select data-k="style"><option value="svg">内置线稿（手画）</option></select>',
          ),
          row("台词", '<input type="checkbox" data-k="speech">'),
          row("边缘吸附", '<input type="checkbox" data-k="snap">'),
          row("结束音", '<input type="checkbox" data-k="endSound">'),
          '<div class="' + ROOT_ID + "-btns\">",
          '<button data-act="test">试听音效</button>',
          '<button data-act="art-upload">换个角色图</button>',
          '<button data-act="art-reset">默认角色</button>',
          '<button data-act="reset">回到角落</button>',
          '<button data-act="hide" class="is-danger">隐藏小蓝</button>',
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
        var svgEl = null;
        var bubbleLayer = null;

        /* =====================================================================
           作者原画（本地素材包）
           ---------------------------------------------------------------------
           参考图不随仓库分发（第三方素材），所以图待在用户的 assets/ 里，由两个途径供给：
             · DSH 页面：主机侧的前缀路由 /dsh-handsome-fish/art/（http 页面读不到 file://）
             · 桌面外壳：file:// 下 fetch 清单会被拦，改为 preload 直接把清单注入全局
           清单 assets/art-manifest.json 给出「default + 状态 → 文件名」。
           拿不到清单时（全新克隆里 assets/ 是空的）静默退回内置程序化 SVG，挂件照常可用。
           画风下拉里的「作者原画」＝用清单里的图；选「精致描画/简笔画」＝不用图、用内置 SVG。
           这样下拉在三种情况下都**看得见效果**，不会出现"切了没反应"的哑控件。
           优先级：上传/指定的图（?art= / 菜单上传）> 作者原画（仅画风=作者原画时）> 内置 SVG
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

        /** 载体可以强制用内置 SVG（?svg=1），自检需要一条不受本地素材影响的路径 */
        function forceBuiltinArt() {
          try {
            return window.__HANDSOME_FISH_FORCE_SVG__ === true;
          } catch (e) {
            return false;
          }
        }

        var artManifest = null; /* 原始清单（诊断用） */
        var artStateKey = "default"; /* 当前用清单里的哪个状态键 */
        var artPreload = {}; /* 文件名 → 预解码的 Image，切状态时不闪 */

        /** 当前画风对应的原画集；不是原画集就返回 null（内置线稿） */
        function currentSet() {
          return styleIsArtSet(state.style) ? ART_SETS[state.style] : null;
        }

        /** 当前状态下、当前原画集里该用哪个文件 */
        function manifestArtFile() {
          var set = currentSet();
          if (!set) return "";
          var n = set.states && set.states[artStateKey];
          return n || set.default || "";
        }

        /** 只有"画风＝某个原画集"时才用清单里的图；选了内置线稿就该看见内置线稿 */
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
          for (var k in set.states) names.push(set.states[k]);
          for (var i = 0; i < names.length; i++) {
            var n = names[i];
            if (!n || artPreload[n]) continue;
            var img = new Image();
            img.src = artBase() + n;
            artPreload[n] = img;
          }
        }

        /** 当前该用哪个内置 SVG 画风（作者原画/未指定时都按简笔画） */
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
             这就是"有原画就用原画，没有就退回内置线稿" */
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
          html += '<option value="' + SVG_STYLE + '">内置线稿（手画）</option>';
          sel.innerHTML = html;
          sel.value = state.style;
          /* 存档里那个画风可能在当前清单里不存在了（比如换了一套素材）→ 落回第一套 */
          if (sel.selectedIndex < 0) {
            state.style = ART_SET_KEYS[0] || SVG_STYLE;
            sel.value = state.style;
          }
        }

        function loadArtManifest() {
          if (forceBuiltinArt()) return;
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
                /* 没有清单就继续用内置线稿 */
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

        /* ---------------------------------------------------------------------
           简笔画风格（原作风）
           依据 _refs/xiaolan/风格-简笔/ 的参考图（本地参考图，不入库）：
           **无发的白圆头 + 粗黑描边 + 两个点眼 + 小方嘴 +
           蓝色梯形躯干 + 粗黑线四肢**，平涂无渐变。
           刻意沿用与精致版**相同的部件类名**（xl-torso / xl-arm-l / xl-arm-r / xl-head /
           hf-eye / hf-bob / hf-shadow / hf-bubbles）——
           于是 CSS 里那套关键帧与 transform-origin 一行都不用改，两种画风共享动画契约。
           手臂走向也刻意与精致版一致（左臂肩在包围盒右上、右臂肩在左上），
           这样现有的 transform-origin: 82% 8% / 18% 8% 正好落在肩关节上。
           --------------------------------------------------------------------- */
        function xiaolanSimpleSVG() {
          /* 比例对照参考图校准过：头约占总高 1/3（第一版画成 44%，明显"头重"），
             四肢要伸到躯干轮廓之外才看得见（第一版手臂藏在蓝块里）。
             第二版按用户反馈改：**脸不填充**（纯线稿更耐看）、
             手臂按表情换姿势（不再永远摊成"大"字）。 */
          return (
            '<svg class="hf-svg is-style-simple" viewBox="0 0 240 180" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
            '<ellipse class="hf-shadow" cx="116" cy="171" rx="28" ry="5.5" fill="#000" opacity="0.16"/>' +
            '<g class="hf-bob">' +
            /* 腿：粗黑圆头线，伸到蓝色长衫下方 */
            '<path d="M 106 146 L 102 167" fill="none" stroke="#141414" stroke-width="7" stroke-linecap="round"/>' +
            '<path d="M 126 146 L 130 167" fill="none" stroke="#141414" stroke-width="7" stroke-linecap="round"/>' +
            /* 躯干：蓝色长衫（上窄下宽的圆角梯形），顶边藏在头后面形成脖子 */
            '<g class="xl-torso">' +
            '<path d="M 97 74 C 97 70, 100 68, 104 68 L 128 68 C 132 68, 135 70, 135 74 ' +
            'L 143 144 C 143 148, 139 150, 135 150 L 97 150 C 93 150, 89 148, 89 144 Z" ' +
            'fill="#57c7f2" stroke="#141414" stroke-width="5.5" stroke-linejoin="round"/>' +
            "</g>" +
            simpleArms(expression) +
            /* 头：无发的大白圆 + 粗描边。**不填充**（纯线稿） */
            '<g class="xl-head">' +
            '<circle cx="116" cy="42" r="25" fill="none" stroke="#141414" stroke-width="5"/>' +
            '<g class="hf-face">' +
            simpleFace(expression) +
            "</g>" +
            "</g>" +
            '<g class="hf-bubbles"></g>' +
            "</g>" +
            "</svg>"
          );
        }

        /** 内置角色 SVG（只剩简笔画原作风这一套） */
        function currentSVG() {
          return xiaolanSimpleSVG();
        }

        function renderCharacter() {
          var url = artDataUrl || manifestArtUrl();
          fish.innerHTML = url
            ? '<div class="hf-art"><img class="hf-img" alt="角色" src="' + url + '"></div>'
            : currentSVG();
          svgEl = fish.querySelector(".hf-svg");
          bubbleLayer = fish.querySelector(".hf-bubbles");
          fish.classList.toggle("is-custom", !!url);
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
        /* bubbleLayer 在 renderCharacter() 里解析：自定义角色图时它是 null，
           spawnBubbles 会自动空转（没有 SVG 装饰层就不冒）。 */

        function spawnBubbles(n) {
          if (!bubbleLayer) return;
          var count = reducedMotion ? Math.max(1, Math.floor(n / 2)) : n;
          for (var i = 0; i < count; i++) {
            (function (i) {
              var c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
              var r = 1.8 + Math.random() * 3.2;
              c.setAttribute("cx", 140 + Math.random() * 16);
              c.setAttribute("cy", 44 + Math.random() * 10);
              c.setAttribute("r", r);
              c.setAttribute("fill", "rgba(255,232,168,0.55)");
              c.setAttribute("stroke", "rgba(255,246,214,0.8)");
              c.setAttribute("stroke-width", "1");
              bubbleLayer.appendChild(c);
              var dx = -14 + Math.random() * 26;
              var dy = -(48 + Math.random() * 64);
              var dur = 900 + Math.random() * 900;
              var anim = c.animate(
                [
                  { transform: "translate(0,0) scale(.5)", opacity: 0 },
                  { transform: "translate(" + dx * 0.5 + "px," + dy * 0.45 + "px) scale(1)", opacity: 0.9, offset: 0.35 },
                  { transform: "translate(" + dx + "px," + dy + "px) scale(1.15)", opacity: 0 }
                ],
                { duration: dur, delay: i * 90, easing: "ease-out", fill: "forwards" }
              );
              anim.onfinish = function () {
                if (c.parentNode) c.parentNode.removeChild(c);
              };
            })(i);
          }
        }

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
          /* 一交互就退出"打哈欠"的静息表情 */
          restingExpression = "neutral";
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
            spawnBubbles(3);
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
            if (k === "muted" && !state.muted) audio.pop(1.1);
            if (k === "snap" && state.snap) applyPosition(true);
            if (k === "style") {
              /* 用户显式选过画风 → 从此不再被"代码默认值"覆盖 */
              stylePinned = true;
              /* 换画风＝换一套角色渲染（某套原画 / 内置线稿），动画契约相同 */
              preloadSet(currentSet());
              renderCharacter();
              flash("is-happy", 460);
              audio.pop(1.1);
              if (styleIsArtSet(state.style)) {
                speak("……这样最像我。", 2400);
              } else {
                speak("……这是我手画的，凑合看。", 2400);
              }
            }
            syncMenu();
            writeStore();
            return;
          }
          var act = el.getAttribute("data-act");
          if (act === "quit") {
            bridge({ type: "quit" });
          } else if (act === "art-upload") {
            fileInput.click();
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
            audio.pop(1);
            setTimeout(function () {
              audio.chime();
            }, 260);
            setTimeout(function () {
              audio.ding();
            }, 1080);
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
            /* 空闲久了会打哈欠：静息表情在 平常 ↔ 打哈欠 之间轮换（对应参考图「蓝在打哈欠」） */
            if (!expressionForced) {
              restingExpression = restingExpression === "neutral" ? "sleepy" : "neutral";
              setExpression(restingExpression, 0);
            }
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
          spawnBubbles(2);
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
              else revertToResting();
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
              revertToResting();
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
                  else revertToResting();
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
        /* 原画清单是异步来的：没有它也能用（退回内置 SVG），拿到后自动换成作者原画 */
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

        /* 载体可强制初始表情（?expr=…）—— 只用于调试与截图核对 */
        var expressionForced = false;
        try {
          var forcedExpr = window.__HANDSOME_FISH_EXPRESSION__;
          if (EXPRESSIONS[forcedExpr]) {
            expressionForced = true;
            restingExpression = forcedExpr;
            applyExpression(forcedExpr);
          }
        } catch (e) {
          /* ignore */
        }

        setTimeout(function () {
          if (!state.hidden) {
            speak(pick("greet"), 3600);
            if (!expressionForced) express("greet");
            spawnBubbles(2);
          }
        }, 1400);

        /* 调试 / 二次开发入口 */
        try {
          window.__HANDSOME_FISH__ = {
            /* redraw()：改完 state（画风、位置…）后手动重绘角色，自检与调试都用它 */
            redraw: renderCharacter,
            /* face(name)：只换面部容器（不重建角色，所以不会打断循环动画） */
            face: applyExpression,
            /* express(state)：按状态名切表情，走 STATE_EXPRESSION 映射表 */
            express: express,
            /* setArt()：直接换/清自定义角色图（"" = 回到内置 SVG），自检用它切回内置画风 */
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
