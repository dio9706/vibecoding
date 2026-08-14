import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handle, hasPending, PENDING_TTL_MS } from './index.js';
import { PASS } from '../../../app/signals.js';

/**
 * 追问状态机回归 —— 线上事故：
 * dispatch 第 0 步只要 hasPending 为真就无条件劫持该用户**全部**消息（跳过意图识别），
 * 而 pendingState 既无轮次上限也无超时，只有打「取消」能退出。
 * 结果：一次缺字段追问后，用户问任何别的问题都被当成在补字段，机器人反复追问同一句。
 * 现规则：一轮没补到任何字段 → 立即结束并把这条消息交回常规流程（PASS）。
 */

const CFG = {
  id: 'ac_test',
  name: '获取小程序二维码',
  permission: 'guest',
  variables: [
    { name: 'env', label: '环境', prompt: '要哪个环境？', required: true, persistent: false },
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

/** extract 由每个用例给定，脚本执行与变量落盘全部打桩（单测不联网、不写盘） */
function depsOf(extract, ran = []) {
  return {
    getConfig: () => CFG,
    extract,
    run: async (cfg, uid, vars) => {
      ran.push(vars);
      return { ok: true, output: '执行完成' };
    },
    saveVar: () => {},
  };
}

/**
 * 即时应答 —— 槽位抽取要调一次 LLM（生产实测 6~12s），期间用户看不到任何反馈，
 * 观感上就是「机器人死了」。意图确定后先回一句，与 feedback / bug-patrol 同款处理。
 */
describe('action-runner 即时应答', () => {
  it('新请求且有必填变量 → 先发即时应答，再发追问', async () => {
    const { ctx, replies } = ctxOf('u_ack', '给我个二维码');
    await handle(ctx, { actionId: CFG.id }, depsOf(async () => ({})));
    assert.equal(replies.length, 2);
    assert.notEqual(replies[0], '要哪个环境？', '第一条必须是即时应答，不是追问');
    assert.equal(replies[1], '要哪个环境？');
  });

  it('动作没有必填变量 → 不发即时应答（纯本地流程，不制造噪音）', async () => {
    const noVars = { ...CFG, id: 'ac_novar', variables: [] };
    const { ctx, replies } = ctxOf('u_ack_novar', '给我个二维码');
    await handle(ctx, { actionId: noVars.id }, { ...depsOf(async () => ({})), getConfig: () => noVars });
    assert.ok(!replies.some((t) => t.includes('稍等')), `不该有即时应答：${JSON.stringify(replies)}`);
  });

  it('追问轮不重复发即时应答（用户刚回答完，下一条马上就来）', async () => {
    const { ctx: c1 } = ctxOf('u_ack_pending', '给我个二维码');
    await handle(c1, { actionId: CFG.id }, depsOf(async () => ({})));

    const { ctx: c2, replies } = ctxOf('u_ack_pending', '体验版');
    await handle(c2, null, depsOf(async () => ({ env: 'test' })));
    assert.deepEqual(replies, ['手机号是？']);
  });

  it('即时应答发送失败不得中断动作（飞书限流时 reply 会抛）', async () => {
    const replies = [];
    let first = true;
    const ctx = {
      source: 'feishu',
      user: { id: 'u_ack_throw', role: 'guest' },
      text: '给我个二维码',
      reply: async (t) => {
        if (first) {
          first = false;
          throw new Error('飞书 429');
        }
        replies.push(t);
      },
    };
    await handle(ctx, { actionId: CFG.id }, depsOf(async () => ({})));
    assert.deepEqual(replies, ['要哪个环境？'], '即时应答挂了，追问仍要照发');
  });
});

describe('action-runner 追问状态机', () => {
  it('首轮缺字段 → 追问并挂起 pending', async () => {
    const { ctx, replies } = ctxOf('u_first', '给我个二维码');
    await handle(ctx, { actionId: CFG.id }, depsOf(async () => ({})));
    assert.equal(replies.at(-1), '要哪个环境？');
    assert.equal(hasPending(ctx), true);
  });

  it('追问轮补到字段 → 继续追问下一个缺失字段', async () => {
    const { ctx: c1 } = ctxOf('u_progress', '给我个二维码');
    await handle(c1, { actionId: CFG.id }, depsOf(async () => ({})));

    const { ctx: c2, replies } = ctxOf('u_progress', '体验版');
    await handle(c2, null, depsOf(async () => ({ env: 'test' })));
    assert.deepEqual(replies, ['手机号是？'], '补到了 env，应继续追问 phone');
    assert.equal(hasPending(c2), true);
  });

  it('追问轮一个字段都没补到 → 结束本次动作，并把消息交回常规流程（核心回归）', async () => {
    const { ctx: c1 } = ctxOf('u_stuck', '给我个二维码');
    await handle(c1, { actionId: CFG.id }, depsOf(async () => ({})));

    const { ctx: c2, replies } = ctxOf('u_stuck', '你们的登录接口在哪个文件里？');
    const r = await handle(c2, null, depsOf(async () => ({})));

    assert.equal(r, PASS, '必须返回 PASS，让 dispatch 继续做意图识别，别把用户的问题吞掉');
    assert.equal(hasPending(c2), false, 'pending 必须清掉，不能继续粘住后续消息');
    assert.equal(replies.length, 1, '只回一句「已结束」提示，正文由常规流程接管');
    assert.match(replies[0], /获取小程序二维码/);
  });

  it('追问轮补齐全部字段 → 执行脚本', async () => {
    const { ctx: c1 } = ctxOf('u_done', '给我个二维码');
    await handle(c1, { actionId: CFG.id }, depsOf(async () => ({})));

    const ran = [];
    const { ctx: c2, replies } = ctxOf('u_done', '体验版 15901039503');
    await handle(c2, null, depsOf(async () => ({ env: 'test', phone: '15901039503' }), ran));

    assert.deepEqual(ran, [{ env: 'test', phone: '15901039503' }]);
    assert.equal(hasPending(c2), false);
    assert.ok(replies.some((t) => t.includes('执行完成')));
  });

  it('pending 超过 TTL 自动失效（用户中途离开，几小时后的无关消息不该被当成补字段）', async () => {
    const { ctx } = ctxOf('u_ttl', '给我个二维码');
    await handle(ctx, { actionId: CFG.id }, depsOf(async () => ({})));

    assert.equal(hasPending(ctx), true);
    assert.equal(hasPending(ctx, Date.now() + PENDING_TTL_MS + 1), false);
  });

  it('「取消」随时可退出', async () => {
    const { ctx: c1 } = ctxOf('u_cancel', '给我个二维码');
    await handle(c1, { actionId: CFG.id }, depsOf(async () => ({})));

    const { ctx: c2, replies } = ctxOf('u_cancel', '取消');
    await handle(c2, null, depsOf(async () => ({})));
    assert.deepEqual(replies, ['已取消。']);
    assert.equal(hasPending(c2), false);
  });
});
