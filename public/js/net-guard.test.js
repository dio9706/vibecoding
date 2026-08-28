/**
 * 掉线判定状态机测试。纯逻辑——展示层由 armNetworkGuard 注入回调，这里塞 spy，
 * 不碰 DOM。
 *
 * 每条用例都对应一个会真实发生的误判：
 *  - AbortError / __skipGuard：由 bootstrap 的包装负责拦，本模块只保证「被上报了就处理」
 *  - ping 通：单接口 500/偶发超时不该把好端端的后端说成异常
 *  - 并发上报：多路轮询（req/list 30s、conv-notify 5s）会在同一时刻集中失败
 *  - 未 arm：bootstrap 已装好包装、app.js 还没接线的那个窗口，此时该由启动罩负责
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { armNetworkGuard, reportNetworkFailure, disarmNetworkGuard } from './net-guard.js';

let downCalls;
let upCalls;
let pingResults; // 依次消费：true=后端活着，false=不通
let pingCount;

/** 装一个受控的全局 fetch：只服务 net-guard 内部的 /api/ping */
function stubPing(results) {
  pingResults = [...results];
  pingCount = 0;
  globalThis.fetch = async () => {
    pingCount++;
    const ok = pingResults.length ? pingResults.shift() : false;
    if (!ok) throw new TypeError('Failed to fetch');
    return { ok: true, json: async () => ({ status: 'ok' }) };
  };
}

beforeEach(() => {
  downCalls = 0;
  upCalls = 0;
  // armNetworkGuard 幂等重置状态机，每个用例重新装一次即得干净状态
  armNetworkGuard({
    onDown: () => { downCalls++; },
    onUp: () => { upCalls++; },
    retryMs: 5, // 测试里把重连间隔压到 5ms，避免等 2s
  });
});

// 必须拆卸：重连链会自我续期，留下 pending 定时器会让 node --test 迟迟不退出。
// 当前恰好靠最后一条用例的 beforeEach 清掉了，但那是顺序巧合，删一条用例就会挂。
after(() => {
  disarmNetworkGuard();
});

test('网络层失败 + ping 也不通 → 升罩', async () => {
  stubPing([false]);
  reportNetworkFailure();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(pingCount >= 1, true, '应至少 ping 一次做确认');
  assert.equal(downCalls, 1, '确认不通后应升罩一次');
});

test('网络层失败但 ping 通 → 不升罩（单接口偶发，不是掉线）', async () => {
  stubPing([true]);
  reportNetworkFailure();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(pingCount, 1, '应 ping 一次');
  assert.equal(downCalls, 0, 'ping 通就不该升罩');
});

test('升罩后 ping 恢复 → 自动撤罩', async () => {
  stubPing([false, false, true]); // 确认不通 → 重连一次仍不通 → 再重连通了
  reportNetworkFailure();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(downCalls, 1, '应升罩一次');
  assert.equal(upCalls, 1, '恢复后应撤罩一次');
});

test('并发上报去重：只 ping 一次，只升罩一次', async () => {
  // retryMs 必须设大：本例只关心「confirming 期间的重复上报被丢弃」。
  // 若沿用 beforeEach 的 5ms，30ms 等待窗口内重连定时器会自己发好几次 ping，
  // pingCount 断言就失去意义了。
  armNetworkGuard({
    onDown: () => { downCalls++; },
    onUp: () => { upCalls++; },
    retryMs: 60_000,
  });
  stubPing([false]);
  reportNetworkFailure();
  reportNetworkFailure();
  reportNetworkFailure();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(pingCount, 1, 'confirming 期间的重复上报应被丢弃');
  assert.equal(downCalls, 1, '只应升罩一次');
});

test('未 arm 时上报直接忽略，且不发 ping（启动阶段归 boot-gate 的启动罩管）', async () => {
  // 传空 deps 即回到「未 arm」：onDown 为 null，reportNetworkFailure 应立刻 return。
  // 这条不能靠「arm 了但 ping 通」来代替 —— 那验的是另一条分支（偶发失败），
  // 会漏掉「启动期 bootstrap 已装好包装、但 app.js 还没接线」这个真实窗口。
  armNetworkGuard({});
  stubPing([false]); // 故意让 ping 不通：真发了 ping 就会升罩，能抓出漏判
  reportNetworkFailure();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(pingCount, 0, '未 arm 时不该发 ping');
  assert.equal(downCalls, 0, '未 arm 时不该升罩');
});

test('arm 会作废在飞的确认 ping：重置后旧 ping 落地不得调用新 onDown', async () => {
  // 让 ping 慢一点落地，制造「确认在飞」的窗口
  let release;
  const gate = new Promise((r) => { release = r; });
  globalThis.fetch = async () => { await gate; throw new TypeError('Failed to fetch'); };

  let downA = 0;
  armNetworkGuard({ onDown: () => { downA++; }, onUp: () => {}, retryMs: 60_000 });
  reportNetworkFailure(); // 进入 confirming，ping 卡在 gate 上

  // 重置：换一组回调
  let downB = 0;
  armNetworkGuard({ onDown: () => { downB++; }, onUp: () => {}, retryMs: 60_000 });

  release(); // 旧 ping 现在落地
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(downA, 0, '旧回调不该被调用');
  assert.equal(downB, 0, '重置后，旧 ping 的结果必须作废，不该调用新回调');
});
