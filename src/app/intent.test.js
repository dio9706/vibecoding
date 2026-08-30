/**
 * intent 单测：
 * - isChitchat：寒暄本地快路（免 LLM），保守匹配，宁可漏判不可误判真实请求。
 * - classify：L0 寒暄 / L1 强前缀 / L2 动作关键词 的零 LLM 短路（L3 Haiku 需网络，不在单测覆盖）。
 * - isPoolExhausted：备用 token 池健康度（定义在 token-rotation，此处就近测试池语义）。
 *
 * 隔离：classify 的 L2 要读 settings.json / action-configs.json，而 store/index.js 在模块求值时
 * 就把数据目录定死 → 必须「先设 APP_DATA_DIR 到临时目录，再动态 import」，否则读到开发机真实
 * 配置，用例结果随本机动作配置漂移。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-test-'));
process.env.APP_DATA_DIR = TMP_DIR;
fs.writeFileSync(
  path.join(TMP_DIR, 'settings.json'),
  JSON.stringify({ bots: [{ id: 'bot_t', name: '测试机器人', enabled: true }] }),
);
fs.writeFileSync(
  path.join(TMP_DIR, 'action-configs.json'),
  JSON.stringify([
    {
      id: 'ac_clean',
      botId: 'bot_t',
      name: '清理测试数据',
      description: '清空 test 环境业务表',
      keywords: ['清一下', '清理数据'],
      enabled: true,
    },
  ]),
);

const { isChitchat, classify, INTENT_CLASSIFY_TIMEOUT_MS } = await import('./intent.js');
const { isPoolExhausted } = await import('../capabilities/token-rotation.js');
const { matchStrongIntent } = await import('./intent-keywords.js');
const { REGISTRY } = await import('../shared/messages.js');

test('welcome 引导文案里的「例:」必须真能被 L1 强前缀识别（防文案教用户说一句识别不了的话）', () => {
  // 文案与词表是两个文件，很容易各自演进。典型坑：把「提个bug」排版成「提个 bug」——
  // 词表是无空格字面量，加空格后掉出 L1，用户照着说反而又收到这条兜底文案。
  const examples = REGISTRY.welcome.defaultText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^例[:：]/.test(l))
    .map((l) => l.replace(/^例[:：]\s*/, ''));
  assert.equal(examples.length, 3, '引导文案应有需求/故障/问询三条示例');
  assert.deepEqual(
    examples.map((e) => matchStrongIntent(e)?.type ?? null),
    ['feature', 'bug', 'question'],
    '三条示例须分别命中 feature / bug / question 强前缀',
  );
  for (const e of examples) {
    // 只命中前缀却把正文一起吃掉，同样是坏示例（feedback 会当成「只发了前缀」去追问）
    assert.ok(matchStrongIntent(e).body.length >= 5, `示例正文被前缀吃掉：${e}`);
  }
});

test('isChitchat：常见问候/寒暄/纯表情标点 → true（走免 LLM 快路）', () => {
  for (const t of ['你好', '您好', 'hi', 'Hello', '在吗', '谢谢', '好的', 'ok', '收到', '你好呀', '👍', '   ', '。。。', '拜拜', 'bye', 'byebye', 'Bye~']) {
    assert.equal(isChitchat(t), true, `期望 "${t}" 判为寒暄`);
  }
});

test('isChitchat：真实请求 / 含动作内容 → false（必须落到正常分类）', () => {
  for (const t of ['帮我清理test环境数据', '体验版二维码', '你好，帮我清理test环境', '这里有个bug', '正式版二维码']) {
    assert.equal(isChitchat(t), false, `期望 "${t}" 不判为寒暄`);
  }
});

