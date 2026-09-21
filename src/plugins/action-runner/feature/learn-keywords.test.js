/**
 * 学习管线编排单测 —— 全部依赖注入替身，不联网、不写盘。
 * 关心的是编排正确性：谁被调用、被调用几次、拒绝时是否真的不写盘。
 * 规则本身的正确性由 keyword-guard.test.js 覆盖，这里不重复。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { learnKeywords } from './learn-keywords.js';

const ACTION = {
  id: 'ac_clean',
  botId: 'bot_t',
  name: '清理测试数据',
  description: '清空 test 环境业务表',
  keywords: ['清一下'],
  autoKeywords: [],
  rejectedKeywords: [],
};

/** 造一组替身；appended 收集实际写盘调用 */
function depsOf({ keywords = [], others = [], appendOk = true } = {}) {
  const appended = [];
  const calls = { classify: 0 };
  return {
    appended,
    calls,
    deps: {
      classify: async () => {
        calls.classify += 1;
        return { keywords };
      },
      listConfigs: () => [ACTION, ...others],
      append: (id, word, meta) => {
        appended.push({ id, word, meta });
        return appendOk;
      },
    },
  };
}

test('候选词全部合格 → 逐个写盘并返回已学到的词', async () => {
  const { deps, appended } = depsOf({ keywords: ['清掉业务表'] });
  const learned = await learnKeywords(
    { action: ACTION, sourceText: '帮我把 test 的清掉业务表吧' },
    deps,
  );
  assert.deepEqual(learned, ['清掉业务表']);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].id, 'ac_clean');
  assert.equal(appended[0].meta.sourceText, '帮我把 test 的清掉业务表吧');
});

test('候选词被硬闸拒绝 → 不写盘', async () => {
  // 「重置测试环境」不是原句的连续片段（规则 1）
  const { deps, appended } = depsOf({ keywords: ['重置测试环境'] });
  const learned = await learnKeywords(
    { action: ACTION, sourceText: '帮我把测试环境的数据清掉' },
    deps,
  );
  assert.deepEqual(learned, []);
  assert.equal(appended.length, 0);
});

test('与其他动作冲突的候选词 → 不写盘（不许拖慢别的动作）', async () => {
  const other = { id: 'ac_deploy', botId: 'bot_t', name: '部署', keywords: ['清理缓存'], enabled: true };
  const { deps, appended } = depsOf({ keywords: ['清理缓存数据'], others: [other] });
  const learned = await learnKeywords(
    { action: ACTION, sourceText: '帮我清理缓存数据' },
    deps,
  );
  assert.deepEqual(learned, []);
  assert.equal(appended.length, 0);
});

test('模型返回空 / 非法 → 静默退出，不写盘', async () => {
  for (const bad of [null, {}, { keywords: [] }, { keywords: 'nope' }]) {
    const appended = [];
    const learned = await learnKeywords(
      { action: ACTION, sourceText: '帮我清掉业务表' },
      { classify: async () => bad, listConfigs: () => [ACTION], append: (...a) => { appended.push(a); return true; } },
    );
    assert.deepEqual(learned, []);
    assert.equal(appended.length, 0);
  }
});

test('一轮最多学 2 个词（不激进）', async () => {
  const { deps, appended } = depsOf({ keywords: ['清掉业务表', '清空订单表', '清理留存表'] });
  const learned = await learnKeywords(
    { action: ACTION, sourceText: '帮我清掉业务表、清空订单表、清理留存表' },
    deps,
  );
  assert.equal(learned.length, 2, '一句话最多沉淀 2 个词，避免一次吃光配额');
  assert.equal(appended.length, 2);
});

test('本轮已学的词参与后续候选的冗余判定（快照不会自动更新）', async () => {
  // 第二个候选「清掉业务」是第一个「清掉业务表」的子串，必须被判冗余
  const { deps, appended } = depsOf({ keywords: ['清掉业务表', '清掉业务'] });
  const learned = await learnKeywords(
    { action: ACTION, sourceText: '帮我清掉业务表' },
    deps,
  );
  assert.deepEqual(learned, ['清掉业务表']);
  assert.equal(appended.length, 1);
});

test('配额已满 → 连模型都不调（省一次调用）', async () => {
  const full = { ...ACTION, autoKeywords: [1, 2, 3, 4, 5].map((i) => ({ word: `词${i}` })) };
  const { deps, calls, appended } = depsOf({ keywords: ['清掉业务表'] });
  const learned = await learnKeywords({ action: full, sourceText: '帮我清掉业务表' }, deps);
  assert.deepEqual(learned, []);
  assert.equal(calls.classify, 0, '配额满时不该发起模型调用');
  assert.equal(appended.length, 0);
});

test('原句为空 / 动作无 id → 直接返回，不调模型', async () => {
  const { deps, calls } = depsOf({ keywords: ['清掉业务表'] });
  assert.deepEqual(await learnKeywords({ action: ACTION, sourceText: '   ' }, deps), []);
  assert.deepEqual(await learnKeywords({ action: {}, sourceText: '帮我清掉业务表' }, deps), []);
  assert.equal(calls.classify, 0);
});

test('append 返回 false（锁内复核拒写）→ 不计入已学', async () => {
  const { deps, appended } = depsOf({ keywords: ['清掉业务表'], appendOk: false });
  const learned = await learnKeywords({ action: ACTION, sourceText: '帮我清掉业务表' }, deps);
  assert.deepEqual(learned, []);
  assert.equal(appended.length, 1, '仍然尝试过一次写入');
});

test('配额只剩 1 但模型给了 3 个合格候选 → 只学 1 个（全局配额赢过单轮上限）', async () => {
  // MAX_PER_ROUND(2) 管「一轮最多尝试几个」，MAX_AUTO_KEYWORDS(5) 管全局总量，谁先卡住谁生效。
  // 这里全局配额只剩 1 个位置，所以 MAX_PER_ROUND 根本没机会触发 —— 第 2 个候选就会被
  // 硬闸判 quota-full（因为 snapshot 把本轮已学的词也算进了 autoKeywords）。
  const almostFull = { ...ACTION, autoKeywords: [1, 2, 3, 4].map((i) => ({ word: `词${i}` })) };
  const { deps, appended } = depsOf({ keywords: ['清掉业务表', '清空订单表', '清理留存表'] });
  const learned = await learnKeywords(
    { action: almostFull, sourceText: '帮我清掉业务表、清空订单表、清理留存表' },
    deps,
  );
  assert.deepEqual(learned, ['清掉业务表'], '只应学到第一个');
  assert.equal(appended.length, 1, '后两个候选连写盘都不该尝试');
});
