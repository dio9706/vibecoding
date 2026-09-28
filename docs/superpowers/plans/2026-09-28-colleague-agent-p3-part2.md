# 同事侧对话 Agent 化 P3 · 第二部分（Task 4–10）

> 第一部分（架构、拍板记录、文件结构、Task 1–3）见 `2026-09-28-colleague-agent-p3.md`。**先读完那份的 §0「三个读 spec 推不出来的事实」再动手。**

> ## ⛔ 全局约束：本计划的所有「提交」步骤一律跳过
>
> 项目根 `CLAUDE.md` 明文：**不自动 `git` 提交，改动留工作区，提交时机由维护者掌控**。
> 正文里残留的 `git add` / `git commit` 代码块是 writing-plans 模板的默认产物，
> **执行时一概不执行**。同理不要 `checkout` / `restore` / `stash` / `branch` ——
> 工作区里长期并存着多个功能的未提交改动，任何 git 写操作都可能卷走别人的活。
> 只读命令（`git status` / `git diff` / `git grep`）随便用。
>
> **唯一例外**：Task 8 Step 4 用 `git rm` 删除旧管线文件。那一步请改用普通文件删除
> （`rm`），效果等价且不动索引。
>
> 每个 Task 的验收依据是 **`npm test` 全绿**，不是「提交成功」。

> ## 📌 过渡期已知限制（Task 2 引入 → Task 8 终结）
>
> **不是 bug，不要在后续 Task 的审查里重新讨论它，也不要试图补救。**
>
> Task 2 下线了 `_pending` 待归属缓冲（同事参与多需求时发卡片让他手选）。作为过渡处置，
> `colleague-relay/feature.js` 与 `feishu/index.js` 改为**静默归入 `reqs[0]` 并 `logger.warn` 留痕**。
>
> 影响面（2026-09-28 代码质量审查指出，已确认）：同事若真的同时参与 2+ 个开发期需求、
> 而这次消息说的是第二个，会被打错 `reqId` 标签。**这不只是展示问题** —— 错误的 `reqId`
> 会经 `notifyAutoHandle` 流进四期自动处理，可能让 AI 带着错误的需求上下文回复。
> 同事收到的 ACK 文案没有变化，看不出自己被错误归类。
>
> 为什么接受它：这两个文件在 Task 7/8 会被整体改写/删除，agent 接手后归属由模型逐条判定
> （判不准会直接问同事），这个限制随之消失。过渡窗口只存在于 Task 2 → Task 8 之间。
>
> **⚠️ 因此：P3 全程不要重新打包部署桌面版。** 工作区在 Task 8 完成前始终是半成品
> （选择卡已下线、agent 链路未建成）。当前运行的桌面版是旧打包产物，不受工作区影响。
>
> **Task 8 完成后请回来划掉这一段** —— 届时 `colleague-relay/` 整个目录连同这个限制一起消失。

---

## Task 4: `session.js` —— web 进程的 agent 编排层

**Files:**
- Create: `src/plugins/colleague-agent/session.js`
- Test: `src/plugins/colleague-agent/session.test.js`

这一层是 P3 的心脏：把「一条同事消息」变成「一轮 agent 对话 + 一条回复」。**只在 web 进程跑**（理由见第一部分 §0.1）。

- [ ] **Step 1: 先读要用的三个既有接口**

读这三处，确认签名（它们都已就绪，不要改）：

| 文件 | 要用的东西 |
|---|---|
| `src/capabilities/agent-session.js:122` | `runAgentTurn({userText, systemPrompt, server, allowed, sessionId, logTag})` → `{text, sessionId, toolTrace, reason}`，`reason` 为 `null`/`'exhausted'`/`'timeout'`/`'error'` |
| `src/capabilities/agent-tools.js:147` | `buildAgentMcpServer(role, {ctx})` → `{server, allowed, defs}` |
| `src/plugins/colleague-agent/prompt.js:29` | `buildSystemPrompt({colleague, roleLabel, requirements})` |

再读 `src/integrations/lark.js` 确认 `sendTextToUser(creds, openId, text)` 的签名，以及 `src/plugins/team-tools/task-notify.js:29` 的 `creds()` 写法（web 进程取飞书凭证的既有范式，照抄）。

- [ ] **Step 2: 写失败的测试**

创建 `src/plugins/colleague-agent/session.test.js`：

```js
/**
 * agent 编排层单测。真实 SDK / lark / store 全部经 deps 注入替换 ——
 * 这一层的价值全在「四条失败路径各自退化成什么」，那才是要钉死的东西。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleColleagueTurn, ACK_FALLBACK, ACK_BUSY, ACK_RATE } from './session.js';

/** 一套跑得通的默认依赖，各用例按需覆盖 */
function deps(over = {}) {
  const sent = [];
  const appended = [];
  return {
    sent,
    appended,
    d: {
      getColleague: () => ({ id: 'cl_1', name: '张三', role: 'backend', feishuOpenId: 'ou_1' }),
      getRequirements: () => [{ id: 'r_a', title: '需求A', phase: 'dev', assignees: ['cl_1'] }],
      getAgentSessionId: () => null,
      setAgentSessionId: () => {},
      appendTo: (cid, e) => (appended.push({ cid, e }), { ...e, id: 'cm_out' }),
      buildServer: () => ({ server: {}, allowed: new Set(['mcp__colleague__get_requirement']), defs: [{}] }),
      runTurn: async () => ({ text: '查过了，接口没问题', sessionId: 'sess_new', toolTrace: [{ name: 'get_requirement', input: {} }], reason: null }),
      sendText: async (openId, text) => sent.push({ openId, text }),
      tryAcquire: () => ({ ok: true, release() {} }),
      ...over,
    },
  };
}

test('正常一轮：回复发给同事、出站消息落盘、sessionId 回填', async () => {
  const { d, sent, appended } = deps();
  let saved = null;
  d.setAgentSessionId = (cid, id) => (saved = { cid, id });

  const r = await handleColleagueTurn({ colleagueId: 'cl_1', text: '接口文档发你了' }, d);

  assert.equal(r.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].openId, 'ou_1');
  assert.equal(sent[0].text, '查过了，接口没问题');
  assert.equal(appended.length, 1, '只落出站这一条——入站那条由飞书进程落，这里再落一次就是重复');
  assert.equal(appended[0].e.dir, 'out');
  assert.equal(appended[0].e.toolTrace.length, 1, '工具轨迹必须落盘，这是 P5 监管面的数据源');
  assert.deepEqual(saved, { cid: 'cl_1', id: 'sess_new' });
});

test('resume：已有 sessionId 时透传给 runAgentTurn，长期 thread 全靠它', async () => {
  const { d } = deps({ getAgentSessionId: () => 'sess_old' });
  let seen = null;
  d.runTurn = async (o) => ((seen = o), { text: 'ok', sessionId: 'sess_old', toolTrace: [], reason: null });
  await handleColleagueTurn({ colleagueId: 'cl_1', text: 'x' }, d);
  assert.equal(seen.sessionId, 'sess_old');
});

test('限流 rate：回固定话术，不起 agent，不落出站消息', async () => {
  const { d, sent, appended } = deps({ tryAcquire: () => ({ ok: false, reason: 'rate' }) });
  let ran = false;
  d.runTurn = async () => ((ran = true), {});

  const r = await handleColleagueTurn({ colleagueId: 'cl_1', text: 'x' }, d);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'rate');
  assert.equal(ran, false, '超限就绝不能起 agent，那正是限流的意义');
  assert.equal(sent[0].text, ACK_RATE);
  assert.equal(appended.length, 0);
});

test('限流 busy：话术与 rate 不同（一个是你太快、一个是机器忙，处置不一样）', async () => {
  const { d, sent } = deps({ tryAcquire: () => ({ ok: false, reason: 'busy' }) });
  await handleColleagueTurn({ colleagueId: 'cl_1', text: 'x' }, d);
  assert.equal(sent[0].text, ACK_BUSY);
  assert.notEqual(ACK_BUSY, ACK_RATE);
});

test('额度耗尽：退化到 ACK，消息不丢（spec §8「不会比现状更糟」）', async () => {
  const { d, sent } = deps();
  d.runTurn = async () => ({ text: '', sessionId: null, toolTrace: [], reason: 'exhausted' });
  const r = await handleColleagueTurn({ colleagueId: 'cl_1', text: 'x' }, d);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'exhausted');
  assert.equal(sent[0].text, ACK_FALLBACK);
});

test('超时 / 异常：同样退化到 ACK', async () => {
  for (const reason of ['timeout', 'error']) {
    const { d, sent } = deps();
    d.runTurn = async () => ({ text: '', sessionId: null, toolTrace: [], reason });
    await handleColleagueTurn({ colleagueId: 'cl_1', text: 'x' }, d);
    assert.equal(sent[0].text, ACK_FALLBACK, `reason=${reason} 应落 ACK`);
  }
});

test('模型返回空文本（无 reason）也走 ACK —— 静默不回是最糟的失败形态', async () => {
  const { d, sent } = deps();
  d.runTurn = async () => ({ text: '   ', sessionId: 'sess_x', toolTrace: [], reason: null });
  await handleColleagueTurn({ colleagueId: 'cl_1', text: 'x' }, d);
  assert.equal(sent[0].text, ACK_FALLBACK);
});

test('失败路径也要 release 限流位 —— 不放的话并发闸会被永久占死', async () => {
  let released = 0;
  const { d } = deps({ tryAcquire: () => ({ ok: true, release: () => released++ }) });
  d.runTurn = async () => {
    throw new Error('boom');
  };
  await handleColleagueTurn({ colleagueId: 'cl_1', text: 'x' }, d);
  assert.equal(released, 1);
});

test('runTurn 抛错：吞掉并回 ACK，绝不让异常穿回 HTTP 层', async () => {
  const { d, sent } = deps();
  d.runTurn = async () => {
    throw new Error('boom');
  };
  const r = await handleColleagueTurn({ colleagueId: 'cl_1', text: 'x' }, d);
  assert.equal(r.ok, false);
  assert.equal(sent[0].text, ACK_FALLBACK);
});

test('同事不在名册：直接放弃，不起 agent 也不发消息', async () => {
  const { d, sent } = deps({ getColleague: () => null });
  const r = await handleColleagueTurn({ colleagueId: 'cl_x', text: 'x' }, d);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown-colleague');
  assert.equal(sent.length, 0);
});

test('同事没填 feishuOpenId：不起 agent（回复无处可送，跑了纯属烧额度）', async () => {
  const { d } = deps({ getColleague: () => ({ id: 'cl_1', name: '张三', role: 'backend', feishuOpenId: '' }) });
  let ran = false;
  d.runTurn = async () => ((ran = true), {});
  const r = await handleColleagueTurn({ colleagueId: 'cl_1', text: 'x' }, d);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-openid');
  assert.equal(ran, false);
});

test('零工具时仍继续（有 warn 兜底），但要在结果里标出来供排查', async () => {
  const { d } = deps({ buildServer: () => ({ server: {}, allowed: new Set(), defs: [] }) });
  const r = await handleColleagueTurn({ colleagueId: 'cl_1', text: 'x' }, d);
  assert.equal(r.ok, true);
  assert.equal(r.toolCount, 0, '零工具是「插件没加载」的信号，必须可观测');
});

test('只把 dev/review/test 阶段的需求喂进 prompt —— 归档废弃的是噪音', async () => {
  const { d } = deps({
    getRequirements: () => [
      { id: 'r_a', title: 'A', phase: 'dev', assignees: ['cl_1'] },
      { id: 'r_z', title: 'Z', phase: 'archived', assignees: ['cl_1'] },
      { id: 'r_o', title: 'O', phase: 'dev', assignees: ['cl_9'] },
    ],
  });
  let seen = null;
  d.runTurn = async (o) => ((seen = o), { text: 'ok', sessionId: 's', toolTrace: [], reason: null });
  await handleColleagueTurn({ colleagueId: 'cl_1', text: 'x' }, d);
  assert.match(seen.systemPrompt, /r_a/);
  assert.doesNotMatch(seen.systemPrompt, /r_z/, '已归档的不该出现');
  assert.doesNotMatch(seen.systemPrompt, /r_o/, '别人的需求不该出现');
});
```

