/**
 * P3 openai 检查点续跑 fs 级集成：
 *  - 每步消息落盘（conv-messages 即检查点）；
 *  - 崩溃现场的悬空 tool-call 修复并落盘；
 *  - resume 的失败路径（凭证已删 / 检查点为空）。
 * 启动对账（原 recoverOpenAiOrphans，P5 起统一为 run-claude#reconcileRuns）的用例在 run-reconcile.test.js。
 *
 * 模型侧用「注册表同 id 覆盖」注入假 provider（registry 明确支持测试替身），内部仍跑真
 * agent-loop + 真内置工具——只把最外层的模型调用换成脚本。
 * 隔离：APP_DATA_DIR → 临时目录；全部动态 import（store 基座在模块求值时定死目录）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'run-openai-resume-'));
process.env.APP_DATA_DIR = DATA;

const providers = await import('../../providers/index.js');
const { runAgentLoop } = await import('../../providers/agent-loop.js');
const { startOpenAiRun, resumeOpenAiRun } = await import('./run-openai.js');
const { startRunDurability } = await import('./run-durability.js');
const { getMessages, appendMessages, clearMessages, getSummary } = await import('../../store/conv-messages.js');
const { listRunIndex } = await import('../../store/run-index.js');
const { createRun, finishRun } = await import('../../store/runs.js');
const { setBuiltinMcp, setRepoMapEnabled, addToken, getTokens, setTokens } = await import('../../store/settings.js');

// ---- 假 provider：同 id 覆盖真实现，内部跑真 agent-loop ----
let scriptedModel = null;
let lastInput = null;
let allInputs = [];
let lastHooks = null;
providers.register({
  id: 'openai-compat',
  capabilities: {},
  run(input, hooks) {
    lastInput = input;
    allInputs.push(input);
    lastHooks = hooks;
    const done = runAgentLoop(
      { messages: input.messages, modelRun: scriptedModel, executeTool: input.executeTool, signal: input.abortController?.signal },
      hooks,
    );
    return { done, abort: () => {} };
  },
});

/** 按脚本产出模型步骤（与 agent-loop.test.js 的 recordingModel 同思路，不记录调用） */
function makeScript(steps) {
  let n = 0;
  return () => {
    const s = steps[n++] || { finishReason: 'stop', responseMessages: [] };
    return {
      stream: (async function* () {
        // 与真 adapter 一致：text 与 tool-call 都是流事件（onActivity 挂在后者上）
        if (s.text) yield { type: 'text', text: s.text };
        for (const c of s.toolCalls || []) {
          yield { type: 'tool-call', toolCallId: c.toolCallId, toolName: c.toolName, input: c.input, ...(c.invalid ? { invalid: true } : {}) };
        }
      })(),
      finished: Promise.resolve({
        finishReason: s.finishReason || 'stop',
        toolCalls: s.toolCalls || [],
        responseMessages: s.responseMessages || [],
      }),
    };
  };
}

const textStep = (text) => ({ text, responseMessages: [{ role: 'assistant', content: [{ type: 'text', text }] }] });

