/**
 * 上下文压缩纯函数单测（T7）：切点边界安全 / 触发口径 / 转录格式化 / 滚动摘要 prompt / system 组装。
 * 切点与序列合法性是「可能直接 400」的防线，正反例都要钉。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPACT_TRIGGER,
  COMPACT_KEEP_RECENT,
  COMPACT_MIN_DROP,
  MAX_SUMMARY_CHARS,
  dropLeadingOrphans,
  shouldCompact,
  pickCompactCut,
  formatMessagesForSummary,
  buildSummaryPrompt,
  normalizeSummaryText,
  composeSystemWithSummary,
} from './conv-compact.logic.js';

const user = (t = 'u') => ({ role: 'user', content: t });
const asst = (t = 'a') => ({ role: 'assistant', content: t });
const tool = (t = 'tool-out') => ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'Read', output: { type: 'text', value: t } }] });

test('dropLeadingOrphans：剔除头部 tool 结果；assistant 开头的合法序列不动', () => {
  const orphan = [tool(), tool(), user(), asst()];
  assert.deepEqual(dropLeadingOrphans(orphan).map((m) => m.role), ['user', 'assistant']);
  const legal = [asst(), tool(), user()];
  assert.equal(dropLeadingOrphans(legal), legal, '原引用返回（无孤儿零开销）');
  assert.deepEqual(dropLeadingOrphans([]), []);
  assert.deepEqual(dropLeadingOrphans(null), []);
  assert.deepEqual(dropLeadingOrphans([tool()]), [], '全是孤儿 → 空');
});

test('shouldCompact：模型可见长度（总−已覆盖）超阈值才触发', () => {
  assert.equal(shouldCompact({ total: COMPACT_TRIGGER }), false);
  assert.equal(shouldCompact({ total: COMPACT_TRIGGER + 1 }), true);
  assert.equal(shouldCompact({ total: 500, covered: 300 }), false, '已覆盖部分不计入可见长度');
  assert.equal(shouldCompact({ total: 500, covered: 200 }), true);
  assert.equal(shouldCompact({}), false);
});

test('pickCompactCut：保留段从 user 边界开始（不切 tool 序列）；下限与 minDrop 双重约束', () => {
  // 260 条：交替 user/assistant；切点 = 最近 ≤ 260-100=160 的 user
  const msgs = Array.from({ length: 260 }, (_, i) => (i % 2 ? asst('a' + i) : user('u' + i)));
  const cut = pickCompactCut(msgs, {});
  assert.ok(cut > 0 && cut <= 160);
  assert.equal(msgs[cut].role, 'user', '切点必须是整轮边界');
  assert.ok(cut >= COMPACT_MIN_DROP);

  // 保留段尾部是 tool 序列：从 maxCut 向前回退到最近的 user
  const withTail = [...msgs.slice(0, 150), user('u150'), asst('a151'), tool(), tool(), tool(), tool(), tool()];
  const cut2 = pickCompactCut(withTail, {});
  assert.equal(withTail[cut2].role, 'user');

  // 找不到 user 边界（全是 assistant/tool）→ -1
  assert.equal(pickCompactCut([...Array.from({ length: 250 }, () => asst()), tool()], {}), -1);
  // 新丢条数不足 minDrop → -1
  assert.equal(pickCompactCut(msgs, { covered: cut - (COMPACT_MIN_DROP - 1) }), -1, '新增可丢太少不压');
  // 长度不足 keepRecent → -1
  assert.equal(pickCompactCut(Array.from({ length: 50 }, () => user()), {}), -1);
  // covered 已越过 maxCut（视图很短）→ -1 或安全切点，不得小于 covered
  const late = pickCompactCut(msgs, { covered: 159 });
  assert.ok(late === -1 || late >= 159);
});

test('formatMessagesForSummary：角色标签、tool 输出提取、单条与总量截断', () => {
  const msgs = [
    user('把按钮改蓝'),
    asst([{ type: 'text', text: '好的' }, { type: 'tool-call', toolName: 'Edit', input: { file_path: 'a.vue' } }]),
    tool('已编辑 a.vue'),
    { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(5000) }] },
  ];
  const text = formatMessagesForSummary(msgs, { perMessageChars: 100, budgetChars: 500 });
  assert.match(text, /【用户】把按钮改蓝/);
  assert.match(text, /\[调用 Edit\]/);
  assert.match(text, /【工具结果】\[结果\] 已编辑 a\.vue/);
  assert.ok(text.length <= 600, `总量应被截断：${text.length}`);

  assert.equal(formatMessagesForSummary([]), '');
  assert.equal(formatMessagesForSummary(null), '');
});

test('buildSummaryPrompt：旧摘要参与滚动合并；输出单一摘要的指令在场', () => {
  const p = buildSummaryPrompt({ previousSummary: '早前：用户在改登录', droppedText: '【用户】现在改支付' });
  assert.match(p, /【已有摘要（覆盖更早的对话）】[\s\S]*改登录/);
  assert.match(p, /【新增需要并入摘要的对话】[\s\S]*改支付/);
  assert.match(p, /单一摘要/);

  const only = buildSummaryPrompt({ droppedText: 'x' });
  assert.ok(!only.includes('已有摘要'));
});

test('normalizeSummaryText / composeSystemWithSummary：截断与 system 挂载；空摘要不产生空段', () => {
  const long = normalizeSummaryText('x'.repeat(MAX_SUMMARY_CHARS + 100));
  assert.ok(long.length <= MAX_SUMMARY_CHARS + 40, '超长摘要被头尾截断');
  assert.match(long, /略 \d+ 字符/);

  const sys = composeSystemWithSummary('主提示词', ' 要点一\n要点二 ');
  assert.match(sys, /^主提示词\n\n## 历史摘要/);
  assert.match(sys, /要点一/);
  assert.equal(composeSystemWithSummary('主提示词', ''), '主提示词', '无摘要时原样返回');
  assert.equal(composeSystemWithSummary('主提示词', null), '主提示词');
});
