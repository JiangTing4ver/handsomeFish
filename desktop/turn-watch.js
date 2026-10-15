/**
 * handsomeFish 桌面外壳 · 轮次监视器
 * =============================================================================
 * 为什么这段逻辑在外壳的 Node 侧，而不是像 DSH 页面载体那样在页面里轮询？
 *   实测结论：Chromium **禁止 `file://` 页面 fetch `http://`** —— 桌面窗里
 *   前端直接 fetch DSH 的状态路由会得到 `Failed to fetch`。
 *   Node 侧没有这个限制，所以由外壳轮询，再把结果通过 IPC 推给渲染页。
 *
 * 刻意做成不依赖 Electron 的纯 Node 模块：这样它能被 scripts/check.mjs 直接单测，
 * 不用真的把桌面窗跑起来。
 */

const DEFAULT_INTERVAL_MS = 1500;
/** 连续失败多少次后放弃轮询（DSH 没在跑时不要一直打日志、一直打请求） */
const DEFAULT_MAX_FAILURES = 3;

/**
 * @param {object} options
 * @param {string} options.url - 状态路由绝对地址
 * @param {number} [options.intervalMs]
 * @param {() => void} options.onTurnEnd - 检测到新的一轮结束时调用（首次基线不算）
 * @param {(msg: string) => void} [options.log]
 * @param {number} [options.maxFailures]
 * @param {typeof fetch} [options.fetchImpl] - 便于注入测试桩
 * @param {typeof setInterval} [options.setIntervalImpl]
 * @param {typeof clearInterval} [options.clearIntervalImpl]
 */
function createTurnWatcher(options) {
  const {
    url,
    onTurnEnd,
    intervalMs = DEFAULT_INTERVAL_MS,
    log = () => {},
    maxFailures = DEFAULT_MAX_FAILURES,
    fetchImpl = globalThis.fetch,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
  } = options || {};

  /** 最近一次观测到的 seq；-1 表示还没有基线 */
  let seq = -1;
  let failures = 0;
  let stopped = false;
  let timer = null;
  let polls = 0;

  function stop(reason) {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearIntervalImpl(timer);
    timer = null;
    if (reason) log(reason);
  }

  async function tick() {
    if (stopped || typeof fetchImpl !== "function") return;
    polls += 1;
    try {
      const response = await fetchImpl(url, { cache: "no-store" });
      if (!response || !response.ok) throw new Error(`HTTP ${response ? response.status : "?"}`);
      const data = await response.json();
      failures = 0;
      if (!data || typeof data.seq !== "number") return;
      if (seq < 0) {
        /* 首次只记基线：不回放宿主进程里已经发生过的历史轮次 */
        seq = data.seq;
        log(`基线 seq=${seq}（${url}）`);
        return;
      }
      if (data.seq > seq) {
        seq = data.seq;
        try {
          onTurnEnd(data);
        } catch (error) {
          log(`onTurnEnd 抛错：${error && error.message}`);
        }
      }
    } catch (error) {
      failures += 1;
      if (failures >= maxFailures) {
        stop(`状态路由连续 ${failures} 次不可达，已停止轮询（桌面窗将没有结束音）：${error && error.message}`);
      }
    }
  }

  return {
    start() {
      if (stopped || typeof fetchImpl !== "function") return;
      void tick();
      timer = setIntervalImpl(() => void tick(), intervalMs);
    },
    stop,
    /** 供测试与诊断读取的内部状态 */
    stats() {
      return { seq, failures, stopped, polls };
    },
  };
}

module.exports = { createTurnWatcher, DEFAULT_INTERVAL_MS, DEFAULT_MAX_FAILURES };
