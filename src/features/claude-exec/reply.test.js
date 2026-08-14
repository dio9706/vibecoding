import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExecReply, splitForFeishu, splitForMarkdownCard, FEISHU_TEXT_MAX, FEISHU_CARD_MAX } from './reply.js';

/**
 * 背景（两个独立缺陷叠在同一行 `await reply(buf || '(无输出)')`）：
 *
 * 1. **失败被当成功**：integrations/claude.js 对非 success 的 result 一律给空串
 *    （`result: message.subtype === 'success' ? message.result : ''`），
 *    而 onResult 里只有 `if (!buf && i.result) buf = i.result`，is_error 完全被丢掉。
 *    于是限流终止 / error_max_turns / 权限失败这些「不抛异常但失败了」的情况，
 *    用户收到的是「(无输出)」—— 看起来像正常执行完但没说话。
 *
 * 2. **长回复整条丢失**：无长度截断，超过飞书文本消息上限时 sendText 直接抛错，
 *    catch 里的 `reply('执行出错：…')` 往往因同一原因再次失败 → 冒泡到静默路径。
 *    对照：project-qa 有 ANSWER_MAX=1800、task-triage 有 PLAN_MAX=2500，唯独这里没有。
 */

// ── buildExecReply ─────────────────────────────────────────────

test('buildExecReply：成功且有输出 → 原样返回', () => {
  assert.equal(buildExecReply({ text: '改好了', isError: false, subtype: 'success' }), '改好了');
});

test('buildExecReply：成功但无输出 → 沿用「(无输出)」', () => {
  assert.equal(buildExecReply({ text: '', isError: false, subtype: 'success' }), '(无输出)');
});

test('buildExecReply：失败且无输出 → 必须是明确的失败说明，不能是「(无输出)」（核心回归）', () => {
  const r = buildExecReply({ text: '', isError: true, subtype: 'error_during_execution' });
  assert.notEqual(r, '(无输出)');
  assert.match(r, /失败|出错|未完成/);
});

test('buildExecReply：失败但有部分输出 → 保留输出并明确标注未正常完成', () => {
  const r = buildExecReply({ text: '已经改了一半', isError: true, subtype: 'error_during_execution' });
  assert.match(r, /已经改了一半/, '部分输出不能丢');
  assert.match(r, /失败|出错|未完成/, '必须让用户知道这次没成');
});

test('buildExecReply：达到轮次上限时给出可操作的提示', () => {
  const r = buildExecReply({ text: '', isError: true, subtype: 'error_max_turns' });
  assert.match(r, /轮次|步数|上限/);
});

test('buildExecReply：缺省参数不抛异常', () => {
  assert.equal(typeof buildExecReply({}), 'string');
  assert.equal(typeof buildExecReply(), 'string');
});

// ── splitForFeishu ─────────────────────────────────────────────

test('splitForFeishu：短文本单片返回', () => {
  assert.deepEqual(splitForFeishu('短消息'), ['短消息']);
});

test('splitForFeishu：空文本返回空数组', () => {
  assert.deepEqual(splitForFeishu(''), []);
  assert.deepEqual(splitForFeishu(null), []);
});

test('splitForFeishu：超长文本被切成多片，每片不超过上限', () => {
  const long = 'a'.repeat(FEISHU_TEXT_MAX * 3 + 100);
  const parts = splitForFeishu(long);
  assert.ok(parts.length >= 4, `应切成多片，实际 ${parts.length} 片`);
  for (const p of parts) assert.ok(p.length <= FEISHU_TEXT_MAX, `有片超过上限：${p.length}`);
});

test('splitForFeishu：不丢字符（拼回来等于原文）', () => {
  const long = '中文内容'.repeat(2000);
  assert.equal(splitForFeishu(long).join(''), long);
});

test('splitForFeishu：优先在换行处断开（不把一行劈两半）', () => {
  const line = 'x'.repeat(100);
  const text = Array.from({ length: 40 }, () => line).join('\n'); // 约 4040 字符
  const parts = splitForFeishu(text);
  assert.ok(parts.length > 1);
  // 除最后一片外，都应以完整行收尾
  for (const p of parts.slice(0, -1)) {
    assert.ok(p.endsWith('\n') || p.endsWith(line), `在行中间断开了：…${p.slice(-20)}`);
  }
});