- [ ] **Step 3: 跑到失败**

Run: `node --test src/plugins/colleague-agent/session.test.js`
Expected: FAIL — `Cannot find module './session.js'`

- [ ] **Step 4: 实现**

创建 `src/plugins/colleague-agent/session.js`：

```js
/**
 * 同事对话 agent 的编排层 —— 把「一条同事消息」变成「一轮 agent 对话 + 一条回复」。
 *
 * **只在 web 进程跑。** 工具的 handler 要调 `entrypoints/web/requirement-ops.js` 的
 * `registerApiDoc` / `enqueueSystemTask`，那两个函数操作的是 web 进程内存里的需求泵与
 * busy 状态机；在 feishu 进程跑会拿到另一份实例，`start_dev_task` 入队后永远不被执行。
 *
 * 失败一律退化到 ACK（spec §8「任何失败都不会比现状更糟」）：同事手里至少有一句回执，
 * 入站消息已经由飞书进程落盘，主机在 web 端看得到原文。**最糟的失败形态是静默不回**，
 * 所以连「模型返回空文本」都走 ACK。
 */
import { logger } from '../../shared/logger.js';
import { getColleagues, ROLES } from '../../store/colleagues.js';
import { getRequirements } from '../../store/requirements.js';
import { getAgentSessionId, setAgentSessionId, appendTo } from '../../store/colleague-messages.js';
import { buildAgentMcpServer } from '../../capabilities/agent-tools.js';
import { runAgentTurn } from '../../capabilities/agent-session.js';
import { getActiveBot } from '../../store/settings.js';
import { sendTextToUser } from '../../integrations/lark.js';
import { buildSystemPrompt } from './prompt.js';
import { rateLimiter } from './rate-limit.js';

/** 三句固定话术。刻意分开：同事据此知道该等一下还是该改口 */
export const ACK_FALLBACK = '已收到，信息会同步发送给主机！';
export const ACK_BUSY = '已收到，我这边正忙，稍后回复你～';
export const ACK_RATE = '已收到，消息有点密，我按顺序处理，稍等一下～';

/** 喂进 prompt 的需求阶段。归档/废弃的是噪音，会让模型把陈年需求当成在做的 */
const LIVE_PHASES = new Set(['review', 'dev', 'test']);

/** 当前启用机器人的私聊发送凭证（照抄 task-notify.js#creds 的范式） */
function creds() {
  const bot = getActiveBot();
  return bot?.appId && bot?.appSecret ? { appId: bot.appId, appSecret: bot.appSecret } : null;
}

function roleLabelOf(roleId) {
  return ROLES.find((r) => r.id === roleId)?.label || roleId || '同事';
}

/**
 * 跑一轮同事对话。
 *
 * @param {{colleagueId:string, text:string, msgId?:string, files?:Array}} input
 * @param {object} [deps] 注入便于单测（真实依赖见默认值）
 * @returns {Promise<{ok:boolean, reason?:string, toolCount?:number}>} **不抛**
 */
export async function handleColleagueTurn(input, deps = {}) {
  const {
    getColleague = (id) => getColleagues().find((c) => c.id === id) || null,
    getRequirements: getReqs = getRequirements,
    getAgentSessionId: getSid = getAgentSessionId,
    setAgentSessionId: setSid = setAgentSessionId,
    appendTo: append = appendTo,
    buildServer = buildAgentMcpServer,
    runTurn = runAgentTurn,
    sendText = async (openId, text) => {
      const c = creds();
      if (c) await sendTextToUser(c, openId, text);
    },
    tryAcquire = (id) => rateLimiter.tryAcquire(id),
  } = deps;

  const { colleagueId, text = '', msgId = null, files = [] } = input || {};
  const colleague = getColleague(colleagueId);
  if (!colleague) {
    logger.warn('colleague-agent', '未知同事，放弃本轮', { colleagueId });
    return { ok: false, reason: 'unknown-colleague' };
  }
  // 没有 open_id 就没地方送回复，跑完也是白跑 —— 在花额度之前拦掉
  if (!colleague.feishuOpenId) {
    logger.warn('colleague-agent', '同事未填飞书 open_id，放弃本轮', { colleagueId });
    return { ok: false, reason: 'no-openid' };
  }

  const gate = tryAcquire(colleagueId);
  if (!gate.ok) {
    logger.info('colleague-agent', '限流，回 ACK 不起 agent', { colleagueId, reason: gate.reason });
    await sendText(colleague.feishuOpenId, gate.reason === 'busy' ? ACK_BUSY : ACK_RATE);
    return { ok: false, reason: gate.reason };
  }

  try {
    const requirements = getReqs().filter(
      (r) => LIVE_PHASES.has(r.phase) && (r.assignees || []).includes(colleagueId),
    );
    const systemPrompt = buildSystemPrompt({
      colleague,
      roleLabel: roleLabelOf(colleague.role),
      requirements,
    });

    // ctx 会被 Object.freeze 后闭包进每个 handler：工具靠它知道「这是谁、哪条消息、带了什么文件」。
    // **files 走 ctx 而不是 userText**，理由见下面 fileLine 的注释。
    const { server, allowed, defs } = buildServer(colleague.role, {
      ctx: { colleagueId, role: colleague.role, msgId, files },
    });

    // 只把**文件名**给模型，**绝对路径一律不进模型上下文**。
    //
    // 这不是洁癖，是本仓已经立过两次的规矩：`tools/req-read.js` 文件头纪律第 3 条
    // 「不给落盘绝对路径：模型没有读它的工具，给了只会诱导它编造」，`get_api_doc` 的 handler
    // 身体力行地把 path 摘掉；`capabilities/agent-tools.js` 的错误处理同样为此把 e.message
    // 换成固定短语 ——「这个 agent 的对话对象是公司同事，不是主机」。
    //
    // 路径进了上下文，模型就可能在回复里念出 `C:\Users\…\data\uploads\…`，
    // 把主机用户名与数据目录结构讲给同事听。需要路径的工具（register_api_doc）
    // 改从 `ctx.files` 按文件名取，服务端解析，模型全程不经手。
    const fileLine = files.length
      ? `\n\n[他同时发来了文件]\n` + files.map((f) => `- ${f.name || '(未命名)'}`).join('\n')
      : '';

    const r = await runTurn({
      userText: `${text}${fileLine}`,
      systemPrompt,
      server,
      allowed,
      sessionId: getSid(colleagueId) || undefined,
      logTag: `colleague:${colleagueId}`,
    });

    const reply = String(r?.text || '').trim();
    if (r?.reason || !reply) {
      // 退化到 ACK。入站消息早已落盘，主机在 web 端看得到，同事也有回执 —— 不比现状更糟
      logger.warn('colleague-agent', '本轮未产出回复，退化到 ACK', {
        colleagueId,
        reason: r?.reason || 'empty-text',
      });
      await sendText(colleague.feishuOpenId, ACK_FALLBACK);
      return { ok: false, reason: r?.reason || 'empty-text', toolCount: defs.length };
    }

    await sendText(colleague.feishuOpenId, reply);
    // 只落出站这一条：入站那条由飞书进程在触发前就落好了，这里再落一次就是重复
    append(colleagueId, {
      dir: 'out',
      text: reply,
      role: colleague.role,
      reqId: null, // 出站消息不打需求标签：它是对某条入站的回应，归属看那条
      toolTrace: r.toolTrace || [],
    });
    // sessionId 可能为 null（SDK 未回 init/result），runAgentTurn 已保留旧值，这里照写即可
    if (r.sessionId) setSid(colleagueId, r.sessionId);

    logger.info('colleague-agent', '一轮完成', {
      colleagueId,
      tools: (r.toolTrace || []).length,
      chars: reply.length,
    });
    return { ok: true, toolCount: defs.length };
  } catch (e) {
    // 绝不让异常穿回 HTTP 层：那会让飞书进程的 fire-and-forget 收到 500 且无人处理
    logger.warn('colleague-agent', '本轮异常（已捕获）', { colleagueId, err: e?.message || String(e) });
    try {
      await sendText(colleague.feishuOpenId, ACK_FALLBACK);
    } catch {
      /* 连 ACK 都发不出去就只能认了 */
    }
    return { ok: false, reason: 'error' };
  } finally {
    // 不放位的话全局并发闸会被永久占死，两条之后整个功能静默停摆
    gate.release();
  }
}
```

- [ ] **Step 5: 跑到通过**

Run: `node --test src/plugins/colleague-agent/session.test.js`
Expected: PASS（13 项）

Run: `npm test`
Expected: 全绿

- [ ] **Step 6: 提交**

```bash
git add src/plugins/colleague-agent/session.js src/plugins/colleague-agent/session.test.js
git commit -m "feat(colleague-agent): web 进程的 agent 编排层，失败一律退化到 ACK"
```

---

## Task 5: web 路由 `POST /api/req/colleague-agent/turn`

**Files:**
- Modify: `src/entrypoints/web/routes-requirements.js`
- Test: `src/entrypoints/web/routes-requirements.test.js`

> **不需要动 `server.js`。** 它的 ROUTES 表里是一条 **prefix 匹配**：
> `{ prefix: '/api/req/', h: (req, res, url) => handleRequirementRoutes(req, res, url) }`（`server.js:168`）。
> 所有 `/api/req/*` 自动进 `handleRequirementRoutes`，新端点只要加进那个函数内部的分发即可。
>
> 同样不需要补 import：`withJsonBody` / `sendJson` / `str` / `getPluginEnabled` / `logger`
> 在 `routes-requirements.js` 里**已经全部 import 过了**，只需新增 `handleColleagueTurn` 一个。

