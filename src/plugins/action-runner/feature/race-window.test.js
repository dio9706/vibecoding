import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handle, hasPending } from './index.js';

/**
 * 首轮抽取竞态窗口回归 —— 线上事故（app-2026-09-01.log:231-255）：
 *
 *   07:19:22.591  用户：帮我清理环境数据   → L2 命中 → 起抽取（实测 8~17s）
 *   07:19:23.409  机器人：请稍等，我正在确认…
 *   07:19:28.785  用户：test环境           → hasPending 仍为 false（pending 写在 await extract 之后）
 *                                          → 绕过 action-runner，走常规意图识别
 *   07:19:35.305  机器人：要清理哪个环境？  → 首轮抽取此刻才结束，才 setPending
 *   07:19:40.812  [dispatch] 意图识别 {"intent":"other"}
 *   07:19:41.586  机器人：发送卡片          → 「没有识别到你的意图」帮助卡
 *
 * 用户明明答了环境，却先被回一张「没识别到意图」，再被反问一次同样的问题。
 * 修复：占位 pendingState 必须在**发起抽取之前**写入，窗口内到达的消息并入首轮。
 */

const CFG = {
  id: 'ac_race',
  name: '清理账号数据',
  permission: 'guest',
  variables: [
    { name: 'env', label: '环境', prompt: '要清理哪个环境？', required: true, persistent: false },
    { name: 'phone', label: '手机号', prompt: '手机号是？', required: true, persistent: true },
  ],
};

function ctxOf(userId, text) {
  const replies = [];
  return {
    replies,
    ctx: { source: 'feishu', user: { id: userId, role: 'guest' }, text, reply: async (t) => replies.push(t) },
  };
}

function depsOf(extract, ran = []) {
  return {
    getConfig: () => CFG,
    extract,
    run: async (_cfg, _uid, vars) => {
      ran.push(vars);
      return { ok: true, output: '执行完成' };
    },
    saveVar: () => {},
  };
}

/** 让出事件循环，使 handle 推进到 await extract 处 */
const tick = () => new Promise((r) => setImmediate(r));

describe('action-runner 首轮抽取竞态窗口', () => {
  it('抽取进行中 → hasPending 立即为真（补发消息不得漏给常规分发）', async () => {
    const { ctx } = ctxOf('u_race_gate', '帮我清理环境数据');
    let release;
    const gate = new Promise((r) => (release = r));
    const p = handle(ctx, { actionId: CFG.id }, depsOf(async () => {
      await gate;
      return {};
    }));

    await tick();
    assert.equal(
      hasPending({ user: { id: 'u_race_gate' } }),
      true,
      '发起抽取之前就应占位，否则窗口内的消息会被常规意图识别吞掉',
    );

    release();
    await p;
  });

  it('窗口内补发的环境词并入首轮，直接执行且不再追问', async () => {
    const { ctx, replies } = ctxOf('u_race_merge', '帮我清理环境数据');
    let release;
    const gate = new Promise((r) => (release = r));
    const seen = [];
    const ran = [];
    const extract = async (_cfg, text) => {
      seen.push(text);
      if (seen.length === 1) {
        await gate; // 首轮：慢，只抽到手机号
        return { phone: '13800138000' };
      }
      return { env: 'test' }; // 二轮：抽窗口内补发的「test环境」
    };
    const deps = depsOf(extract, ran);

    const first = handle(ctx, { actionId: CFG.id }, deps);
    await tick();

    // 用户在首轮还没抽完时抢答
    const second = ctxOf('u_race_merge', 'test环境');
    await handle(second.ctx, null, deps);

    release();
    await first;

    assert.deepEqual(ran, [{ phone: '13800138000', env: 'test' }], '两条消息应合并后直接执行');
    assert.equal(second.replies.length, 0, '窗口内的补发是抢答，不该单独回话');
    assert.ok(!replies.includes('要清理哪个环境？'), '已经答过的字段不该再追问');
  });

  it('窗口内无补发时行为不变 —— 抽取完仍正常追问缺失字段', async () => {
    const { ctx, replies } = ctxOf('u_race_plain', '帮我清理环境数据');
    await handle(ctx, { actionId: CFG.id }, depsOf(async () => ({ phone: '13800138000' })));
    assert.equal(replies.at(-1), '要清理哪个环境？');
    assert.equal(hasPending({ user: { id: 'u_race_plain' } }), true, '追问态应保留');
  });

  it('抽取期间用户打「取消」→ 动作必须真的放弃，不得照常执行', async () => {
    const { ctx } = ctxOf('u_race_cancel', '帮我清理环境数据');
    let release;
    const gate = new Promise((r) => (release = r));
    const ran = [];
    const deps = depsOf(async () => {
      await gate;
      return { env: 'test', phone: '13800138000' }; // 抽全了，正常会直接执行
    }, ran);

    const first = handle(ctx, { actionId: CFG.id }, deps);
    await tick();

    const cancel = ctxOf('u_race_cancel', '取消');
    await handle(cancel.ctx, null, deps);
    assert.deepEqual(cancel.replies, ['已取消。']);

    release();
    await first;

    assert.deepEqual(ran, [], '已取消的动作绝不能执行');
    assert.equal(hasPending({ user: { id: 'u_race_cancel' } }), false, '取消后不该残留追问态');
  });

  it('首轮已抽全时不为抢答再跑一次抽取（省一次 LLM 调用）', async () => {
    const { ctx } = ctxOf('u_race_enough', '清一下 test 的 13800138000');
    let release;
    const gate = new Promise((r) => (release = r));
    let calls = 0;
    const ran = [];
    const deps = depsOf(async () => {
      calls += 1;
      if (calls === 1) {
        await gate;
        return { env: 'test', phone: '13800138000' };
      }
      return {};
    }, ran);

    const first = handle(ctx, { actionId: CFG.id }, deps);
    await tick();
    await handle(ctxOf('u_race_enough', '哦对了').ctx, null, deps);
    release();
    await first;

    assert.equal(calls, 1, '必填已齐，抢答内容无关紧要，不该再调一次抽取');
    assert.deepEqual(ran, [{ env: 'test', phone: '13800138000' }]);
  });

  it('抽取抛错 → 占位态必须清干净，不能把用户锁死在动作里', async () => {
    const { ctx } = ctxOf('u_race_throw', '帮我清理环境数据');
    await handle(ctx, { actionId: CFG.id }, depsOf(async () => {
      throw new Error('boom');
    }));
    assert.equal(hasPending({ user: { id: 'u_race_throw' } }), false, '异常路径也要清占位');
  });
});
