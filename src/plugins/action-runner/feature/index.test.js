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
  it('这次真的调了 LLM → 先发即时应答，再发追问', async () => {
    // 新契约（2026-09-04）：判据是「本次是否真发起了 LLM 调用」，由 slot-filler 经
    // opts.onLlmStart 通知。这里的替身模拟「本地抽不出、确实要等模型」。
    const { ctx, replies } = ctxOf('u_ack', '给我个二维码');
    const extract = async (_cfg, _text, _uid, opts) => {
      opts?.onLlmStart?.();
      return {};
    };
    await handle(ctx, { actionId: CFG.id }, depsOf(extract));
    assert.equal(replies.length, 2);
    assert.notEqual(replies[0], '要哪个环境？', '第一条必须是即时应答，不是追问');
    assert.equal(replies[1], '要哪个环境？');
  });

  it('本地抽取全命中（没调 LLM）→ 不发即时应答', async () => {
    // 变量抽取契约上线后这是**主路径**：enum/pattern 变量亚毫秒抽完，直接执行。
    // 此时再弹「请稍等，我正在确认所需信息」，用户会紧接着看到「正在执行」，反而像卡了一下。
    const ran = [];
    const { ctx, replies } = ctxOf('u_ack_local', '给我 test 的二维码 13800138000');
    // 替身不调 onLlmStart —— 正是「本地就抽全了」的形态
    await handle(ctx, { actionId: CFG.id }, depsOf(async () => ({ env: 'test', phone: '13800138000' }), ran));
    assert.ok(!replies.some((t) => t.includes('稍等')), `不该有即时应答：${JSON.stringify(replies)}`);
    assert.equal(ran.length, 1, '应当直接执行');
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
    const extract = async (_cfg, _text, _uid, opts) => {
      opts?.onLlmStart?.();
      return {};
    };
    await handle(ctx, { actionId: CFG.id }, depsOf(extract));
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

/**
 * 关键词自学习的触发条件 —— 三道闸必须同时满足才学：
 * ① 这次是 L3 兜底认出来的（intentResult.via === 'llm'）
 * ② 脚本真的跑成功了（result.ok）
 * ③ 学的是**触发原句**，不是最后一条补槽位的回答
 */
describe('关键词自学习触发条件', () => {
  const CFG_NO_VAR = { id: 'ac_clean', name: '清理测试数据', permission: 'guest', variables: [] };

  /** ok 控制脚本成败；learned 收集学习调用 */
  function learnDeps(ok = true, learned = []) {
    return {
      deps: {
        getConfig: () => CFG_NO_VAR,
        extract: async () => ({}),
        run: async () => ({ ok, output: ok ? '执行完成' : '脚本报错' }),
        saveVar: () => {},
        learn: async (arg) => { learned.push(arg); },
      },
      learned,
    };
  }

  it('L3 兜底命中 + 执行成功 → 学，且学的是触发原句', async () => {
    const { deps, learned } = learnDeps(true);
    const { ctx } = ctxOf('u_learn_1', '帮我把 test 的业务表清掉');
    await handle(ctx, { actionId: 'ac_clean', via: 'llm' }, deps);
    // fire-and-forget：让微任务队列排空
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(learned.length, 1);
    assert.equal(learned[0].sourceText, '帮我把 test 的业务表清掉');
    assert.equal(learned[0].action.id, 'ac_clean');
  });

  it('L2 关键词命中（无 via）→ 不学', async () => {
    const { deps, learned } = learnDeps(true);
    const { ctx } = ctxOf('u_learn_2', '帮我把 test 的业务表清掉');
    await handle(ctx, { actionId: 'ac_clean' }, deps);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(learned.length, 0);
  });

  it('脚本执行失败 → 不学（误判不许固化成关键词）', async () => {
    const { deps, learned } = learnDeps(false);
    const { ctx } = ctxOf('u_learn_3', '帮我把 test 的业务表清掉');
    await handle(ctx, { actionId: 'ac_clean', via: 'llm' }, deps);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(learned.length, 0);
  });

  it('学习抛异常 → 用户仍拿到执行结果（fire-and-forget 不许带崩主流程）', async () => {
    const { ctx, replies } = ctxOf('u_learn_4', '帮我把 test 的业务表清掉');
    await handle(ctx, { actionId: 'ac_clean', via: 'llm' }, {
      getConfig: () => CFG_NO_VAR,
      extract: async () => ({}),
      run: async () => ({ ok: true, output: '执行完成' }),
      saveVar: () => {},
      learn: async () => { throw new Error('模型挂了'); },
    });
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(replies.some((r) => r.includes('执行完成')), '执行结果必须照常送达');
  });

  it('经过多轮追问后执行成功 → 学的仍是触发原句，不是最后那句「test」', async () => {
    const CFG_ONE_VAR = {
      id: 'ac_clean',
      name: '清理测试数据',
      permission: 'guest',
      variables: [{ name: 'env', label: '环境', prompt: '要哪个环境？', required: true }],
    };
    const learned = [];
    const deps = {
      getConfig: () => CFG_ONE_VAR,
      // 首轮抽不出 env（触发追问），追问轮抽得出
      extract: async (cfg, text) => (text === 'test' ? { env: 'test' } : {}),
      run: async () => ({ ok: true, output: '执行完成' }),
      saveVar: () => {},
      learn: async (arg) => { learned.push(arg); },
    };

    const first = ctxOf('u_learn_5', '帮我把业务表清掉');
    await handle(first.ctx, { actionId: 'ac_clean', via: 'llm' }, deps);
    assert.ok(first.replies.some((r) => r.includes('环境')), '首轮应追问环境');

    const second = ctxOf('u_learn_5', 'test');
    await handle(second.ctx, null, deps);
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(learned.length, 1);
    assert.equal(learned[0].sourceText, '帮我把业务表清掉', 'sourceText 必须是触发原句');
  });

  /**
   * M-1 回归 —— 慢抽取窗口里 pendingState 会**串台**，learnSrc 绝不能从 Map 里取。
   *
   * 时序（审查实测复现）：
   *   ① 用户「清一下业务表」→ 命中动作 X → 起慢抽取（占位已写）
   *   ② 窗口内打「取消」    → 占位被删，X 本应作废
   *   ③ 仍在窗口内「给我张小程序码」→ L3 命中动作 Y → Y 把自己的 learnSrc 写进**同一个 userId key**
   *   ④ X 的抽取返回 → has(userId) 看到的是 Y 的条目 → 误判「没被取消」→ X 照常执行
   *
   * 此刻 X 若去 `pendingState.get(userId)?.learnSrc`，拿到的是 **Y 的原句**，
   * 于是「小程序码」被永久写进 X 的关键词表 —— 此后任何人说这句都会 L2 单命中 X、
   * 零模型介入直接跑 X 的脚本。keyword-guard 两道主闸都拦不住：规则 1 只校验候选词出现在
   * sourceText 里（那正是 Y 的原话），规则 5 比的是 Y 已有的 keywords（Y 恰恰因没命中才走 L3）。
   *
   * 这两条用例只钉死一件事：**X 学到的原句只能来自 X 自己**。
   *
   * ⚠️ 前提依赖，改 `has()` 的人请先读这段：
   * ④ 之所以成立，是因为 `pendingState.has(userId)` 只认 userId、不认 actionId（身份盲检）——
   * 这是既有的洞，不是本次引入的，也不该由关键词自学习顺手改（碰它要重评整个取消语义）。
   * 下面「X 是 L3 命中」那条用例断言的是「被取消的 X 执行成功后学到 **X 自己的** 原句」，
   * 它**预设了这个洞还在**。等有人把 `has()` 改成比对 actionId，X 在 ④ 处就会被正确放弃、
   * 压根不会执行，那条用例的预期要随之改成「什么都不学」（learned.length === 0）——
   * 届时它变红是**修对了**的信号，不是回归，别改回 `has()` 去迁就它。
   * 「X 是 L2 命中」那条不受影响：X 本就没资格学，两种实现下都是 0。
   */
  const X_TEXT = '清一下业务表';
  const Y_TEXT = '给我张小程序码';
  const CFG_X = { id: 'ac_x', name: '清理测试数据', permission: 'guest', variables: [] };
  const CFG_Y = {
    id: 'ac_y',
    name: '获取小程序二维码',
    permission: 'guest',
    // 留一个必填变量，好让 Y 停在追问态、把 learnSrc 留在 Map 里等着被 X 误读
    variables: [{ name: 'env', label: '环境', prompt: '要哪个环境？', required: true }],
  };

  /** 造上述串台时序；xIntent 决定 X 这一次是 L2 还是 L3 命中 */
  async function crossTalk(userId, xIntent, learned) {
    let release;
    const gate = new Promise((r) => (release = r));
    const deps = {
      getConfig: (id) => (id === 'ac_x' ? CFG_X : CFG_Y),
      // 只有 X 的抽取慢（模拟生产 8~17s 的 LLM 抽取），Y 的立刻返回
      extract: async (cfg) => {
        if (cfg.id === 'ac_x') await gate;
        return {};
      },
      run: async () => ({ ok: true, output: '执行完成' }),
      saveVar: () => {},
      learn: async (arg) => { learned.push(arg); },
    };

    const xRun = handle(ctxOf(userId, X_TEXT).ctx, xIntent, deps); // ① 不 await：X 卡在抽取里
    await new Promise((r) => setImmediate(r)); // 让 X 推进到 await extract 处

    await handle(ctxOf(userId, '取消').ctx, null, deps); // ②
    await handle(ctxOf(userId, Y_TEXT).ctx, { actionId: 'ac_y', via: 'llm' }, deps); // ③

    release(); // ④
    await xRun;
    await new Promise((r) => setTimeout(r, 0)); // fire-and-forget 排空
  }

  it('串台窗口：X 是 L2 命中 → 一个字都不学，绝不借用 Y 留在 Map 里的原句', async () => {
    const learned = [];
    await crossTalk('u_cross_l2', { actionId: 'ac_x' }, learned);
    assert.equal(
      learned.length,
      0,
      `X 是 L2 命中的，本就没资格学任何东西，实际学到：${JSON.stringify(learned)}`,
    );
  });

  it('串台窗口：X 是 L3 命中 → 学的是 X 自己的原句，不是 Y 的', async () => {
    const learned = [];
    await crossTalk('u_cross_l3', { actionId: 'ac_x', via: 'llm' }, learned);
    assert.equal(learned.length, 1);
    assert.equal(learned[0].action.id, 'ac_x');
    assert.equal(learned[0].sourceText, X_TEXT, 'learnSrc 必须来自 X 的局部变量，不是 Map 里 Y 的条目');
    assert.ok(
      !learned.some((l) => l.sourceText === Y_TEXT),
      'Y 的原句一旦学进 X 的关键词表就是永久误触发',
    );
  });
});

/**
 * 执行目标回显 —— 线上事故回归（2026-09-18 定位）：
 *
 * `phone` 声明为 `persistent: true`，用户 9-07 为帮别人退款报过一次 13364860092，
 * 它被写进 user-vars 成为永久默认目标；此后每次只说「帮我清理环境数据」，抽取层判
 * 「本次没提手机号 → 用持久值顶掉且不追问」，于是连续 11 天所有清理/退款都打在那个号上。
 * 而回执只有脚本那句「清理账号数据完成」——不含环境、不含手机号，清错目标在用户侧
 * 完全不可观测，表现就是「他说清了但实际上就没清」（实证 app-2026-09-18.log:423-443）。
 *
 * 口径（用户 2026-09-18 拍板「只回显不拦」）：不加确认轮次、不改持久化语义，
 * 但执行前的 ⏳ 与执行后的回执**都必须报出目标**，让清错号当场可见。
 */
describe('执行目标回显', () => {
  /** 两个变量都已抽到 → 首轮直接执行，便于观察 ⏳ 与结果两条回执 */
  function targetDeps(runResult) {
    return {
      getConfig: () => CFG,
      extract: async () => ({ env: 'dev', phone: '13364860092' }),
      run: async () => runResult,
      saveVar: () => {},
    };
  }

  it('⏳ 与成功回执都带上执行目标，手机号脱敏', async () => {
    const { ctx, replies } = ctxOf('u_target_ok', '帮我清理环境数据');
    await handle(ctx, { actionId: CFG.id }, targetDeps({ ok: true, output: '清理账号数据完成' }));

    const running = replies.find((r) => r.includes('正在执行'));
    assert.ok(running, '必须有「正在执行」那条');
    assert.ok(running.includes('环境 dev'), `执行前要报出环境，实际：${running}`);
    assert.ok(running.includes('133****0092'), `执行前要报出脱敏手机号，实际：${running}`);

    const done = replies.at(-1);
    assert.ok(done.includes('清理账号数据完成'), '脚本自己的输出仍是正文');
    assert.ok(done.includes('环境 dev'), `成功回执要带环境，实际：${done}`);
    assert.ok(done.includes('133****0092'), `成功回执要带脱敏手机号，实际：${done}`);
  });

  it('明文手机号绝不出现在任何回执里', async () => {
    const { ctx, replies } = ctxOf('u_target_mask', '帮我清理环境数据');
    await handle(ctx, { actionId: CFG.id }, targetDeps({ ok: true, output: '清理账号数据完成' }));
    assert.ok(
      !replies.some((r) => r.includes('13364860092')),
      `回执里出现了明文手机号：${JSON.stringify(replies)}`,
    );
  });

  it('失败回执同样带目标（失败在哪个环境、哪个号，是排查的第一手信息）', async () => {
    const { ctx, replies } = ctxOf('u_target_fail', '帮我清理环境数据');
    await handle(ctx, { actionId: CFG.id }, targetDeps({ ok: false, output: '❌ 清理失败：用户不存在' }));
    const done = replies.at(-1);
    assert.ok(done.includes('清理失败：用户不存在'), '失败原因必须原样送达');
    assert.ok(done.includes('133****0092'), `失败回执要带目标，实际：${done}`);
  });

  /**
   * exit 0 只说明「脚本自己认为跑完了」，它什么都没说的时候，框架不许替它宣布成功。
   * 旧文案 `✅ 清理账号数据完成` 是纯伪造，正是「明明啥也没干却报成功」的帮凶。
   */
  it('脚本 exit 0 但零输出 → 不许伪造「完成」，必须说明脚本无输出', async () => {
    const { ctx, replies } = ctxOf('u_target_silent', '帮我清理环境数据');
    await handle(ctx, { actionId: CFG.id }, targetDeps({ ok: true, output: '' }));
    const done = replies.at(-1);
    assert.ok(done.includes('无输出'), `零输出时必须如实说明，实际：${done}`);
    assert.ok(done.includes('133****0092'), `仍要带目标，实际：${done}`);
  });
});