- [ ] **Step 1: 先读既有的跨进程触发端点**

读 `src/entrypoints/web/routes-requirements.js:298-330` 的 `handleColleagueAuto`（四期的那条，Task 8 会删）。它示范了这类端点的四个要点，新端点照搬：

1. **202 立即返回**，真正的活儿 fire-and-forget（对面是 3s 超时的 fire-and-forget POST）
2. 入参校验失败回 4xx 且**不启动任何后台工作**
3. 插件启停在**路由层**认（`getPluginEnabled`）
4. 不 await 业务函数，但要 `.catch` 兜住

- [ ] **Step 2: 写失败的测试**

在 `src/entrypoints/web/routes-requirements.test.js` 追加：

```js
// ---- POST /api/req/colleague-agent/turn（P3：飞书进程跨进程触发 agent）----

test('colleague-agent/turn：合法入参 → 202，且异步起了一轮', async () => {
  let called = null;
  const res = mockRes();
  await handleColleagueAgentTurn(
    mockReq({ colleagueId: 'cl_1', text: '接口给你了', msgId: 'cm_1' }),
    res,
    { handleTurn: async (i) => (called = i), isEnabled: () => true },
  );
  assert.equal(res.statusCode, 202);
  await new Promise((r) => setImmediate(r)); // fire-and-forget，让微任务跑完
  assert.equal(called.colleagueId, 'cl_1');
  assert.equal(called.text, '接口给你了');
});

test('colleague-agent/turn：缺 colleagueId → 400，且绝不起 agent', async () => {
  let ran = false;
  const res = mockRes();
  await handleColleagueAgentTurn(mockReq({ text: 'x' }), res, {
    handleTurn: async () => (ran = true),
    isEnabled: () => true,
  });
  assert.equal(res.statusCode, 400);
  await new Promise((r) => setImmediate(r));
  assert.equal(ran, false);
});

test('colleague-agent/turn：text 与 files 同时为空 → 400（没内容可聊）', async () => {
  const res = mockRes();
  await handleColleagueAgentTurn(mockReq({ colleagueId: 'cl_1', text: '   ' }), res, {
    handleTurn: async () => {},
    isEnabled: () => true,
  });
  assert.equal(res.statusCode, 400);
});

test('colleague-agent/turn：只有 files 没有 text → 放行（同事直接甩个文档是常态）', async () => {
  let called = null;
  const res = mockRes();
  await handleColleagueAgentTurn(
    mockReq({ colleagueId: 'cl_1', text: '', files: [{ name: 'a.md', path: 'D:/a.md', kind: 'file' }] }),
    res,
    { handleTurn: async (i) => (called = i), isEnabled: () => true },
  );
  assert.equal(res.statusCode, 202);
  await new Promise((r) => setImmediate(r));
  assert.equal(called.files.length, 1);
});

test('colleague-agent/turn：插件停用 → 409，不起 agent', async () => {
  let ran = false;
  const res = mockRes();
  await handleColleagueAgentTurn(mockReq({ colleagueId: 'cl_1', text: 'x' }), res, {
    handleTurn: async () => (ran = true),
    isEnabled: () => false,
  });
  assert.equal(res.statusCode, 409);
  await new Promise((r) => setImmediate(r));
  assert.equal(ran, false);
});

test('colleague-agent/turn：业务层抛错不能让进程崩（fire-and-forget 必须有 catch）', async () => {
  const res = mockRes();
  await handleColleagueAgentTurn(mockReq({ colleagueId: 'cl_1', text: 'x' }), res, {
    handleTurn: async () => {
      throw new Error('boom');
    },
    isEnabled: () => true,
  });
  assert.equal(res.statusCode, 202);
  await new Promise((r) => setImmediate(r)); // 未捕获的 rejection 会让这里炸
});
```

> ⚠️ **`routes-requirements.test.js` 里没有 `mockReq` / `mockRes`** —— 那个文件用的是「真实 HTTP server + fetch 联调」范式（见其 `startServer()`）。但本 Task 必须注入 `deps` 才能避免真起 agent 烧额度，走不了 HTTP 联调那条路，所以要**自己加这两个 helper**。
>
> 加在测试文件顶部，照抄下面这段（契约来自 `http-util.js#sendJson` 与 `body.js#withJsonBody`）：
>
> ```js
> import { Readable } from 'node:stream';
>
> /**
>  * 最小 res 替身。四个成员缺一不可：
>  * - writeHead / end：sendJson 用
>  * - setHeader：withJsonBody 在 413 路径上会调
>  * - headersSent：withJsonBody 的 catch 分支靠它判断能不能再写响应头
>  */
> function mockRes() {
>   return {
>     statusCode: 0,
>     body: '',
>     headersSent: false,
>     writeHead(code) {
>       this.statusCode = code;
>       this.headersSent = true;
>     },
>     end(chunk) {
>       this.body = chunk || '';
>     },
>     setHeader() {},
>   };
> }
>
> /**
>  * 最小 req 替身。**必须喂 Buffer 而不是字符串** —— readJsonBody 里
>  * `size += c.length`（字符串算字符数，中文会少算）且 `Buffer.concat(chunks)`
>  * 拿到字符串数组直接抛。这是本项目踩过的「中文 body 被静默截断」同款坑。
>  */
> function mockReq(body) {
>   const req = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]);
>   req.method = 'POST';
>   req.url = '/api/req/colleague-agent/turn';
>   req.headers = {};
>   return req;
> }
> ```

- [ ] **Step 3: 跑到失败**

Run: `node --test src/entrypoints/web/routes-requirements.test.js`
Expected: FAIL — `handleColleagueAgentTurn is not defined`

- [ ] **Step 4: 实现**

在 `src/entrypoints/web/routes-requirements.js` 加（放在 `handleColleagueAuto` 附近，Task 8 会把后者删掉）：

```js
import { handleColleagueTurn } from '../../plugins/colleague-agent/session.js';

// ==== POST /api/req/colleague-agent/turn {colleagueId, text, msgId?, files?} ====
// 飞书进程在落盘入站消息后跨进程触发（P3）。agent 必须在 web 进程跑：
// 写工具要调本进程内存里的需求泵与 busy 状态机（见 colleague-agent/session.js 文件头）。
//
// 202 立即返回：对面是 3s 超时的 fire-and-forget，一轮 agent 要十几秒，同步等必然超时，
// 而超时重发会在「入队到收尾」的窗口里制造重复任务（四期 auto-notify 踩过同款坑）。
export async function handleColleagueAgentTurn(req, res, deps = {}) {
  const { handleTurn = handleColleagueTurn, isEnabled = getPluginEnabled } = deps;
  return withJsonBody(req, res, async (data) => {
    if (!isEnabled('colleague-agent')) {
      return sendJson(res, 409, { error: '同事对话 Agent 插件已停用' });
    }
    const colleagueId = str(data?.colleagueId);
    if (!colleagueId) return sendJson(res, 400, { error: '缺少 colleagueId' });
    const text = str(data?.text);
    const files = Array.isArray(data?.files) ? data.files : [];
    // 纯空白且无附件 = 没内容可聊，起 agent 纯属烧额度
    if (!text.trim() && !files.length) return sendJson(res, 400, { error: '缺少 text 或 files' });

    // 先回 202 再干活：顺序反了的话对面已经超时断开，这个响应发给了空气
    sendJson(res, 202, { ok: true });
    // fire-and-forget 必须带 catch：未捕获的 rejection 在 Node 里会让进程退出
    handleTurn({ colleagueId, text, msgId: str(data?.msgId) || null, files }).catch((e) =>
      logger.warn('routes-req', 'colleague agent 一轮异常（已捕获）', {
        colleagueId,
        err: e?.message || String(e),
      }),
    );
  });
}
```

在同文件末尾的 `handleRequirementRoutes` 分发里加一行（紧挨着既有的 colleague-messages 那几条）：

```js
  if (pathname === '/api/req/colleague-agent/turn' && method === 'POST') return handleColleagueAgentTurn(req, res);
```

- [ ] **Step 5: 跑到通过**

Run: `node --test src/entrypoints/web/routes-requirements.test.js`
Expected: PASS

Run: `npm test`
Expected: 全绿

- [ ] **Step 6: 提交**

```bash
git add src/entrypoints/web/routes-requirements.js src/entrypoints/web/routes-requirements.test.js
git commit -m "feat(web): POST /api/req/colleague-agent/turn 跨进程触发 agent 一轮"
```

---

## Task 6: 入站共用层 `relay.js` + dispatch feature

**Files:**
- Create: `src/plugins/colleague-agent/relay.js`
- Create: `src/plugins/colleague-agent/relay.test.js`
- Create: `src/plugins/colleague-agent/feature.js`
- Create: `src/plugins/colleague-agent/feature.test.js`
- Modify: `src/plugins/colleague-agent/index.js`

**为什么要单独一个 `relay.js`**：文本走 dispatch feature，附件在 `feishu/index.js` 的早期分支（到不了 dispatch）。两条链路必须共用判定与落盘，否则会漂移成「文字归对了、附件归错了」—— 这是 relay 时代已经踩过并写进注释的教训（`feishu/index.js:81`）。

- [ ] **Step 1: 写 relay.js 的失败测试**