async function waitDone(run, ms = 3000) {
  const t0 = Date.now();
  while (run.status === 'running' && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
  assert.notEqual(run.status, 'running', 'run 应在时限内收尾');
}

let CRED_ID = null;
test.before(() => {
  // 关掉外部依赖：内置 MCP（会拉 npx 子进程）与仓库地图（会扫盘）
  setBuiltinMcp('context7', { enabled: false });
  setRepoMapEnabled(false);
  const tokens = addToken('测试模型', 'sk-test', 'openai-compat', { baseURL: 'http://127.0.0.1:9/v1', model: 'test-model' });
  CRED_ID = tokens[tokens.length - 1].id;
  startRunDurability(); // 激活 journal sink（幂等）
  fs.writeFileSync(path.join(DATA, 'hello.txt'), 'hello from checkpoint');
});

// ---- 每步落盘（fresh 路径）----

test('start：模型两步（真内置 Read + 文本）→ conv-messages 逐步留下检查点', async (t) => {
  const convId = 'c_fresh_steps';
  clearMessages(convId);
  const readInput = { file_path: path.join(DATA, 'hello.txt') };
  scriptedModel = makeScript([
    {
      toolCalls: [{ toolCallId: 'tc1', toolName: 'Read', input: readInput }],
      finishReason: 'tool-calls',
      responseMessages: [
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tc1', toolName: 'Read', input: readInput }] },
      ],
    },
    textStep('读完了'),
  ]);
  const run = createRun();
  await startOpenAiRun(run, { prompt: '读 hello.txt', model: 'test-model', credId: CRED_ID, cwd: DATA, convId, requestId: 'rq_fresh', effort: 'low' });
  await waitDone(run);

  const msgs = getMessages(convId);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant'], '每步增量都已落盘');
  assert.equal(msgs[1].content[0].toolCallId, 'tc1');
  assert.ok(JSON.stringify(msgs[2].content[0].output).includes('hello from checkpoint'), 'tool 结果来自真内置工具');
  assert.equal(msgs[3].content[0].text, '读完了');
  assert.equal(run.status, 'done');
  // 强度透传（composer-bar spec）：请求带 reasoning_effort，run 快照留档供 follow-up 排空
  assert.equal(lastInput.effort, 'low', 'effort 经 provider input 透传');
  assert.equal(run.effort, 'low', 'run.effort 快照（buildFollowUpItem 取它）');
});

// ---- 联网/清单/子代理（2026-10-08 四工具）----

test('TodoWrite：工具调用经 onActivity 落 run.todos（任务面板数据源），执行器返回确认', async () => {
  const convId = 'c_todo';
  clearMessages(convId);
  const todoInput = { todos: [{ content: '修复登录', status: 'in_progress' }, { content: '写测试', status: 'pending' }] };
  scriptedModel = makeScript([
    {
      toolCalls: [{ toolCallId: 'tt1', toolName: 'TodoWrite', input: todoInput }],
      finishReason: 'tool-calls',
      responseMessages: [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tt1', toolName: 'TodoWrite', input: todoInput }] }],
    },
    textStep('清单已更新'),
  ]);
  const run = createRun();
  await startOpenAiRun(run, { prompt: '列个清单', model: 'test-model', credId: CRED_ID, cwd: DATA, convId });
  await waitDone(run);
  assert.equal(run.todos.length, 2, 'run.todos 应有两条');
  assert.equal(run.todos[0].content, '修复登录');
  assert.equal(run.todos[0].status, 'in_progress');
  assert.equal(run.status, 'done');
});

test('Task：只读子代理——嵌套调用只拿只读子集工具，结论作为工具结果回灌主循环', async () => {
  const convId = 'c_task';
  clearMessages(convId);
  allInputs = [];
  const taskInput = { description: '查配置', prompt: '子代理任务：调查配置在哪' };
  scriptedModel = makeScript([
    {
      toolCalls: [{ toolCallId: 'tk1', toolName: 'Task', input: taskInput }],
      finishReason: 'tool-calls',
      responseMessages: [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tk1', toolName: 'Task', input: taskInput }] }],
    },
    textStep('子代理结论：配置在 settings.json'),
    textStep('收到，结论如上'),
  ]);
  const run = createRun();
  await startOpenAiRun(run, { prompt: '调查配置', model: 'test-model', credId: CRED_ID, cwd: DATA, convId });
  await waitDone(run);

  const childInput = allInputs.find((i) => String(i.messages?.[0]?.content || '').includes('只读探查子代理'));
  assert.ok(childInput, '应有子代理的 provider 调用');
  const childTools = Object.keys(childInput.tools || {}).sort();
  assert.deepEqual(childTools, ['Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch'], '只读子集：不含 Write/Edit/Bash/Task');
  assert.equal(String(childInput.messages[1].content).includes('子代理任务'), true);

  const msgs = getMessages(convId);
  const toolMsg = msgs.find((m) => m.role === 'tool');
  assert.ok(JSON.stringify(toolMsg).includes('子代理结论'), '子代理结论应作为工具结果落盘');
  assert.equal(run.status, 'done');
});

// ---- 工具策略模式（composer bar 的 询问/接受编辑/计划/自动）----

test('mode：自动档（bypassPermissions）进策略门——写文件直放不弹审批；journal 记录真实档位；中途切档实时生效', async () => {
  const convId = 'c_mode';
  clearMessages(convId);
  scriptedModel = makeScript([textStep('ok')]);
  const run = createRun();
  await startOpenAiRun(run, {
    prompt: '写个文件', model: 'test-model', credId: CRED_ID, cwd: DATA, convId, mode: 'bypassPermissions',
  });
  assert.equal(run.mode, 'bypassPermissions', '档位应落到 run');
  assert.ok(lastHooks?.canUseTool, '策略门应挂在 hooks 上');
  const decision = await lastHooks.canUseTool('Write', { file_path: path.join(DATA, 'mode-test.txt'), content: 'x' });
  assert.deepEqual(decision, { behavior: 'allow' }, '自动档下写文件应直接放行（不弹审批）');
  // 中途切档：策略门实时读 run.mode（不用等下一条消息）——切到 plan 后写操作即被拒
  run.mode = 'plan';
  const tightened = await lastHooks.canUseTool('Write', { file_path: path.join(DATA, 'mode-test.txt'), content: 'x' });
  assert.equal(tightened.behavior, 'deny', '切到「计划」后写入应被策略拒绝');
  run.mode = 'bypassPermissions';
  await waitDone(run);
  const journal = fs
    .readFileSync(path.join(DATA, 'run-journal.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const submitted = journal.filter((e) => e.runId === run.id && e.type === 'submitted').pop();
  assert.equal(submitted?.data?.mode, 'bypassPermissions', 'journal 不得再把 mode 写死为 null');
});

// ---- 崩溃现场的悬空修复 + 检查点续跑 ----

test('resume：悬空 tool-call 补合成「未执行」结果并落盘，然后从检查点继续（不追加「继续」提示词）', async (t) => {
  const convId = 'c_resume_ok';
  clearMessages(convId);
  appendMessages(convId, [
    { role: 'user', content: '读一下 a.txt' },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'tw1', toolName: 'Read', input: { path: 'a.txt' } }],
    },
  ]);
  scriptedModel = makeScript([textStep('已经读过 a.txt，继续完成')]);

  const run = createRun();
  await resumeOpenAiRun(run, {
    convId,
    runId: 'run_dead_1',
    model: 'test-model',
    credId: CRED_ID,
    cwd: DATA,
    prompt: '读一下 a.txt',
    resumeAttempt: 1,
    mode: 'acceptEdits', // 续跑按原档位恢复策略门（此前丢失 → 续跑必退回 default 逐次询问）
  });
  await waitDone(run);
  assert.equal(run.mode, 'acceptEdits', '续跑应恢复 run-index 里的原档位');

  // 交给模型的消息：system + user + assistant(悬空) + 合成的 tool 结果；没有追加「继续」
  const sent = lastInput.messages;
  assert.deepEqual(sent.map((m) => m.role), ['system', 'user', 'assistant', 'tool']);
  assert.equal(sent[3].content[0].toolCallId, 'tw1');
  assert.match(sent[3].content[0].output.value, /未执行/);

  // 修复已落盘，新回复接在其后
  const msgs = getMessages(convId);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(msgs[3].content[0].text, '已经读过 a.txt，继续完成');
  assert.equal(run.status, 'done');
  // 续跑 run 的索引已摘除（收尾即删；finally 在 done 后一个微任务内执行，等一拍再断言）
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(listRunIndex().some((e) => e.runId === run.id), false);
});

test('resume：检查点停在完整回复末尾（settle 前崩溃的窗口）→ 中性收尾，不烧模型调用', async (t) => {
  const convId = 'c_resume_tail';
  clearMessages(convId);
  appendMessages(convId, [
    { role: 'user', content: '打个招呼' },
    { role: 'assistant', content: [{ type: 'text', text: '你好呀' }] },
  ]);
  lastInput = null;
  scriptedModel = () => {
    throw new Error('不应调用模型');
  };
  const run = createRun();
  await resumeOpenAiRun(run, { convId, runId: 'run_dead_2', model: 'test-model', credId: CRED_ID, cwd: DATA });
  await waitDone(run);
  assert.equal(lastInput, null, '完整回复末尾不得再续一轮');
  assert.equal(run.status, 'done');
});

// ---- resume 失败路径 ----

test('resume：原凭证已删 → 明确报错，不静默换号', async (t) => {
  const saved = getTokens();
  setTokens([]);
  t.after(() => setTokens(saved));
  const convId = 'c_resume_nocred';
  clearMessages(convId);
  appendMessages(convId, [{ role: 'user', content: '干到一半' }]);
  const run = createRun();
  await resumeOpenAiRun(run, { convId, runId: 'run_dead_3', model: 'test-model', credId: CRED_ID, cwd: DATA });
  assert.equal(run.status, 'error');
  assert.match(run.text, /凭证已不可用/);
});

test('resume：检查点为空 → 明确报错（无可续内容）', async (t) => {
  const convId = 'c_resume_empty';
  clearMessages(convId);
  const run = createRun();
  await resumeOpenAiRun(run, { convId, runId: 'run_dead_4', model: 'test-model', credId: CRED_ID, cwd: DATA });
  assert.equal(run.status, 'error');
  assert.match(run.text, /检查点为空/);
});

// ---- T7 上下文压缩 ----

test('压缩：历史超限 → 同凭证一次性调用生成滚动摘要；模型只见「摘要+近期」，原文保留', async () => {
  const convId = 'c_compact_1';
  clearMessages(convId);
  const seed = Array.from({ length: 260 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i % 2 ? 'a' : 'u'}${i}` }));
  appendMessages(convId, seed);
  allInputs = [];
  scriptedModel = makeScript([textStep('摘要一：用户在改登录流程'), textStep('已按摘要继续')]);

  const run = createRun();
  await startOpenAiRun(run, { prompt: '继续改登录', model: 'test-model', credId: CRED_ID, cwd: DATA, convId });
  await waitDone(run);

  // 摘要落盘（与消息同文件）
  const summary = getSummary(convId);
  assert.ok(summary && summary.covered > 0, '摘要已落盘');
  assert.equal(summary.model, 'test-model');
  assert.ok(summary.covered >= 20 && summary.covered <= 261 - 100, `切点在合法区间：${summary.covered}`);

  // 摘要调用：同凭证、零工具、system 是压缩器提示
  const summInput = allInputs.find((i) => String(i.messages?.[0]?.content || '').includes('会话压缩器'));
  assert.ok(summInput, '走了同凭证的一次性摘要调用');
  assert.ok(!summInput.tools || Object.keys(summInput.tools).length === 0, '摘要调用不带工具');
  assert.match(summInput.messages[1].content, /【新增需要并入摘要的对话】/);

  // 正式调用：system 带摘要段；消息 = 未被覆盖的近期（从摘要边界起）
  const mainInput = allInputs.at(-1);
  assert.equal(mainInput.messages[0].role, 'system');
  assert.match(mainInput.messages[0].content, /## 历史摘要/);
  assert.match(mainInput.messages[0].content, /摘要一/);
  const view = mainInput.messages.slice(1);
  assert.equal(view.length, 261 - summary.covered, '模型视角 = 摘要 + 近期');
  assert.equal(view[0].content, seed[summary.covered].content, '视图起点恰为摘要覆盖边界');

  // 原文保留：头部消息仍在存储里（backstop 未触发）
  const stored = getMessages(convId);
  assert.ok(stored.length >= 262, '本轮新增已落盘且旧原文未丢');
  assert.equal(stored[0].content, 'u0');
});

test('压缩：第二轮再超限 → 滚动摘要（旧摘要参与合并），覆盖范围前移', async () => {
  const convId = 'c_compact_1';
  const before = getSummary(convId);
  appendMessages(convId, Array.from({ length: 150 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `n${i}` })));
  allInputs = [];
  scriptedModel = makeScript([textStep('摘要二：已合并更新'), textStep('继续完成')]);

  const run = createRun();
  await startOpenAiRun(run, { prompt: '在吗', model: 'test-model', credId: CRED_ID, cwd: DATA, convId });
  await waitDone(run);

  const after = getSummary(convId);
  assert.ok(after.covered > before.covered, '覆盖范围前移（不是从头重算）');
  const summInput = allInputs.find((i) => String(i.messages?.[0]?.content || '').includes('会话压缩器'));
  assert.ok(summInput, '第二轮同样走摘要调用');
  assert.match(summInput.messages[1].content, /摘要一/, '旧摘要参与滚动合并');
  const mainInput = allInputs.at(-1);
  assert.match(mainInput.messages[0].content, /摘要二/, '模型看到的是更新后的摘要');
});

