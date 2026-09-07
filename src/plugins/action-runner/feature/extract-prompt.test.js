import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildExtractPrompt } from './extract-prompt.js';
import { resolveVariable } from './var-contract.js';

const rv = (v) => resolveVariable(v);

describe('buildExtractPrompt', () => {
  /**
   * 旧实现只有当变量恰好叫 `env` 时才把候选值写进提示词，别的变量只得到 `name=label`。
   * 模型不知道合法值，抽出的自然是中文原值（action-log.jsonl 有实证 {"env":"正式版"}），
   * 而脚本 argparse choices 只认规范值。这条断言守住「约束段与变量名无关」。
   */
  it('enum 变量给出合法值与别名映射 —— 与变量名无关', () => {
    for (const name of ['env', 'region', '机房']) {
      const p = buildExtractPrompt(
        [rv({ name, label: '机房', enum: ['sh', 'bj'], aliases: { 上海: 'sh', 沪: 'sh', 北京: 'bj' } })],
        'x',
      );
      assert.match(p, /只能取 sh \/ bj 之一/);
      assert.match(p, /上海·沪 → sh/);
      assert.match(p, /北京 → bj/);
    }
  });

  it('别名按规范值分组，不逐条罗列', () => {
    const p = buildExtractPrompt([rv({ name: 'x', enum: ['a'], aliases: { 甲: 'a', 乙: 'a' } })], 't');
    assert.match(p, /甲·乙 → a/);
  });

  it('别名与规范值同名时不列（`dev → dev` 是噪音）', () => {
    const p = buildExtractPrompt([rv({ name: 'env', preset: 'env' })], 't');
    assert.equal(/dev → dev/.test(p), false);
    assert.match(p, /体验版/, 'preset 里真正的别名仍要列出来');
  });

  it('weakAliases 在提示词里也列出（模型有整句上下文，不存在裸词歧义）', () => {
    const p = buildExtractPrompt([rv({ name: 'env', preset: 'env' })], 't');
    assert.match(p, /测试/);
  });

  it('pattern 变量给出格式要求', () => {
    const p = buildExtractPrompt([rv({ name: 'phone', label: '手机号', preset: 'phone' })], 't');
    assert.match(p, /需匹配格式/);
    assert.match(p, /13800138000/, 'preset 的 example 要带上');
  });

  it('自由文本变量说明原样提取', () => {
    const p = buildExtractPrompt([rv({ name: 'note', label: '备注' })], 't');
    assert.match(p, /自由文本，原样提取/);
  });

  it('「不要猜」的硬指令必须在（漏抽只是多问一句，猜错是清错环境）', () => {
    assert.match(buildExtractPrompt([rv({ name: 'x' })], 't'), /省略该字段，不要猜/);
  });

  it('用户消息被带上', () => {
    assert.match(buildExtractPrompt([rv({ name: 'x' })], '帮我清一下 test'), /帮我清一下 test/);
  });

  it('只列传入的字段 —— 本地已抽好的不出现（省 token，也防模型改写已定值）', () => {
    const p = buildExtractPrompt([rv({ name: 'phone', preset: 'phone' })], 't');
    assert.equal(/env/.test(p), false);
  });

  it('别名过多时截断，不把提示词撑爆', () => {
    const aliases = {};
    for (let i = 0; i < 50; i += 1) aliases[`别名${i}`] = 'a';
    const p = buildExtractPrompt([rv({ name: 'x', enum: ['a'], aliases })], 't');
    assert.ok(p.length < 800, `提示词 ${p.length} 字符，别名截断没生效`);
  });

  it('空列表与空文本不炸', () => {
    assert.equal(typeof buildExtractPrompt([], ''), 'string');
    assert.equal(typeof buildExtractPrompt(null, null), 'string');
  });
});