```js
/**
 * 入站共用层单测：名册判定 → 落盘 → 跨进程触发。
 * 文本与附件两条链路共用它，所以这里钉死的是「什么人的消息会被接管」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relayToAgent, isColleagueMessage } from './relay.js';

const colleagues = [
  { id: 'cl_1', name: '张三', role: 'backend', feishuOpenId: 'ou_1' },
  { id: 'cl_2', name: '李四', role: 'frontend', feishuOpenId: '' },
];

function deps(over = {}) {
  const appended = [];
  const posted = [];
  return {
    appended,
    posted,
    d: {
      getColleagues: () => colleagues,
      appendTo: (cid, e) => (appended.push({ cid, e }), { ...e, id: 'cm_new' }),
      postToWeb: async (body) => posted.push(body),
      ...over,
    },
  };
}

test('名册内同事：落盘入站消息 + 跨进程触发，返回 true（调用方应 return）', async () => {
  const { d, appended, posted } = deps();
  const r = await relayToAgent({ openId: 'ou_1', text: '接口给你了' }, d);
  assert.equal(r, true);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].cid, 'cl_1');
  assert.equal(appended[0].e.dir, 'in');
  assert.equal(appended[0].e.role, 'backend', '职位是发信当时的快照');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].colleagueId, 'cl_1');
  assert.equal(posted[0].msgId, 'cm_new', 'msgId 必须带上，工具靠它知道这轮在处理哪条');
});

test('不在名册：返回 false，不落盘不触发（交回 feedback 等后续 feature）', async () => {
  const { d, appended, posted } = deps();
  assert.equal(await relayToAgent({ openId: 'ou_stranger', text: 'x' }, d), false);
  assert.equal(appended.length, 0);
  assert.equal(posted.length, 0);
});

test('附件：files 一并落盘并透传给 web', async () => {
  const { d, appended, posted } = deps();
  const files = [{ name: 'order.md', path: 'D:/order.md', kind: 'file' }];
  await relayToAgent({ openId: 'ou_1', text: '', files }, d);
  assert.equal(appended[0].e.files.length, 1);
  assert.equal(posted[0].files[0].name, 'order.md');
});

test('跨进程 POST 失败不影响接管结论 —— 消息已落盘，主机在 web 端看得到', async () => {
  const { d, appended } = deps({ postToWeb: async () => { throw new Error('web 没起来'); } });
  const r = await relayToAgent({ openId: 'ou_1', text: 'x' }, d);
  assert.equal(r, true, 'POST 失败不能让消息退回材料池，那会导致同一条消息被两套逻辑处理');
  assert.equal(appended.length, 1);
});

test('2.0 不再看「有没有开发期需求」—— 名册内就接管，归属由 agent 逐条判', async () => {
  // 1.0 的 resolveTargets 要求同事至少在一个 dev 需求里，否则 PASS 回 feedback。
  // 换锚点后对话锚在人身上，没有需求也能聊（agent 会问清楚或如实说不知道）。
  const { d, posted } = deps();
  await relayToAgent({ openId: 'ou_1', text: '在忙啥' }, d);
  assert.equal(posted.length, 1);
});

test('isColleagueMessage：纯判定不产生副作用（附件链路要先判再决定走哪条）', () => {
  assert.equal(isColleagueMessage('ou_1', colleagues)?.id, 'cl_1');
  assert.equal(isColleagueMessage('ou_stranger', colleagues), null);
  assert.equal(isColleagueMessage('', colleagues), null);
});
```

- [ ] **Step 2: 跑到失败**

Run: `node --test src/plugins/colleague-agent/relay.test.js`
Expected: FAIL — `Cannot find module './relay.js'`

- [ ] **Step 3: 实现 relay.js**

```js
/**
 * 同事入站消息的共用层：名册判定 → 落盘 → 跨进程触发 web 跑 agent。
 *
 * **文本与附件两条链路必须共用本文件。** 文本走 dispatch feature，附件在
 * `entrypoints/feishu/index.js` 的 image/file 早期分支就被接走（到不了 dispatch）。
 * 各写一份判定的后果是「文字归对了需求、附件归错了」—— relay 时代已经踩过。
 *
 * 与 1.0 `colleague-relay/logic.js#resolveTargets` 的关键差别：**不再要求同事至少在
 * 一个开发期需求里**。换锚点后对话锚在人身上，没有需求也能聊（agent 会问清楚，
 * 或如实说不知道）；旧判定会让「同事随口问一句」掉回 feedback 被当成新需求收走。
 */
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';
import { getColleagues as realGetColleagues } from '../../store/colleagues.js';
import { appendTo as realAppendTo } from '../../store/colleague-messages.js';

/** 纯判定：这个 open_id 是名册里的同事吗。附件链路要先判再决定走哪条分支 */
export function isColleagueMessage(openId, colleagues) {
  if (!openId) return null;
  return (colleagues || []).find((c) => c.feishuOpenId === openId) || null;
}

/** 跨进程超时。与 create-session / bug-patrol / auto-notify 等既有范式同值 */
const TIMEOUT_MS = 3000;

/**
 * 跨进程直送 web 跑一轮 agent。
 *
 * fire-and-forget + 3s 超时 + **不重试**：重试会在「入队到收尾」的窗口里制造同 msgId
 * 的重复任务（四期 `colleague-relay/auto-notify.js` 踩过，原样沿用它的结论）。
 *
 * **必须看响应状态码**：web 侧在插件停用时回 409、参数不合法时回 400，不看的话这些
 * 失败在飞书侧完全静默，日志里一个字都没有。分级同 `auto-notify.js`：
 * 4xx 是「按规则不该处理」记 info，其余才 warn。
 */
async function realPostToWeb(body) {
  const url = `http://127.0.0.1:${config.web.port}/api/req/colleague-agent/turn`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // AbortSignal.timeout 比手写 AbortController + setTimeout + clearTimeout 少三行、
      // 也不会忘记清定时器。本仓 auto-notify.js 用的就是它。
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (r.status === 202) return true;
    const data = await r.json().catch(() => ({}));
    const level = r.status === 400 || r.status === 409 ? 'info' : 'warn';
    logger[level]('colleague-agent', 'web 未受理本轮', {
      colleagueId: body.colleagueId,
      status: r.status,
      error: data.error,
    });
    return false;
  } catch (e) {
    logger.warn('colleague-agent', '跨进程触发失败（消息已落盘，不重试）', {
      colleagueId: body.colleagueId,
      err: e?.message || String(e),
    });
    return false;
  }
}

/**
 * 接管一条同事消息。
 *
 * @param {{openId:string, text?:string, files?:Array}} m
 * @param {object} [deps] 注入便于单测
 * @returns {Promise<boolean>} true = 已接管（调用方应 return，别再往下走）
 */
export async function relayToAgent(m, deps = {}) {
  const {
    getColleagues = realGetColleagues,
    appendTo = realAppendTo,
    postToWeb = realPostToWeb,
  } = deps;

  const colleague = isColleagueMessage(m?.openId, getColleagues());
  if (!colleague) {
    // 留痕：排查「同事发的消息怎么被当成新需求收了」时，这行是唯一线索
    logger.info('colleague-agent', '不接管，交回后续 feature', { openId: m?.openId, reason: '不在同事名册' });
    return false;
  }

  const saved = appendTo(colleague.id, {
    dir: 'in',
    text: m.text || '',
    role: colleague.role, // 发信当时的职位快照
    files: Array.isArray(m.files) ? m.files : [],
    reqId: null, // 归属由 agent 判，入站时不猜
  });

  // 这里的 try/catch 不是为了 realPostToWeb —— 它自己已经把网络错误与非 202 响应
  // 都吞掉并记了日志、只返回 boolean。留着是为了兜住**注入的桩**抛出的异常（单测有一条
  // 专门让桩 throw），以及将来万一有人把 postToWeb 换成会抛的实现。
  try {
    await postToWeb({
      colleagueId: colleague.id,
      text: m.text || '',
      msgId: saved?.id || null,
      files: Array.isArray(m.files) ? m.files : [],
    });
  } catch (e) {
    logger.warn('colleague-agent', '跨进程触发异常（消息已落盘，不重试）', {
      colleagueId: colleague.id,
      err: e?.message || String(e),
    });
  }
  // **无论 POST 成没成功都返回 true**：消息已经落盘，主机在 web 端看得到原文。
  // 退回 false 会让同一条消息接着被 feedback 当成新需求收走 —— 一条消息两套处理更糟。
  return true;
}
```

- [ ] **Step 4: 跑到通过**

Run: `node --test src/plugins/colleague-agent/relay.test.js`
Expected: PASS（6 项）

- [ ] **Step 5: 写 feature.js 的失败测试**

```js
/**
 * dispatch feature 单测。它只做一件事：名册内的同事消息交给 relay，否则 PASS 回落。
 * 群聊 @ 过滤不在这里 —— 那是 feishu 入口的事（feature 收到的已经是过滤后的）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import feature from './feature.js';
import { PASS } from '../../app/signals.js';

test('feature 契约：order 由插件装配给，这里只暴露 name/permission/intents/handle', () => {
  assert.equal(feature.name, 'colleague-agent');
  assert.equal(feature.permission, 'any');
  assert.deepEqual(feature.intents.sort(), ['bug', 'feature', 'material', 'other', 'question'].sort());
  assert.equal(typeof feature.handle, 'function');
  assert.equal(feature.hasPending, undefined, '选择卡已下线，不该再有待归属态');
});

test('名册内：交给 relay 接管，不回任何话（回复由 web 进程的 agent 发）', async () => {
  let got = null;
  let replied = false;
  const r = await feature.handle(
    { user: { id: 'ou_1' }, text: '接口给你了', reply: async () => (replied = true) },
    null,
    { relay: async (m) => ((got = m), true) },
  );
  assert.notEqual(r, PASS);
  assert.equal(got.openId, 'ou_1');
  assert.equal(got.text, '接口给你了');
  assert.equal(replied, false, 'ACK 由 web 侧按需发（正常路径不发，等 agent 真回复）');
});

test('不在名册：返回 PASS，把消息交回 feedback', async () => {
  const r = await feature.handle({ user: { id: 'ou_x' }, text: 'x' }, null, { relay: async () => false });
  assert.equal(r, PASS);
});

test('relay 抛错：吞掉并 PASS —— 绝不能让同事的消息因为一次异常彻底消失', async () => {
  const r = await feature.handle({ user: { id: 'ou_1' }, text: 'x' }, null, {
    relay: async () => {
      throw new Error('boom');
    },
  });
  assert.equal(r, PASS);
});
```

- [ ] **Step 6: 实现 feature.js**

```js
/**
 * 同事对话 agent 的 dispatch feature（order 35，取代 colleague-relay）。
 *
 * order 35 的理由沿用 1.0：在 action-runner(30) 之后、feedback(40) 之前 ——
 * 同事说「帮我退款」仍该触发动作脚本，说「接口文档给你」才归 agent 对话。
 *
 * 本 feature **只覆盖文本**。附件在 `entrypoints/feishu/index.js` 的 image/file 分支
 * 就被接走，到不了 dispatch，那条链路直接调 `relay.js`（两边共用同一个判定）。
 */
import { PASS } from '../../app/signals.js';
import { logger } from '../../shared/logger.js';
import { relayToAgent } from './relay.js';

export async function handle(ctx, _intentResult, deps = {}) {
  const { relay = relayToAgent } = deps;
  try {
    const taken = await relay({ openId: ctx?.user?.id, text: ctx?.text || '' });
    // 接管了就什么都不回：回复由 web 进程跑完 agent 后经 lark 直发。
    // 这里再回一句 ACK 的话，同事会先收到「已收到」再收到真回复，像两个机器人。
    return taken ? undefined : PASS;
  } catch (e) {
    // 异常一律 PASS 回落：让 feedback 把它当成普通反馈收走，
    // 总好过同事的消息因为一次异常彻底消失
    logger.warn('colleague-agent', 'feature 异常，交回后续 feature', { err: e?.message || String(e) });
    return PASS;
  }
}