test('splitForFeishu：单行超长（无换行可断）时仍能硬切，不死循环', () => {
  const parts = splitForFeishu('b'.repeat(FEISHU_TEXT_MAX * 2 + 7));
  assert.ok(parts.length >= 3);
  assert.equal(parts.join(''), 'b'.repeat(FEISHU_TEXT_MAX * 2 + 7));
});

test('FEISHU_TEXT_MAX：是个保守的有限值（飞书文本约 2000 上限）', () => {
  assert.ok(FEISHU_TEXT_MAX > 0 && FEISHU_TEXT_MAX <= 2000);
});

// ── splitForMarkdownCard ────────────────────────────────────────

test('splitForMarkdownCard：短文本单片返回', () => {
  assert.deepEqual(splitForMarkdownCard('# 标题\n\n这是正文'), ['# 标题\n\n这是正文']);
});

test('splitForMarkdownCard：空文本返回空数组', () => {
  assert.deepEqual(splitForMarkdownCard(''), []);
  assert.deepEqual(splitForMarkdownCard(null), []);
});

test('splitForMarkdownCard：超长文本被切成多片，每片不超过上限', () => {
  const long = 'a'.repeat(FEISHU_CARD_MAX * 3 + 100);
  const parts = splitForMarkdownCard(long);
  assert.ok(parts.length >= 4, `应切成多片，实际 ${parts.length} 片`);
  for (const p of parts) assert.ok(p.length <= FEISHU_CARD_MAX, `有片超过上限：${p.length}`);
});

test('splitForMarkdownCard：不丢字符（拼回来等于原文）', () => {
  const long = '## 标题\n\n段落内容\n\n'.repeat(2000);
  assert.equal(splitForMarkdownCard(long).join(''), long);
});

test('splitForMarkdownCard：优先在双换行（段落分界）处断开', () => {
  // 构造有明显段落标记的文本，使得能在 \n\n 处找到切点
  const para = '# 标题\n\n' + 'x'.repeat(4000) + '\n\n';
  const text = para.repeat(10); // 文本足够大超过 CARD_MAX
  const parts = splitForMarkdownCard(text);
  assert.ok(parts.length > 1, `文本长度 ${text.length} 应切成多片`);
  // 检验：切分后各片应该能找回来，且不是硬切在中间的
  const combined = parts.join('');
  assert.equal(combined, text, '切分后拼回应等于原文');
  // 检验：至少有些片以段落分界结尾（说明算法识别到了双换行）
  const withParagraphEnd = parts.filter((p) => p.endsWith('\n\n')).length;
  assert.ok(withParagraphEnd > 0, `应至少有些片在 \\n\\n 处断开，实际 ${withParagraphEnd}/${parts.length}`);
});

test('splitForMarkdownCard：双换行不找到时，退而其次在单换行处断开', () => {
  const text = 'line 1\nline 2\nline 3'.repeat(10000); // 无 \n\n
  const parts = splitForMarkdownCard(text);
  assert.ok(parts.length > 1);
  // 除最后一片外，都应以 \n 结尾
  for (const p of parts.slice(0, -1)) {
    const hasNewline = p.endsWith('\n');
    const beforeFinalNewline = p.slice(0, -1);
    const noMoreNewlines = !beforeFinalNewline.includes('\n');
    // 如果有换行，优先选在换行处；也有可能是硬切（单行超长且没换行）
    assert.ok(hasNewline || noMoreNewlines, `应在换行处或硬切，实际 ${p.slice(-30)}`);
  }
});

test('splitForMarkdownCard：单行超长（无换行）时仍能硬切，不死循环', () => {
  const parts = splitForMarkdownCard('x'.repeat(FEISHU_CARD_MAX * 2 + 7));
  assert.ok(parts.length >= 3);
  assert.equal(parts.join(''), 'x'.repeat(FEISHU_CARD_MAX * 2 + 7));
});

test('FEISHU_CARD_MAX：是个保守的有限值（飞书卡片约 30KB 上限）', () => {
  assert.ok(FEISHU_CARD_MAX > 0 && FEISHU_CARD_MAX <= 30000);
});
