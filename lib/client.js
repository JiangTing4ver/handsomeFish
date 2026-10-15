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
        var DEFAULTS = {
          size: 1,
          muted: false,
          volume: 0.6,
          speech: true,
          snap: true,
          endSound: true,
          hidden: false,
          side: "right",
          x: 26,
          y: 26
        };

        function readStore() {
          var out = {};
          for (var k in DEFAULTS) out[k] = DEFAULTS[k];
          try {
            var raw = localStorage.getItem(STORE_KEY);
            if (raw) {
              var parsed = JSON.parse(raw);
              if (parsed && typeof parsed === "object") {
                for (var j in DEFAULTS) {
                  if (Object.prototype.hasOwnProperty.call(parsed, j)) {
                    out[j] = parsed[j];
                  }
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
          P + ".xl-ahoge{transform-box:fill-box;transform-origin:50% 100%;animation:hf-sway 2.1s ease-in-out infinite;}",
          "@keyframes hf-sway{0%,100%{transform:rotate(-8deg)}50%{transform:rotate(9deg)}}",
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
          /* ---- 自定义角色图（上传后替代程序化 SVG） ---- */
          P + ".hf-art{width:100%;height:100%;display:flex;align-items:flex-end;justify-content:center;",
          "animation:hf-bob 3.4s ease-in-out infinite;}",
          P + ".hf-img{max-width:100%;max-height:100%;object-fit:contain;display:block;",
          "filter:drop-shadow(0 7px 16px rgba(0,0,0,.3));-webkit-user-drag:none;user-select:none;}",
          P + ".is-custom.is-dragging .hf-art{animation-play-state:paused;}",
          /* ---- 交互状态 ---- */
          P + ".is-dragging .hf-bob," + P + ".is-dragging .xl-arm-l," + P + ".is-dragging .xl-arm-r,",
          P + ".is-dragging .xl-ahoge," + P + ".is-dragging .xl-torso,",
          P + ".is-dragging .hf-shadow{animation-play-state:paused;}",
          P + ".is-happy .hf-svg{animation:hf-squash .52s cubic-bezier(.34,1.56,.64,1);}",
          "@keyframes hf-squash{0%{transform:scale(1,1)}22%{transform:scale(1.16,.84)}52%{transform:scale(.94,1.1)}",
          "78%{transform:scale(1.04,.97)}100%{transform:scale(1,1)}}",
          P + ".is-nod .hf-bob{animation:hf-nod .46s ease-in-out;}",
          "@keyframes hf-nod{0%,100%{transform:translateY(0)}40%{transform:translateY(5px)}}",
          /* ---- 台词气泡（贴在角色上方，按所在侧对齐，避免压到角色身上） ---- */
          P + "." + ROOT_ID + "-say{position:absolute;bottom:calc(100% - 30px);max-width:min(230px,58vw);padding:8px 12px;",
          "border-radius:14px;background:rgba(16,25,40,.94);border:1px solid rgba(126,230,255,.3);",
          "box-shadow:0 10px 26px rgba(0,0,0,.4);color:#eaf6ff;white-space:pre-wrap;word-break:break-word;",
          "pointer-events:none;cursor:pointer;opacity:0;transform:translateY(6px) scale(.94);",
          "transition:opacity .18s ease-out,transform .2s cubic-bezier(.34,1.56,.64,1);}",
          /* 隐藏时不接收鼠标：否则一个看不见的气泡会在桌面窗口里挡住底下的点击 */
          P + "." + ROOT_ID + "-say.is-on{pointer-events:auto;}",
          P + "." + ROOT_ID + "-say[data-tail='right']{right:2px;}",
          P + "." + ROOT_ID + "-say[data-tail='left']{left:2px;}",
          P + "." + ROOT_ID + "-say.is-on{opacity:1;transform:translateY(0) scale(1);}",
          P + "." + ROOT_ID + "-say::after{content:'';position:absolute;bottom:-6px;width:11px;height:11px;",
          "background:rgba(16,25,40,.94);border-right:1px solid rgba(126,230,255,.3);",
          "border-bottom:1px solid rgba(126,230,255,.3);transform:rotate(45deg);}",
          P + "." + ROOT_ID + "-say[data-tail='right']::after{right:22px;}",
          P + "." + ROOT_ID + "-say[data-tail='left']::after{left:22px;}",
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
          P + ".hf-bob," + P + ".xl-ahoge," + P + ".xl-arm-l," + P + ".xl-arm-r," + P + ".xl-torso,",
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
        function xiaolanSVG() {
          return (
            '<svg class="hf-svg" viewBox="0 0 240 180" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
            "<defs>" +
            '<linearGradient id="xl-hair" x1="0.2" y1="0" x2="0.6" y2="1">' +
            '<stop offset="0" stop-color="#7ea9ea"/><stop offset="0.5" stop-color="#4a7fd0"/>' +
            '<stop offset="1" stop-color="#2f5cab"/></linearGradient>' +
            '<linearGradient id="xl-skin" x1="0" y1="0" x2="0.3" y2="1">' +
            '<stop offset="0" stop-color="#fff0e4"/><stop offset="1" stop-color="#ffdcc6"/></linearGradient>' +
            '<linearGradient id="xl-hoodie" x1="0" y1="0" x2="0.4" y2="1">' +
            '<stop offset="0" stop-color="#ffffff"/><stop offset="0.6" stop-color="#eef5fd"/>' +
            '<stop offset="1" stop-color="#d3e4f7"/></linearGradient>' +
            '<linearGradient id="xl-hood" x1="0" y1="0" x2="0.3" y2="1">' +
            '<stop offset="0" stop-color="#8fb8ee"/><stop offset="1" stop-color="#4a7fd0"/></linearGradient>' +
            '<linearGradient id="xl-iris" x1="0.3" y1="0" x2="0.6" y2="1">' +
            '<stop offset="0" stop-color="#5b93dd"/><stop offset="1" stop-color="#24518f"/></linearGradient>' +
            '<radialGradient id="xl-blush">' +
            '<stop offset="0" stop-color="#ff8a96" stop-opacity="0.72"/>' +
            '<stop offset="1" stop-color="#ff8a96" stop-opacity="0"/></radialGradient>' +
            "</defs>" +
            '<ellipse class="hf-shadow" cx="120" cy="173" rx="38" ry="6" fill="#000" opacity="0.16"/>' +
            '<g class="hf-bob">' +
            /* 兜帽：从躯干两侧探出，形成蓝色肩片 */
            '<path d="M 120 116 C 96 116, 80 130, 80 150 C 80 158, 88 162, 96 160 ' +
            'C 92 142, 102 130, 120 130 C 138 130, 148 142, 144 160 C 152 162, 160 158, 160 150 ' +
            'C 160 130, 144 116, 120 116 Z" fill="url(#xl-hood)" stroke="#2b3a52" ' +
            'stroke-width="2.4" stroke-linejoin="round"/>' +
            /* 脚 */
            '<ellipse cx="105" cy="164" rx="9" ry="5.5" fill="#e8eef7" stroke="#2b3a52" stroke-width="2.2"/>' +
            '<ellipse cx="135" cy="164" rx="9" ry="5.5" fill="#e8eef7" stroke="#2b3a52" stroke-width="2.2"/>' +
            /* 躯干 */
            '<g class="xl-torso">' +
            '<path d="M 120 120 C 101 120, 90 131, 88 149 C 87 158, 94 162, 120 162 ' +
            'C 146 162, 153 158, 152 149 C 150 131, 139 120, 120 120 Z" fill="url(#xl-hoodie)" ' +
            'stroke="#2b3a52" stroke-width="2.6" stroke-linejoin="round"/>' +
            /* 蓝色口袋：蓝白卫衣的「蓝」 */
            '<path d="M 106 141 C 112 137, 128 137, 134 141 C 137 149, 132 156, 120 156 ' +
            'C 108 156, 103 149, 106 141 Z" fill="#4a7fd0" stroke="#2b3a52" ' +
            'stroke-width="2.2" stroke-linejoin="round"/>' +
            '<path d="M 106 122 C 111 131, 129 131, 134 122" fill="none" ' +
            'stroke="#2b3a52" stroke-width="2.4" stroke-linejoin="round"/>' +
            '<path d="M 113 126 L 112 136" stroke="#4a7fd0" stroke-width="2.4" stroke-linecap="round"/>' +
            '<path d="M 127 126 L 128 136" stroke="#4a7fd0" stroke-width="2.4" stroke-linecap="round"/>' +
            "</g>" +
            /* 手臂 */
            '<g class="xl-arm-l"><path d="M 90 130 C 81 134, 76 146, 80 157 C 84 162, 93 160, 93 153 ' +
            'C 91 145, 92 136, 90 130 Z" fill="url(#xl-hoodie)" stroke="#2b3a52" ' +
            'stroke-width="2.4" stroke-linejoin="round"/></g>' +
            '<g class="xl-arm-r"><path d="M 150 130 C 159 134, 164 146, 160 157 C 156 162, 147 160, 147 153 ' +
            'C 149 145, 148 136, 150 130 Z" fill="url(#xl-hoodie)" stroke="#2b3a52" ' +
            'stroke-width="2.4" stroke-linejoin="round"/></g>' +
            /* 头 */
            '<g class="xl-head">' +
            '<ellipse cx="118" cy="74" rx="41" ry="42" fill="url(#xl-skin)" stroke="#2b3a52" stroke-width="2.6"/>' +
            /* 侧发：只到脸颊，长了会变成妹妹头 */
            '<path d="M 80 60 C 73 76, 74 90, 81 102 C 86 94, 88 86, 88 78 Z" ' +
            'fill="url(#xl-hair)" stroke="#2b3a52" stroke-width="2.2" stroke-linejoin="round"/>' +
            '<path d="M 156 60 C 163 76, 162 90, 155 102 C 150 94, 148 86, 148 78 Z" ' +
            'fill="url(#xl-hair)" stroke="#2b3a52" stroke-width="2.2" stroke-linejoin="round"/>' +
            /* 头发主体 + 尖刘海：直线段做出发梢 */
            '<path d="M 78 86 C 72 52, 92 26, 118 26 C 146 26, 166 52, 160 86 ' +
            'L 152 71 L 144 84 L 135 67 L 125 82 L 115 65 L 105 82 L 97 69 L 89 84 Z" ' +
            'fill="url(#xl-hair)" stroke="#2b3a52" stroke-width="2.6" stroke-linejoin="round"/>' +
            /* 呆毛：标志性特征，也是唯一能独立摆动的部件 */
            '<g class="xl-ahoge"><path d="M 112 30 C 105 19, 113 9, 127 12" fill="none" ' +
            'stroke="#2f5cab" stroke-width="5.4" stroke-linecap="round"/></g>' +
            /* 眉 */
            '<path d="M 92 62 C 97 58, 105 58, 109 61" fill="none" stroke="#2f5cab" ' +
            'stroke-width="2.6" stroke-linecap="round" stroke-opacity="0.75"/>' +
            '<path d="M 144 62 C 139 58, 131 58, 127 61" fill="none" stroke="#2f5cab" ' +
            'stroke-width="2.6" stroke-linecap="round" stroke-opacity="0.75"/>' +
            /* 眼 */
            '<g class="hf-eye">' +
            '<ellipse cx="101" cy="84" rx="10.5" ry="12" fill="#ffffff" stroke="#2b3a52" stroke-width="2"/>' +
            '<ellipse cx="101" cy="85" rx="8" ry="10" fill="url(#xl-iris)"/>' +
            '<ellipse cx="101" cy="86" rx="4" ry="5.6" fill="#16233a"/>' +
            '<circle cx="98.4" cy="81" r="2.8" fill="#ffffff"/>' +
            '<circle cx="104" cy="90" r="1.4" fill="#ffffff" opacity="0.75"/>' +
            "</g>" +
            '<g class="hf-eye">' +
            '<ellipse cx="135" cy="84" rx="10.5" ry="12" fill="#ffffff" stroke="#2b3a52" stroke-width="2"/>' +
            '<ellipse cx="135" cy="85" rx="8" ry="10" fill="url(#xl-iris)"/>' +
            '<ellipse cx="135" cy="86" rx="4" ry="5.6" fill="#16233a"/>' +
            '<circle cx="132.4" cy="81" r="2.8" fill="#ffffff"/>' +
            '<circle cx="138" cy="90" r="1.4" fill="#ffffff" opacity="0.75"/>' +
            "</g>" +
            /* 上眼睑 */
            '<path d="M 91 75 C 96 70, 107 70, 112 75" fill="none" stroke="#2b3a52" ' +
            'stroke-width="3" stroke-linecap="round"/>' +
            '<path d="M 125 75 C 130 70, 141 70, 146 75" fill="none" stroke="#2b3a52" ' +
            'stroke-width="3" stroke-linecap="round"/>' +
            /* 腮红 + 嘴 */
            '<ellipse cx="86" cy="98" rx="10" ry="5.5" fill="url(#xl-blush)"/>' +
            '<ellipse cx="150" cy="98" rx="10" ry="5.5" fill="url(#xl-blush)"/>' +
            '<path d="M 113 102 C 117 106, 123 106, 127 102" fill="none" stroke="#c2604f" ' +
            'stroke-width="2.6" stroke-linecap="round"/>' +
            "</g>" +
            "</g>" +
            '<g class="hf-bubbles"></g>' +
            "</svg>"
          );
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
        tab.title = "唤出帅鱼";

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

        function renderCharacter() {
          var custom = !!artDataUrl;
          fish.innerHTML = custom
            ? '<div class="hf-art"><img class="hf-img" alt="自定义角色" src="' +
              artDataUrl +
              '"></div>'
            : xiaolanSVG();
          svgEl = fish.querySelector(".hf-svg");
          bubbleLayer = fish.querySelector(".hf-bubbles");
          fish.classList.toggle("is-custom", custom);
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
            else state[k] = clampNum(el.value, 0, 2, state[k]);
            if (k === "volume") audio.setVolume(state.volume);
            if (k === "size") applyPosition(false);
            if (k === "muted" && !state.muted) audio.pop(1.1);
            if (k === "snap" && state.snap) applyPosition(true);
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
        var turn = { seq: -1, fails: 0, timer: null };

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

        setTimeout(function () {
          if (!state.hidden) {
            speak(pick("greet"), 3600);
            spawnBubbles(2);
          }
        }, 1400);

        /* 调试 / 二次开发入口 */
        try {
          window.__HANDSOME_FISH__ = {
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