export default {
  name: 'colleague-agent',
  permission: 'any',
  intents: ['bug', 'feature', 'question', 'material', 'other'],
  handle,
};
```

- [ ] **Step 7: 插件挂上 feature**

改 `src/plugins/colleague-agent/index.js` 末尾：

```js
import feature from './feature.js';

// …（工具注册那段不动）…

// order 35：在 action-runner(30) 之后、feedback(40) 之前。
// 注意：feature 只在**走 dispatch 的进程**（feishu/console）生效；web 进程加载本文件
// 是为了工具自注册（server.js 的 loadPluginSideEffects），那里 features 不被消费。
export default { id: 'colleague-agent', features: [{ order: 35, feature }] };
```

- [ ] **Step 8: 跑到通过**

- [ ] **Step 7.5: 从 PLUGIN_MANIFEST 摘掉 `colleague-relay`（让 agent 真正接管）**

**不做这一步的话，本 Task 交付的 feature 是死的。** 两个 feature 同为 order 35，而 `assembleFeatures` 用的是**稳定排序**，`PLUGIN_MANIFEST` 里 `colleague-relay` 排在 `colleague-agent` 前面 —— 于是 dispatch 永远先遍历到 relay，它接管了名册内同事的消息，agent 的 feature 一次都轮不到。单测会照样绿（测的是 `handle` 函数本身），但功能不通。

改 `src/plugins/index.js`，删掉 `PLUGIN_MANIFEST` 里整个 `colleague-relay` 条目（5 行）：

```js
//  {
//    id: 'colleague-relay',
//    description: '同事消息中继：开发期需求的指派同事发来的消息归入该需求对话流，供 web 端查看与回复',
//    load: () => import('./colleague-relay/index.js'),
//  },
```

**只摘 MANIFEST 条目，不删文件** —— 文件留到 Task 8 一起删（那时连同 `colleague-auto` 一起清）。

摘掉之后的中间态（可接受，Task 7 收口）：
- **文字链路**：agent 接管 ✓
- **附件链路**：仍走 `feishu/index.js` 的 `relayColleagueAttachment` → `notifyAutoHandle` → 四期自动处理（Task 7 才改写）

两条链路暂时不一致，但都能工作，不会丢消息。

Run: `grep -n "colleague-relay" src/plugins/index.js`
Expected: 无输出

- [ ] **Step 8: 跑到通过**

Run: `node --test src/plugins/colleague-agent/feature.test.js src/plugins/colleague-agent/relay.test.js src/plugins/index.test.js`
Expected: PASS

Run: `npm test`
Expected: 全绿。`colleague-relay/*.test.js` 仍然会跑且应该照常通过 —— 它们直接 import `feature.js`/`logic.js` 测函数，不经过 `PLUGIN_MANIFEST`，摘条目不影响它们。

- [ ] **Step 9: 提交**

```bash
git add src/plugins/colleague-agent/
git commit -m "feat(colleague-agent): 入站共用层 + dispatch feature（order 35）"
```

---

## Task 7: 飞书入口合并（文本 + 附件一条链路）

**Files:**
- Modify: `src/entrypoints/feishu/index.js`

- [ ] **Step 1: 读现状**

读 `src/entrypoints/feishu/index.js:86-124` 的 `relayColleagueAttachment` 与它的两个调用点（`:150` 图片、`:191` 文件）。

- [ ] **Step 2: 替换实现**

把 `relayColleagueAttachment` 整个函数替换成：

```js
/**
 * 同事发来的附件（图片 / 文件）→ 交给 agent。
 *
 * 为什么不放在 dispatch 的 feature 里：附件消息在 onInbound 早期就被 image/file 两个分支
 * 接走并 `return`，**根本到不了 dispatch**。只做 feature 的话，同事发的文字能收到、
 * 发的接口文档永远收不到 —— 而后者正是最重要的输入。
 *
 * 判定与落盘共用 `colleague-agent/relay.js`，与文本链路同一份规则。
 *
 * @returns {Promise<boolean>} true = 已接管（调用方应 return），false = 不是同事的附件，走原有材料池
 */
async function relayColleagueAttachment(m, say, file, kind) {
  return relayToAgent({
    openId: m.userId,
    text: m.text || '',
    files: [{ name: file.name || '', path: file.path || '', kind }],
  });
}
```

改文件顶部的 import。**这 5 行全部删掉**（2026-09-28 核实：`getColleagues` / `getRequirements` 在本文件里只有 `relayColleagueAttachment` 这一处用途，函数改写后就没人用了）：

```js
// 删除这 5 行：
//   import { getColleagues } from '../../store/colleagues.js';
//   import { getRequirements } from '../../store/requirements.js';
//   import { appendMessage } from '../../store/colleague-messages.js';
//   import { resolveTargets, ACK_TEXT } from '../../plugins/colleague-relay/logic.js';
//   import { notifyAutoHandle } from '../../plugins/colleague-relay/auto-notify.js';

// 换成这一行：
import { relayToAgent } from '../../plugins/colleague-agent/relay.js';
```

**删干净这 5 行是 Task 8 的前提** —— 只要 `feishu/index.js` 还 import 着 `colleague-relay/` 里的任何东西，Task 8 就删不掉那个目录。

### `say` 参数怎么办

新实现不再自己回 ACK（agent 跑完后经 lark 直接回复同事，见 `colleague-agent/session.js`），所以 `say` 参数没有用了。**把它从签名里删掉，并同步改两个调用点**（`m.images[0]` 与 `m.files[0]` 两个分支）：

```js
// 调用点从 relayColleagueAttachment(m, say, {...}, 'image')
// 改成         relayColleagueAttachment(m, {...}, 'image')
```

留一个不用的参数会被 lint 挑出来，而且会让读代码的人以为这里还会回话。

> **行为变化（有意）**：同事发完附件后不再立刻收到「已收到」，而是等 agent 真正处理完（~10s）直接给实质回复。这与文字链路一致 —— 正常路径不回 ACK，只有限流/失败才回（见 `session.js` 的三句话术）。

Run: `node --check src/entrypoints/feishu/index.js`
Expected: 无输出（语法通过）

Run: `grep -nE "resolveTargets|buildPickCard|notifyAutoHandle|addPending|getPending|colleague-relay" src/entrypoints/feishu/index.js`
Expected: **无输出** —— 这条是 Task 8 的放行条件

> ⚠️ `node --check` 只验语法，**验不出 ESM 缺失导出**（那是加载期错误）。而本文件**没有任何 `.test.js` 会加载它**，所以 `npm test` 全绿也不代表它没坏。
> **但也不要真 `import()` 它** —— 一加载就建飞书长连接，命令会被永久挂住。
> 正确的验证方式：`grep` 提取本文件所有 `import {...}` 语句，与各目标模块的 `export` 列表做**静态比对**。

- [ ] **Step 3: 跑全量**

Run: `npm test`
Expected: 全绿

- [ ] **Step 4: 提交**

```bash
git add src/entrypoints/feishu/index.js
git commit -m "refactor(feishu): 附件链路改走 colleague-agent/relay，与文本同一份判定"
```

---

## Task 8: 下线 colleague-relay 与 colleague-auto

**Files:**
- Modify: `src/entrypoints/web/colleague-dev.js`（先搬走两个函数）
- Create: `src/entrypoints/web/colleague-dev.logic.js`
- Delete: `src/plugins/colleague-relay/`（整个目录）
- Delete: `src/entrypoints/web/colleague-auto.js` / `.test.js` / `.logic.js` / `.logic.test.js`
- Modify: `src/plugins/index.js`、`src/entrypoints/web/routes-requirements.js`、`src/store/colleague-messages.js`

**顺序不能换**：先搬函数（Step 1-3），再删文件（Step 4），最后清兼容层（Step 6）。反过来会让中间状态连 `node --check` 都过不了。

- [ ] **Step 1: 把 `newSubConvId` / `buildBrief` 搬出待删文件**

`src/entrypoints/web/colleague-dev.js:35` import 了 `colleague-auto.logic.js` 的这两个函数，而 `colleague-dev.js` 是 **P2 在跑的模块**（`start_dev_task` 的执行端），不能删。

先看它们的原文：

Run: `grep -n "export function newSubConvId" -A 12 src/entrypoints/web/colleague-auto.logic.js`
Run: `grep -n "export function buildBrief" -A 20 src/entrypoints/web/colleague-auto.logic.js`

> ⚠️ **`buildBrief` 不是零依赖，光搬它会断**（2026-09-28 核实）。它用到同文件里的两个东西：
>
> ```
> colleague-auto.logic.js:31  export const BRIEF_MAX_CHARS = 200;
> colleague-auto.logic.js:37  function clipChars(s, n) { ... }   ← 私有，未导出
> ```
>
> **这两个必须一起搬过去**（`clipChars` 保持不导出即可）。
>
> `newSubConvId` 则是真零依赖（只用 `Date.now()` 与 `Math.random()`），直接搬。
>
> 搬完务必 `grep -n "clipChars\|BRIEF_MAX_CHARS" src/entrypoints/web/colleague-dev.logic.js` 确认两者都在，
> 否则 `npm test` 会在删掉 `colleague-auto.logic.js` 那一步才炸，而那时你已经删了一堆文件、不好定位。
>
> 注意 `SUMMARY_MAX_CHARS`（:34）**不用搬** —— 它只被 `buildSummaryAndPrompt` 用，那个函数跟着 `colleague-auto.logic.js` 一起删。

把这两个函数**原样**（含注释）复制到新文件 `src/entrypoints/web/colleague-dev.logic.js`，文件头写：

```js
/**
 * `colleague-dev.js` 的纯函数层。
 *
 * 这两个函数原本住在 `colleague-auto.logic.js`（四期分类器管线）。P3 下线四期时，
 * 它们是唯一被 `colleague-dev.js` 依赖、因而不能一起删的部分 —— 搬到这里跟着它真正的
 * 消费方走，而不是留在一个已经没有别的用途的文件里。
 */
