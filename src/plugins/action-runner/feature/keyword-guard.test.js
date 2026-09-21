/**
 * 关键词自学习硬闸单测 —— 七条规则逐条钉死。
 *
 * 重点是规则 5（双向子串冲突）的**两个方向**：只查一边等于留一半的洞，
 * 而漏掉的那一半会让别的动作从「L2 秒出」退化成「L3 花钱等几秒」，用户完全看不出原因。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canLearnKeyword, MAX_AUTO_KEYWORDS } from './keyword-guard.js';

const ACTION = {
  id: 'ac_clean',
  botId: 'bot_t',
  name: '清理测试数据',
  keywords: ['清一下'],
  autoKeywords: [],
  rejectedKeywords: [],
};

const OTHERS = [
  { id: 'ac_qr', botId: 'bot_t', name: '获取二维码', keywords: ['二维码', '重置密码'] },
  { id: 'ac_deploy', botId: 'bot_t', name: '部署', keywords: ['清理缓存'] },
];

/** 用例默认上下文：原句一定包含候选词，好让规则 1 不误伤其他规则的用例 */
function ask(word, o = {}) {
  return canLearnKeyword({
    word,
    action: o.action || ACTION,
    otherActions: o.otherActions || OTHERS,
    sourceText: o.sourceText ?? `帮我${word}好吗`,
  });
}

test('规则 1：候选词不是原句的连续片段 → 拒（防模型凭空造词）', () => {
  const r = canLearnKeyword({
    word: '重置测试环境',
    action: ACTION,
    otherActions: [],
    sourceText: '帮我把测试环境的数据清掉',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-in-source');
});

test('规则 2：纯中文 2 字太泛 → 拒；3 字放行', () => {
  assert.equal(ask('清掉').reason, 'too-short');
  assert.equal(ask('清掉数').ok, true);
});

test('规则 2：含英文数字的候选词少于 4 字符 → 拒', () => {
  assert.equal(ask('qr码').reason, 'too-short');
});

test('规则 2：超过 12 字的候选词 → 拒（学了也不会再命中第二次）', () => {
  assert.equal(ask('把测试环境里所有的业务数据都清理干净').reason, 'too-long');
});

test('规则 3：通用停用词 → 拒', () => {
  // 刻意用 3 字以上的停用词：2 字的（帮我 / 一下 / 数据）会先被长度闸判 too-short，
  // 走不到这一条。黑名单里保留它们只是防线冗余（万一日后有人调低长度门槛）。
  assert.equal(ask('能不能').reason, 'stop-word');
  assert.equal(ask('下午好').reason, 'stop-word');
});

test('规则 4：命中 L1 强前缀词表 → 拒（否则「提交需求：…」会被动作抢走）', () => {
  const r = canLearnKeyword({
    word: '提交需求',
    action: ACTION,
    otherActions: [],
    sourceText: '提交需求单的入口在哪',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'strong-intent-prefix');
});

test('规则 5 正向：候选词包含其他动作的关键词 → 拒', () => {
  // 「清理缓存数据」含 ac_deploy 的「清理缓存」：今后这句话会同时命中两个动作，
  // L2 多命中 → 退回 L3，把原本秒出的部署动作也拖慢了。
  const r = ask('清理缓存数据');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'conflict:ac_deploy');
});

test('规则 5 反向：其他动作的关键词包含候选词 → 拒', () => {
  // 候选「重置密」被 ac_qr 的「重置密码」包含：今后「帮我重置密码」会同时命中两边。
  const r = ask('重置密');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'conflict:ac_qr');
});

test('规则 5：只与**其他**动作比，本动作自己的 id 要跳过', () => {
  // otherActions 里混进本动作自己（调用方可能没过滤干净），不该因此自我冲突
  const r = ask('清掉业务表', { otherActions: [...OTHERS, ACTION] });
  assert.equal(r.ok, true);
});

test('规则 6：与本动作已有关键词互为子串 → 冗余不加', () => {
  const r = canLearnKeyword({
    word: '清一下数据',
    action: ACTION,
    otherActions: [],
    sourceText: '帮我清一下数据',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'redundant');
});

test('规则 6：自动词配额已满 → 拒', () => {
  const full = {
    ...ACTION,
    autoKeywords: Array.from({ length: MAX_AUTO_KEYWORDS }, (_, i) => ({ word: `词${i}` })),
  };
  assert.equal(ask('清掉业务表', { action: full }).reason, 'quota-full');
});

test('规则 7：用户删过的词不再学回来（撤销必须永久有效）', () => {
  const withRejected = { ...ACTION, rejectedKeywords: ['清掉业务表'] };
  assert.equal(ask('清掉业务表', { action: withRejected }).reason, 'rejected-before');
});

test('全部通过的正常候选词 → 放行', () => {
  const r = canLearnKeyword({
    word: '清掉业务表',
    action: ACTION,
    otherActions: OTHERS,
    sourceText: '帮我把 test 的清掉业务表吧',
  });
  assert.deepEqual(r, { ok: true, reason: '' });
});

test('空词 / 空白词 → 拒', () => {
  assert.equal(canLearnKeyword({ word: '  ', action: ACTION, sourceText: 'x' }).reason, 'empty');
});

test('脏数据防御：keywords / rejectedKeywords / autoKeywords 不是数组时不抛异常', () => {
  // action-configs.json 无 schema 校验，配置导入等路径可能带进字符串。
  // 用 `|| []` 兜不住（非空字符串是 truthy），而字符串可迭代 —— 规则 5 的 for...of
  // 会逐字符比对，把整词冲突检测静默降级成单字符匹配，比抛异常更难发现。
  const dirty = { id: 'ac_dirty', keywords: '清一下', autoKeywords: '不是数组', rejectedKeywords: '也不是' };
  assert.doesNotThrow(() => canLearnKeyword({
    word: '清掉业务表',
    action: dirty,
    otherActions: OTHERS,
    sourceText: '帮我清掉业务表',
  }));
});

test('脏数据防御：其他动作的 keywords 是字符串时不做单字符降级匹配', () => {
  // 「清」是字符串 '清理缓存' 的一个字符。若被逐字符遍历，候选词「清掉业务表」
  // 会因为含「清」而被误判成冲突 —— 该放行的被拦掉，且原因完全看不出来。
  const dirtyOther = [{ id: 'ac_dirty', keywords: '清理缓存' }];
  const r = canLearnKeyword({
    word: '清掉业务表',
    action: ACTION,
    otherActions: dirtyOther,
    sourceText: '帮我清掉业务表',
  });
  assert.equal(r.ok, true, '非数组的 keywords 应被当成空，而不是逐字符比对');
});

test('归一化在起作用：大小写不同也算冲突（防日后被「优化」成大小写敏感）', () => {
  // norm() 做 toLowerCase 是**刻意判得更严**：宁可误杀几个其实不冲突的候选，
  // 也不要因大小写差异漏判真实冲突。没有这条用例，把 norm 退化成严格相等测试不会红。
  const r = canLearnKeyword({
    word: 'Reset-DB',
    action: ACTION,
    otherActions: [{ id: 'ac_db', keywords: ['reset-db'] }],
    sourceText: '帮我 Reset-DB 一下',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'conflict:ac_db');
});