test('isChitchat：超长「bye」重复串必须**快速**返回 false（灾难性回溯回归保护）', () => {
  // 事故：CHITCHAT_RE 选择支同时有 byebye|bye 又被外层 + 包着 → 分解方式呈斐波那契增长。
  // 这是同步正则，一旦爆炸整个事件循环被占死（WS 心跳/去重/所有会话全停，abort/timeout 都救不了）。
  const long = 'bye'.repeat(60) + '中';
  const t0 = Date.now();
  assert.equal(isChitchat(long), false);
  const cost = Date.now() - t0;
  assert.ok(cost < 1000, `耗时 ${cost}ms：正则疑似回溯爆炸（长度闸 / byebye 选择支被改动？）`);
});

test('isChitchat：长度闸下方的重复串也必须快（byebye 歧义已移除）', () => {
  const t0 = Date.now();
  assert.equal(isChitchat('bye'.repeat(19) + '中'), false); // 58 字，未触发长度闸
  assert.ok(Date.now() - t0 < 1000, '长度闸内的串仍应线性匹配');
});

test('classify：寒暄 → other，零 LLM（L0 短路，strong=false）', async () => {
  assert.deepEqual(await classify('你好'), {
    intent: 'other', body: '', strong: false, env: null, keyword: null,
  });
});

test('classify：强前缀 → 直接出意图并带 body 与 strong=true，零 LLM（L1 短路）', async () => {
  assert.deepEqual(await classify('提交需求：加导出功能'), {
    intent: 'feature', body: '加导出功能', strong: true, env: null, keyword: null,
  });
  assert.deepEqual(await classify('提交故障：扫码白屏'), {
    intent: 'bug', body: '扫码白屏', strong: true, env: null, keyword: null,
  });
  assert.deepEqual(await classify('问个问题 订单怎么流转'), {
    intent: 'question', body: '订单怎么流转', strong: true, env: null, keyword: null,
  });
});

test('classify：强前缀无正文 → 仍出意图，body 为空串（调用方追问）', async () => {
  assert.deepEqual(await classify('提交需求'), {
    intent: 'feature', body: '', strong: true, env: null, keyword: null,
  });
});

test('classify：L1 question 不得劫持已配置动作（body 命中动作关键词 → action）', async () => {
  // 实测回归：中文最常见的礼貌前缀「请问…」把所有动作都判成了 question（跑去读代码回答）。
  assert.deepEqual(await classify('请问能帮我清一下 test 环境的数据吗'), {
    intent: 'action', body: '', strong: false, env: null, keyword: null,
    actionId: 'ac_clean', actionName: '清理测试数据',
  });
});

test('classify：L1 question 的 body 未命中动作 → 仍是 question（正文已剥净）', async () => {
  assert.deepEqual(await classify('请问一下这个怎么用'), {
    intent: 'question', body: '这个怎么用', strong: true, env: null, keyword: null,
  });
});

test('classify：L1 bug/feature 不让路给动作关键词（明确提交动作不该被抢）', async () => {
  assert.deepEqual(await classify('提交故障：清一下 test 环境的数据后页面白屏'), {
    intent: 'bug', body: '清一下 test 环境的数据后页面白屏', strong: true, env: null, keyword: null,
  });
});

test('classify：L2 动作关键词单命中 → action，strong=false（非强前缀来源）', async () => {
  assert.deepEqual(await classify('帮我清理数据'), {
    intent: 'action', body: '', strong: false, env: null, keyword: null,
    actionId: 'ac_clean', actionName: '清理测试数据',
  });
});

test('意图分类超时预算为 10s（用户在等第一条回复）', () => {
  assert.equal(INTENT_CLASSIFY_TIMEOUT_MS, 10_000);
});

test('isPoolExhausted：空池 → false（未配置池，用主账号，不 fail-fast）', () => {
  assert.equal(isPoolExhausted([]), false);
});

test('isPoolExhausted：存在 healthy / warning → false（仍可用）', () => {
  assert.equal(isPoolExhausted([{ status: 'exhausted' }, { status: 'healthy' }]), false);
  assert.equal(isPoolExhausted([{ status: 'warning' }]), false);
});

test('isPoolExhausted：全部 exhausted → true（应 fail-fast，跳过注定失败的分类调用）', () => {
  assert.equal(isPoolExhausted([{ status: 'exhausted' }, { status: 'exhausted' }]), true);
});