```

- [ ] **Step 2: 改 import 并建配套测试**

改 `src/entrypoints/web/colleague-dev.js:35`：

```js
// 改前：import { newSubConvId, buildBrief } from './colleague-auto.logic.js';
import { newSubConvId, buildBrief } from './colleague-dev.logic.js';
```

把 `colleague-auto.logic.test.js` 里**只测这两个函数**的用例搬到新建的 `src/entrypoints/web/colleague-dev.logic.test.js`（其余用例随文件删除）。

Run: `node --test src/entrypoints/web/colleague-dev.logic.test.js src/entrypoints/web/colleague-dev.test.js`
Expected: PASS

- [ ] **Step 3: 提交这一步（搬家独立成一个提交，便于事后回溯）**

```bash
git add src/entrypoints/web/colleague-dev.js src/entrypoints/web/colleague-dev.logic.js src/entrypoints/web/colleague-dev.logic.test.js
git commit -m "refactor(web): newSubConvId/buildBrief 搬到 colleague-dev.logic.js"
```

- [ ] **Step 4: 删除旧管线**

```bash
git rm -r src/plugins/colleague-relay/
git rm src/entrypoints/web/colleague-auto.js src/entrypoints/web/colleague-auto.test.js
git rm src/entrypoints/web/colleague-auto.logic.js src/entrypoints/web/colleague-auto.logic.test.js
```

`PLUGIN_MANIFEST` 里的 `colleague-relay` 条目**已在 Task 6 Step 7.5 摘掉**（为了让 agent 真正接管），这里只需确认：

Run: `grep -n "colleague-relay" src/plugins/index.js`
Expected: 无输出

改 `src/entrypoints/web/routes-requirements.js`（2026-09-28 扫描确认，共 5 处）：
- `:18` 删 `import { autoHandleMessages } from './colleague-auto.js';`
- `:306` 删整个 `handleColleagueAuto` 函数（含 `:315` 那句 `getPluginEnabled('colleague-relay')`）
- `:1007` 删分发表里 `/api/req/colleague-messages/auto` 那一行
- `:299-303` 的相关注释一并删

**⚠️ 同时必须删测试：`routes-requirements.test.js` 第 1243–1313 行整段**（`---- POST /api/req/colleague-messages/auto（四期触发口）----` 之下约 10 条用例）。它们测的端点没了，不删的话 `npm test` 必红。其中最后一条还调 `setPluginEnabled('colleague-relay', false)` —— 那个插件 id 在 Task 6 已从 MANIFEST 摘除，留着也没有意义。

删之前先 `grep -n "colleague-messages/auto" src/entrypoints/web/routes-requirements.test.js` 确认边界，别误删相邻的 `/send`、`/read` 用例。

改 `src/entrypoints/web/server.js`：确认 ROUTES 表里没有指向已删 handler 的行（该端点走的是 `handleRequirementRoutes` 内部分发，通常无需改；`grep` 确认）。

Run: `grep -rn "colleague-relay\|colleague-auto\|autoHandleMessages\|colleague-messages/auto" --include=*.js src/`

Expected: **只剩注释，无代码引用**。删干净之后仍会命中这几处**历史说明性注释**，它们指向的东西已经不存在了，请一并更新措辞（改成陈述历史而非指向现存模块）：

```
src/app/dispatch.js:99                      讲 PASS 回落机制时拿 colleague-relay 举例
src/plugins/colleague-agent/feature.js:2    「取代 colleague-relay」
src/plugins/colleague-agent/index.js:5      同上
src/plugins/colleague-agent/relay.js:8,30   「与 1.0 colleague-relay/logic.js 的差别」「auto-notify.js 踩过的坑」
src/store/colleague-messages.js:163         「这四个函数的调用方散在 colleague-relay / feishu 入口 / web 路由里」
                                            ← 这条在 Step 6 收掉旧签名后整段都该重写
src/plugins/colleague-agent/index.test.js:12 用例标题里提到「取代 colleague-relay」
```

`relay.js` 那两处保留人话即可（「上一代的分类器管线」），它们记录的是**为什么这么设计**，有价值；`dispatch.js:99` 要换一个仍然存在的 feature 举例，否则读的人会去找一个不存在的模块。

- [ ] **Step 5: 跑到通过**

Run: `npm test`
Expected: 全绿

- [ ] **Step 6: 收掉 Task 2 保留的旧签名函数**

Task 2 刻意没动这四个函数的签名（`getThread` / `appendMessage` / `markRead` / `markHandled` 仍是 `(reqId, colleagueId, …)`），让它们内部适配新结构继续服务旧调用方 —— 目的就是避免「Task 2 批量改一遍、Task 8 再改回来」。

现在旧调用方已经删干净了，把仅剩的调用点切到新函数，然后删掉这四个旧签名函数。

Run: `grep -rn "getThread(\|appendMessage(\|markRead(\|markHandled(" --include=*.js src/ | grep -v "\.test\.js" | grep -v "store/colleague-messages.js"`

对照结果逐个切换：

| 旧 | 新 |
|---|---|
| `getThread(reqId, colleagueId)` | `getColleagueThread(colleagueId)` + 按 `reqId` 过滤（若调用方确实只要该需求的） |
| `appendMessage(reqId, colleagueId, entry)` | `appendTo(colleagueId, { ...entry, reqId })` |
| `markRead(reqId, colleagueId)` | `markColleagueRead(colleagueId, { reqId })` |
| `markHandled(reqId, colleagueId, msgId, o)` | `markHandled(colleagueId, msgId, o)`（顺手把签名收窄成不带 reqId） |

切完删掉 `colleague-messages.js` 里的四个旧签名函数，并同步删掉 `colleague-messages.test.js` 里针对旧签名的用例。

Run: `npm test`
Expected: 全绿

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "feat!: 下线 colleague-relay 与四期自动处理，同事对话全量切到 agent"
```

---

## Task 9: 前端与 API 语义验证

**Files:**
- Verify: `public/js/colleague-chat.js`
- Modify（若需要）: `src/entrypoints/web/routes-requirements.js`

三个对外端点的**语义必须保持不变**（web 端「需求 → 开发人员 → 会话面板」的 UI 要保住）：

| 端点 | 旧语义 | 新实现 |
|---|---|---|
| `GET /api/req/colleague-messages?reqId&colleagueId` | 该需求下该同事的消息 | 取该人整条线，**按 `reqId` 标签过滤**后返回 |
| `POST /api/req/colleague-messages/read` | 标已读 | `markColleagueRead(colleagueId, {reqId})` |
| `POST /api/req/colleague-messages/send` | 主机回复 | `appendTo(colleagueId, {dir:'out', reqId})` |

- [ ] **Step 1: 读前端怎么用这三个端点**

Run: `grep -n "colleague-messages" -B 3 -A 10 public/js/colleague-chat.js`

确认它依赖的响应字段。若响应形状不变，前端**零改动**。

- [ ] **Step 2: 改三个 handler 适配新 store 签名**

`handleColleagueMessages`（GET）的关键改动 —— **必须按 reqId 过滤**，否则主机在需求 A 的面板里会看到该同事在需求 B 说的话：

```js
// 旧：const t = getThread(reqId, colleagueId);   ← Task 2 保留的旧签名，此处换成按人读
const all = getColleagueThread(colleagueId);
const messages = all.messages.filter((m) => m.reqId === reqId);
// lastInboundAt 也要按过滤后的算，否则面板上的「最近来信」是别的需求的时间
const lastInboundAt = messages.filter((m) => m.dir === 'in').at(-1)?.at || null;
return sendJson(res, 200, { messages, lastInboundAt });
```

- [ ] **Step 3: 写回归测试**

在 `src/entrypoints/web/routes-requirements.test.js` 追加（`mockRes` 用 Task 5 加进该文件的那个；`handleColleagueMessages` 的签名是 `(url, res)`，不需要 `mockReq`）：

```js
test('GET colleague-messages：按 reqId 过滤 —— 主机在需求 A 的面板不该看到需求 B 的对话', async () => {
  appendTo('cl_1', { dir: 'in', text: '属于A', reqId: 'r_a', at: '2026-09-01T00:00:00Z' });
  appendTo('cl_1', { dir: 'in', text: '属于B', reqId: 'r_b', at: '2026-09-09T00:00:00Z' });
  const res = mockRes();
  await handleColleagueMessages(new URL('http://x/api/req/colleague-messages?reqId=r_a&colleagueId=cl_1'), res);
  const body = JSON.parse(res.body);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].text, '属于A');
  // lastInboundAt 必须按**过滤后**的消息算。按整条线算的话，需求 A 的面板上
  // 「最近来信」会显示需求 B 那条的时间（09-09），而那条消息本身根本不在这个列表里 ——
  // 看起来就像「有新消息但我找不到」。Task 8 把这段从 store 挪进了路由层 inline 计算，
  // 挪的时候最容易只搬过滤、漏掉这一步。
  assert.equal(body.lastInboundAt, '2026-09-01T00:00:00Z', 'lastInboundAt 不能带进别的需求的时间');
});

test('GET colleague-messages：无归属标签的消息不出现在任何需求面板里', async () => {
  appendTo('cl_2', { dir: 'in', text: '没归属' });
  const res = mockRes();
  await handleColleagueMessages(new URL('http://x/api/req/colleague-messages?reqId=r_a&colleagueId=cl_2'), res);
  assert.equal(JSON.parse(res.body).messages.length, 0);
});
```

- [ ] **Step 4: 跑到通过 + 手动验证前端**

Run: `npm test`
Expected: 全绿

Run: `npm start`，浏览器打开需求详情 → 开发人员 → 会话面板，确认历史消息仍在、未读红点正常。

- [ ] **Step 5: 提交**

```bash
git add src/entrypoints/web/routes-requirements.js src/entrypoints/web/routes-requirements.test.js public/js/colleague-chat.js
git commit -m "fix(web): 同事会话端点适配按人锚点，按 reqId 标签过滤"
```

---

## Task 10: per-需求 worktree 的登记与回收（补 P2 的漏）

**Files:**
- Modify: `src/store/requirements.js`
- Modify: `src/entrypoints/web/colleague-dev.js`
- Modify: `src/entrypoints/web/routes-requirements.js`
- Test: `src/store/requirements.test.js`、`src/entrypoints/web/routes-requirements.test.js`

> **这个 Task 不属于 P3 主线，是补 spec §5.3 的漏。** 写计划时做 self-review 才发现：
> `req.agentWorktrees = [{dir, worktreeDir, branch}]` 这个字段 spec 明确要求过，**P2 从没实现**。
> 而 `start_dev_task` 已经上线在跑 —— `ensureReqWorktree` 每碰一个新需求就建一个
> `<repo>.req-xxxxxxxx` 目录，需求删掉后没有任何人回收它。每个目录是一份完整工作区拷贝。

> ### ⚠️ 先读这段：`requirements.js` 的真实结构与计划初稿的假设不一样
>
> 2026-09-28 核实：
>
> - **没有统一的 normalize 函数**。只有 `normalizeProjectSlot`（建需求时用）与 `normalizeSessions`（读侧按需调用）。所有初始字段在 **`createRequirement` 里直接写死**。
> - **`getRequirement` 是裸读**：`readJson(FILE, []).find(...)`，零归一。
> - **`updateRequirement` 是 `{ ...list[i], ...patch }`**，无字段白名单（所以新字段能写进去），但也**零归一**。
>
> 所以初稿里「在 normalize 函数里加」没有落点，而且初稿的登记写法是
> `getRequirement(...)` 读出来、拼好、再 `updateRequirement(...)` 写回 —— 这是
> **read-modify-write，违反本仓纪律**（`store/CLAUDE.md`：「任何『读出来 normalize 再整份写回』
> 都必须走 `updateJson`」）。两个任务同时给同一需求派活就会互相覆盖掉对方的登记。
>
> **改用专用写入口**，参照本仓既有的 `action-configs.js#appendAutoKeyword` 范式
> （它的注释原话：「整个合并过程都在 `updateJson` 回调内完成，去重与配额在锁内重做一次 ——
> 调用方过闸时读到的是快照，在外面读改写会被另一进程覆盖」）。

