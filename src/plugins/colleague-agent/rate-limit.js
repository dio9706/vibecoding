/**
 * 同事 agent 的两道限流闸。
 *
 * **必须跑在 web 进程**（agent 真正执行的地方）。放 feishu 进程的 feature 里，
 * 全局并发闸数的只是「自己发出去了几个 POST」，拦不住任何实际并发。
 *
 * 内存态，不落盘：限流是秒级短时状态，进程重启清零完全可接受，
 * 而落盘会给每条消息加一次文件锁往返。
 */

/** 拍板 #3 保守档。改这三个数前先想清楚额度影响：每轮 ~10s，并发 2 ≈ 12 轮/分 */
export const PER_PERSON_MAX = 5;
export const PER_PERSON_WINDOW_MS = 60_000;
export const GLOBAL_MAX_CONCURRENT = 2;

/**
 * @param {{now?: () => number}} [deps] 注入时钟便于测试
 */
export function createRateLimiter(deps = {}) {
  const now = deps.now || (() => Date.now());
  /** colleagueId → 该窗口内的放行时间戳数组 */
  const hits = new Map();
  let running = 0;

  function prune(id, t) {
    const arr = (hits.get(id) || []).filter((x) => t - x < PER_PERSON_WINDOW_MS);
    if (arr.length) hits.set(id, arr);
    else hits.delete(id); // 不留空数组：同事名册会增长，空条目积起来就是内存泄漏
    return arr;
  }

  return {
    /**
     * @returns {{ok:true, release:Function} | {ok:false, reason:'rate'|'busy'}}
     *   **被拒时不占配额**：否则超限那条会把人的窗口越撑越满，越刷越久解不开。
     */
    tryAcquire(colleagueId) {
      const t = now();
      const arr = prune(colleagueId, t);
      if (arr.length >= PER_PERSON_MAX) return { ok: false, reason: 'rate' };
      if (running >= GLOBAL_MAX_CONCURRENT) return { ok: false, reason: 'busy' };

      arr.push(t);
      hits.set(colleagueId, arr);
      running++;
      let released = false;
      return {
        ok: true,
        // 幂等：调用方大概率写在 finally 里，异常路径下可能被调两次
        release() {
          if (released) return;
          released = true;
          running--;
        },
      };
    },
    /** 测试与诊断用 */
    peekPersonCount(colleagueId) {
      return prune(colleagueId, now()).length;
    },
    peekRunning() {
      return running;
    },
  };
}

/** 进程内单例：限流的全局性必须全进程唯一，每次 new 一个等于没有限流 */
export const rateLimiter = createRateLimiter();