- [ ] **Step 1: 写失败的测试（store 层）**

在 `src/store/requirements.test.js` 追加（注意：该文件用的是 `createRequirement`，与 `routes-requirements.test.js` 里的 `createReq` helper 是两回事）：

```js
test('agentWorktrees：新建需求默认空数组', () => {
  const r = createRequirement({ title: 'x' });
  assert.deepEqual(getRequirement(r.id).agentWorktrees, []);
});

test('addAgentWorktree：登记一条，字段齐全', () => {
  const r = createRequirement({ title: 'x' });
  addAgentWorktree(r.id, { dir: 'D:/p', worktreeDir: 'D:/p.req-r_ab', branch: 'agent/x' });
  const list = getRequirement(r.id).agentWorktrees;
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], { dir: 'D:/p', worktreeDir: 'D:/p.req-r_ab', branch: 'agent/x' });
});

test('addAgentWorktree：同一 worktreeDir 只登记一次（同需求多次派活是常态）', () => {
  const r = createRequirement({ title: 'x' });
  addAgentWorktree(r.id, { dir: 'D:/p', worktreeDir: 'D:/p.req-a', branch: 'b1' });
  addAgentWorktree(r.id, { dir: 'D:/p', worktreeDir: 'D:/p.req-a', branch: 'b2' });
  const list = getRequirement(r.id).agentWorktrees;
  assert.equal(list.length, 1, 'ensureReqWorktree 对同一需求是幂等的，登记也该是');
  assert.equal(list[0].branch, 'b1', '先登记的那条保留，不被后来的覆盖');
});

test('addAgentWorktree：缺 worktreeDir 的条目直接拒绝（那是要删的目录，缺了这条登记没意义）', () => {
  const r = createRequirement({ title: 'x' });
  addAgentWorktree(r.id, { dir: 'D:/p', branch: 'b' });
  addAgentWorktree(r.id, null);
  assert.deepEqual(getRequirement(r.id).agentWorktrees, []);
});

test('addAgentWorktree：需求不存在时安静返回 null，不写盘', () => {
  assert.equal(addAgentWorktree('r_nope', { worktreeDir: 'D:/x' }), null);
});

test('存量需求（盘上没有 agentWorktrees 字段）也能登记', () => {
  const r = createRequirement({ title: 'x' });
  // 模拟存量数据：把字段删掉再登记
  updateRequirement(r.id, { agentWorktrees: undefined });
  addAgentWorktree(r.id, { dir: 'D:/p', worktreeDir: 'D:/p.req-old', branch: 'b' });
  assert.equal(getRequirement(r.id).agentWorktrees.length, 1);
});
```

- [ ] **Step 2: 跑到失败**

Run: `node --test src/store/requirements.test.js`
Expected: FAIL — `agentWorktrees` 是 undefined

- [ ] **Step 3: 实现 store 字段**

分两处改 `src/store/requirements.js`：

**① `createRequirement` 的初始字段里加一行**（就在 `sessions: []` 附近）：

```js
    // agent 派活时建的 per-需求 worktree 登记（spec §5.3）。记它只为一件事：
    // 需求被删除时要 `git worktree remove` 掉这些目录，否则每个需求留下一份完整
    // 工作区拷贝、无人回收。写入走 addAgentWorktree（锁内去重），不要在外面读改写。
    agentWorktrees: [], // [{ dir, worktreeDir, branch }]
```

**② 新增专用写入口**（放在 `updateRequirement` 附近）：

```js
/**
 * 登记一个 agent worktree。**整个去重过程都在 `updateJson` 回调内完成** ——
 * 这是本仓 `action-configs.js#appendAutoKeyword` 立下的纪律：调用方在锁外读到的是快照，
 * 在外面读改写会被另一进程/另一个并发任务覆盖。同一需求可能同时有两个 agent 任务在派活。
 *
 * 按 `worktreeDir` 去重且**先登记的保留**：`ensureReqWorktree` 对同一需求是幂等的
 * （返回同一个目录），重复登记只会让列表越堆越长，而 dir/branch 以首次为准即可 ——
 * 回收时只用 `worktreeDir` 和 `dir`，branch 只是给人看的。
 *
 * @param {string} reqId
 * @param {{dir?:string, worktreeDir:string, branch?:string}} wt
 * @returns {object|null} 更新后的需求；需求不存在或入参非法时返回 null（不写盘）
 */
export function addAgentWorktree(reqId, wt) {
  // worktreeDir 是唯一必需字段 —— 它就是将来要删的那个目录，缺了这条登记毫无意义
  if (!reqId || !wt || typeof wt !== 'object') return null;
  const worktreeDir = typeof wt.worktreeDir === 'string' ? wt.worktreeDir : '';
  if (!worktreeDir) return null;

  let updated = null;
  updateJson(FILE, [], (list) => {
    const i = list.findIndex((r) => r.id === reqId);
    if (i < 0) return undefined; // 无此需求：不写盘
    // 存量需求盘上没有这个字段，兜底成空数组（getRequirement 是裸读、无归一）
    const cur = Array.isArray(list[i].agentWorktrees) ? list[i].agentWorktrees : [];
    if (cur.some((x) => x?.worktreeDir === worktreeDir)) {
      updated = list[i];
      return undefined; // 已登记过：不写盘，保持首次登记的 dir/branch
    }
    list[i] = {
      ...list[i],
      agentWorktrees: [
        ...cur,
        {
          dir: typeof wt.dir === 'string' ? wt.dir : '',
          worktreeDir,
          branch: typeof wt.branch === 'string' ? wt.branch : '',
        },
      ],
      updatedAt: new Date().toISOString(),
    };
    updated = list[i];
    return list;
  });
  return updated;
}
```

> **为什么不做读侧归一**：`getRequirement` 是裸读（`readJson(...).find(...)`），本仓没有统一的需求 normalize 函数，加一个会牵动所有读路径。而 `agentWorktrees` 的消费方只有两处（这里登记、删除时回收），回收那处用 `(r?.agentWorktrees || [])` 兜底即可，存量需求缺字段不影响。

Run: `node --test src/store/requirements.test.js`
Expected: PASS（6 条新用例）

- [ ] **Step 4: 派活时登记**

在 `src/entrypoints/web/colleague-dev.js` 里 `ensureReqWorktree` 成功之后加**一行**：

```js
// 登记 worktree：需求删除时要靠它回收目录（spec §5.3）。
// 走 store 的专用口而不是「读出来拼好再 updateRequirement」—— 后者是 read-modify-write，
// 同一需求并发派活时会互相覆盖掉对方的登记（本仓纪律见 store/CLAUDE.md）。
addAgentWorktree(reqId, { dir: repo, worktreeDir: wt.dir, branch });
```

> 变量名按该函数里实际的写法对齐（`wt` 是 `ensureReqWorktree` 的返回值，`repo` 是项目路径，`branch` 是本次的 agent 分支）。去重在 store 的锁内做，这里不用判重复。
>
> 别忘了 import `addAgentWorktree`。

- [ ] **Step 5: 删除需求时回收**

> **先认清目标函数的真实形态**（2026-09-28 核实，计划初稿写错过）：
> - 函数叫 **`handleDelete(req, res)`**（`routes-requirements.js:665`），**不叫** `handleRequirementDelete`
> - 它**只有两个参数，没有 deps 注入点** —— 要单测注入 `runScript`，得先给它加一个 `deps = {}` 第三参（照本文件里 `handleColleagueAgentTurn` 的写法）
> - 它有两道前置闸：`phase !== 'discarded'` → 409、`busy || hasQueuedTasks(id)` → 409。**测试里必须先把需求置成 `discarded`**，否则拿到的是 409 而不是删除结果

在 `deleteRequirement(id)` **之前**（删了就读不到 `agentWorktrees` 了）加：

```js
// 先回收 agent worktree 再删需求记录：顺序反了就读不到 agentWorktrees 了，
// 目录会永远留在盘上（每个都是一份完整工作区拷贝）
const r = getRequirement(id);
for (const w of r?.agentWorktrees || []) {
  // 幂等：目录不存在时 git 返回非 0 但无副作用。失败只告警——
  // 删不掉一个临时目录不该阻止用户删需求
  const rm = await runScript('git', ['-C', w.dir, 'worktree', 'remove', '--force', w.worktreeDir], { shell: false });
  if (!rm.ok) logger.warn('routes-req', '回收 agent worktree 失败（不阻塞删除）', { reqId: id, dir: w.worktreeDir });
}
```

- [ ] **Step 6: 写删除路径的回归测试**

```js
/** 造一个满足 handleDelete 两道前置闸的需求：phase=discarded 且无 busy/排队任务 */
function seedDiscarded(worktrees) {
  const r = createRequirement({ title: 'x' });
  updateRequirement(r.id, { phase: 'discarded', agentWorktrees: worktrees });
  return r;
}

test('删除需求：先回收 agent worktree 再删记录（顺序反了就读不到登记）', async () => {
  const r = seedDiscarded([{ dir: 'D:/p', worktreeDir: 'D:/p.req-a', branch: 'b' }]);
  const removed = [];
  const res = mockRes();
  await handleDelete(mockReq({ id: r.id }), res, {
    runScript: async (_cmd, args) => (removed.push(args.at(-1)), { ok: true }),
  });
  assert.equal(res.statusCode, 200, `应删除成功，实际响应：${res.body}`);
  assert.deepEqual(removed, ['D:/p.req-a']);
  assert.equal(getRequirement(r.id), null);
});

test('删除需求：worktree 回收失败不阻塞删除（删不掉临时目录不该卡住用户）', async () => {
  const r = seedDiscarded([{ dir: 'D:/p', worktreeDir: 'D:/p.req-a', branch: 'b' }]);
  const res = mockRes();
  await handleDelete(mockReq({ id: r.id }), res, {
    runScript: async () => ({ ok: false, err: 'locked' }),
  });
  assert.equal(getRequirement(r.id), null, '回收失败也要把需求删掉');
});

test('删除需求：没有 agentWorktrees 登记时不调 runScript（别对着空列表空跑 git）', async () => {
  const r = seedDiscarded([]);
  let called = 0;
  const res = mockRes();
  await handleDelete(mockReq({ id: r.id }), res, { runScript: async () => (called++, { ok: true }) });
  assert.equal(called, 0);
  assert.equal(getRequirement(r.id), null);
});
```

> `handleDelete` 当前签名是 `(req, res)`，要先加第三个参数 `deps = {}` 并从中取 `runScript`（默认值用真实的 `runScript`），否则上面的注入无处可去。`mockReq` / `mockRes` 用 Task 5 加进该测试文件的那两个。

- [ ] **Step 7: 跑到通过**

Run: `npm test`
Expected: 全绿

- [ ] **Step 8: 一次性清理已有的孤儿目录**

P2 已经上线过一段时间，盘上可能已有无主的 `.req-*` 目录（它们建立时还没有登记机制）。列出来人工确认后再删：

```bash
# 列出所有 per-需求 worktree 及其归属
cd "C:/Users/DELL/Desktop/kxmall-app-ui" && git worktree list
```

对照 web 端需求列表，把已不存在的需求对应的目录手工 `git worktree remove --force <dir>`。
**不要写脚本自动删** —— `ensureWorktreeAt` 的既有纪律是「绝不自动删用户目录」，这里沿用。

- [ ] **Step 9: 提交**

```bash
git add src/store/requirements.js src/store/requirements.test.js src/entrypoints/web/colleague-dev.js src/entrypoints/web/routes-requirements.js src/entrypoints/web/routes-requirements.test.js
git commit -m "fix(req): 登记并回收 per-需求 agent worktree（补 spec §5.3）"
```

---

## Task 11: 文档更新

**Files:**
- Modify: `src/plugins/CLAUDE.md`
- Modify: `src/store/CLAUDE.md`
- Modify: `src/entrypoints/CLAUDE.md`
- Modify: `src/capabilities/CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-09-22-colleague-agent-design.md`

- [ ] **Step 1: `src/capabilities/CLAUDE.md`**

该文件的文件清单**至今没有收录 `agent-tools.js` 与 `agent-session.js`**（P1 就该加，漏了）。补两行，并在开头的「定位」段把「三块能力」改成「四块」（token-rotation + 三种 LLM 骨架 + 工具注册表）。

- [ ] **Step 2: `src/plugins/CLAUDE.md`**（2026-09-28 精确定位，4 处）

| 行 | 现状 | 要做什么 |
|---|---|---|
| 53–57 | `### colleague-relay/ —— 同事消息中继` 整节（5 行，逐个描述已删文件） | **整节删除**，换成 `### colleague-agent/ —— 同事侧对话 Agent`，列 `index.js`（工具自注册 + feature 装配）/ `feature.js`（order 35）/ `relay.js`（文本与附件共用的入站层）/ `session.js`（**web 进程**编排）/ `rate-limit.js` / `prompt.js` / `tools/req-read.js` / `tools/req-write.js` |
| 96 | 卡片回调列表里有 `colleague-pick`（`colleague-relay/index.js`） | 删掉这一项（选择卡已随 `_pending` 下线） |
| 98 | 讲 `loadPluginSideEffects` 那段 | **保持原样**，仍然准确 |
| 153 | 「要改同事消息的归属规则」→ `colleague-relay/logic.js#resolveTargets` | 改成 → `colleague-agent/relay.js#isColleagueMessage`，并说明 2.0 判定**不再看开发期需求**（名册内就接管） |

另在「关键流程」补一节 **F. 同事对话 agent 的两进程分工**，把第一部分 §0.1 那张图搬进去（feishu 判定落盘 → 跨进程 POST → web 限流/跑 agent/回复）。

- [ ] **Step 3: `src/store/CLAUDE.md`**（2 处）

| 行 | 要做什么 |
|---|---|
| 61 | `colleague-messages.js` 那条**整段重写**：锚点已是 `colleagueId`（不再是 `reqId × colleagueId`）；`reqId` 降为**消息标签**；`_pending` 全族已下线；新增 `agentSessionId`（SDK resume 锚点）与 `toolTrace`（入站恒为 null）；`dropReqThreads` 语义从「删整条线」变成「**摘掉带该标签的消息**」（删线会把同事全部历史对话一起抹掉）；`markHandled` 已收窄为 `(colleagueId, msgId, opts)` |
| 110 | 「要改同事对话的存储形状 / 未读口径 / **待归属缓冲**」→ 删掉「待归属缓冲」与 `_pending` 命名空间那半句，改为指向「新能力走 `getColleagueThread`/`appendTo`/`markColleagueRead`」 |

- [ ] **Step 4: `src/entrypoints/CLAUDE.md`**（4 处）

| 行 | 要做什么 |
|---|---|
| 39–40 | `web/colleague-auto.js` 与 `web/colleague-auto.logic.js` 两条**删除** |
| 41 | `web/colleague-dev.js` 那条：删掉「**不得 import `colleague-auto.js`**（成环）」这半句（那个文件没了），改为说明它的纯函数层已独立为 `colleague-dev.logic.js`；**新增一条** `web/colleague-dev.logic.js`（`newSubConvId` / `buildBrief`，从已下线的四期管线搬来） |
| 61 | 测试清单里的 `colleague-auto` / `colleague-auto.logic` 删掉，换成 `colleague-dev.logic` |
| 113 | 「要改同事消息中继」**整条重写**：文本链路 → `plugins/colleague-agent/feature.js`（order 35），附件链路 → `feishu/index.js` 的 image/file 分支调 `colleague-agent/relay.js#relayToAgent`（**两条共用同一份判定**），agent 一轮在 web 进程（`POST /api/req/colleague-agent/turn` → `session.js`）；四期自动处理与 `colleague-relay` 插件**已整体下线** |

- [ ] **Step 5: spec 标记 P3 完成**

在 `docs/superpowers/specs/2026-09-22-colleague-agent-design.md`：
- §9 分期表把 P3 那行标 ✅ 并注日期
- §4 架构图下方加一段：**架构图是逻辑视图，不是进程视图** —— 实际实现把 feature（飞书进程）与 session（web 进程）拆开了，中间是一次跨进程 POST，理由见 P3 计划第一部分 §0.1（写工具要调的 `registerApiDoc`/`enqueueSystemTask` 操作的是 web 进程内存里的泵与 busy 状态机）
- §5.3 的 `agentWorktrees` 标注「P3 Task 10 补齐（P2 遗漏）」

- [ ] **Step 6: 验收**

Run: `grep -rn "colleague-relay\|colleague-auto" src/*/CLAUDE.md`
Expected: **无输出**，或只剩明确标注为「已下线」的历史说明

Run: `npm test`
Expected: 全绿（本 Task 只改 Markdown，数字不该变）

---

## 三、已知遗留（P3 不做，记录备查）

### 1. `feishu/index.js` 的附件字段映射没有测试覆盖

`relayColleagueAttachment` 里那几行映射（image 分支 `name` 恒为空串、file 分支透传 `m.files[0]` 的 name/path）目前零覆盖，因为整个文件一被 import 就会 `channel.start()` 建飞书长连接，测不了。

**最小可行做法**（Task 7 审查员建议，与本仓既有的「编排文件 + `.logic.js` 纯逻辑分离」惯例一致，参照 `run-claude.js` / `run-claude.logic.js`）：把映射抽成零 IO 纯函数，例如 `feishu/attachment-relay.logic.js` 的 `buildRelayPayload(m, file, kind)` 只做 `{openId, text, files}` 组装，`index.js` 里调 `relayToAgent(buildRelayPayload(...))`。这样能单测「两种附件形态映射对不对」且不引入任何副作用。

`relayToAgent` 本身的判定逻辑已在 `colleague-agent/relay.test.js` 覆盖，不需要重复测。

**优先级低**：这几行逻辑极简单且几乎不会变；真正的风险在于**整个文件没有任何加载期验证**，而那个靠抽一个纯函数也解决不了（见下）。

### 2. `feishu/index.js` 全仓无测试加载，ESM 缺失导出零防护

这是既有状况，不是 P3 引入。当前唯一的防线是**人工静态符号比对**（Task 7 做了一次，20/20）。

真要自动化，得让某个测试能安全加载它 —— 意味着把 `channel.start()` 那段副作用挪到一个显式的 `start()` 导出里、模块加载时不自动跑。那是入口层的结构改动，影响面超出 P3。

### 3. `sendText` 等 deps 默认值零覆盖

`session.js` 里所有 `deps` 默认值（`creds()`、真实 `sendTextToUser`、真实 `appendTo`）永远被测试注入的桩替换，从未被任何用例执行过。这是本仓 DI 模式的**固有代价**（`task-notify.js`、`colleague-auto.js` 同款），Task 4 审查员判定「不值得为测一行 `if (!c) {warn; return}` 而新增一层间接性」，不建议改造。

---

## 四、整体验收

### 自动化

```bash
npm test          # 必须全绿
npm run test:e2e  # 已知 2 项因 #taskBtn 改名恒红（与本期无关，见 auto-merge-revert-impl 记忆）
```

### 迁移前必做

```bash
cp "C:/Users/DELL/AppData/Roaming/com.principal.desktop/colleague-messages.json" \
   "C:/Users/DELL/AppData/Roaming/com.principal.desktop/colleague-messages.pre-p3.bak.json"
```

拍板 #1 明确**没有回退开关**，这份备份是数据层唯一的退路。

### 人工走查（桌面版必须重建重装后才生效）

- [ ] 名册内同事私聊发一句文字 → 收到的是 **agent 的实质回复**（不是「已收到，会转达」）
- [ ] 同一个同事连发 6 条 → 第 6 条收到 `ACK_RATE`，前 5 条正常
- [ ] 两个同事同时说话、第三个插进来 → 第三个收到 `ACK_BUSY`
- [ ] 同事发一份接口文档（附件）→ agent 调 `register_api_doc`，web 端需求详情能看到那份文档
- [ ] 同事说「这个接口改一下」→ agent 调 `start_dev_task`，任务面板出现对应任务
- [ ] 主机在 web 端需求 A 的会话面板：**看不到**该同事在需求 B 说的话
- [ ] 同事在两个需求里都说过话 → agent 记得上一轮上下文（resume 生效）
- [ ] 名册外的人发消息 → 仍走 feedback 被当成新需求收（PASS 回落没断）
- [ ] 群聊里 @ 机器人 → 正常进 agent；不 @ → 静默
- [ ] `colleague-messages.json` 迁移后：每个同事一条线，历史消息带 `reqId` 标签，条数与备份一致（除 `_pending`）
- [ ] 删掉一个曾派过活的需求 → `git worktree list` 里对应的 `.req-*` 目录消失（Task 10）

### 观测点

```bash
# agent 真的拿到工具了吗（零工具 = 插件没加载，回复会通顺但全凭记忆）
grep "按角色装配出零个工具" logs/*.log

# 限流是否在拦
grep "限流，回 ACK 不起 agent" logs/*.log

# 退化到 ACK 的频率 —— 高说明额度/超时有问题
grep "本轮未产出回复，退化到 ACK" logs/*.log
```
