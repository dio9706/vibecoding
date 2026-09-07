import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAliasLines, formatAliasLines, buildVarDecl } from './actions-panel.logic.js';

describe('parseAliasLines', () => {
  it('逐行解析 别名=值', () => {
    assert.deepEqual(parseAliasLines('上海=sh\n北京=bj'), { 上海: 'sh', 北京: 'bj' });
  });

  it('空行 / 缺 = / 键或值为空的行一律跳过（文本框里留空行是常态）', () => {
    assert.deepEqual(parseAliasLines('上海=sh\n\n乱写\n=bj\n沪=\n  \n'), { 上海: 'sh' });
  });

  it('值里含 = 不被截断（用 indexOf 而非 split）', () => {
    assert.deepEqual(parseAliasLines('k=a=b'), { k: 'a=b' });
  });

  it('两侧空白被 trim', () => {
    assert.deepEqual(parseAliasLines('  上海  =  sh  '), { 上海: 'sh' });
  });

  it('空/非字符串输入返回空对象，不炸', () => {
    for (const bad of ['', null, undefined]) assert.deepEqual(parseAliasLines(bad), {});
  });

  it('与 formatAliasLines 互为逆', () => {
    const o = { 上海: 'sh', 北京: 'bj' };
    assert.deepEqual(parseAliasLines(formatAliasLines(o)), o);
  });

  it('formatAliasLines 对空/null 返回空串', () => {
    assert.equal(formatAliasLines(null), '');
    assert.equal(formatAliasLines({}), '');
  });
});

describe('buildVarDecl —— 空字段必须省略', () => {
  const base = { name: 'env', label: '环境', prompt: '哪个环境？', required: true, persistent: false };

  /**
   * 这是最关键的一条：preset 合并是**浅覆盖**（见 var-contract.js）。
   * 传 `aliases: {}` 会把预置的整张别名表覆盖成空，用户只是没填却导致预置静默失效。
   */
  it('规则全部留空时，声明里不出现 enum/aliases/weakAliases/pattern/example', () => {
    const d = buildVarDecl({ ...base, preset: 'env' });
    assert.deepEqual(Object.keys(d).sort(), ['label', 'name', 'preset', 'prompt', 'persistent', 'required'].sort());
    assert.equal('aliases' in d, false);
    assert.equal('enum' in d, false);
  });

  it('preset 为空串时也不出现 preset 键', () => {
    assert.equal('preset' in buildVarDecl({ ...base, preset: '' }), false);
  });

  it('enum 逗号分隔并剔空', () => {
    assert.deepEqual(buildVarDecl({ ...base, enumText: ' sh , , bj ' }).enum, ['sh', 'bj']);
  });

  it('enum 只填了逗号/空白 → 不产出 enum 键（空数组会被后端判非法）', () => {
    assert.equal('enum' in buildVarDecl({ ...base, enumText: ' , , ' }), false);
  });

  it('别名与歧义别名分别落位', () => {
    const d = buildVarDecl({ ...base, aliasesText: '上海=sh', weakAliasesText: '南方=sz' });
    assert.deepEqual(d.aliases, { 上海: 'sh' });
    assert.deepEqual(d.weakAliases, { 南方: 'sz' });
  });

  it('pattern / example 两侧空白被 trim，纯空白视为未填', () => {
    assert.equal(buildVarDecl({ ...base, pattern: '  \\d+  ' }).pattern, '\\d+');
    assert.equal('pattern' in buildVarDecl({ ...base, pattern: '   ' }), false);
    assert.equal('example' in buildVarDecl({ ...base, example: '  ' }), false);
  });

  it('复选框归一为布尔（DOM 给的是 truthy 值）', () => {
    const d = buildVarDecl({ name: 'x', required: 1, persistent: 0 });
    assert.equal(d.required, true);
    assert.equal(d.persistent, false);
  });

  it('缺字段不产出 undefined（后端会把 undefined 当成显式声明）', () => {
    const d = buildVarDecl({});
    assert.equal(d.name, '');
    assert.equal(d.label, '');
    assert.equal(d.prompt, '');
  });
});

// —————— 2026-09-04 对抗式复核回归（m5：展开预置后空值必须如实下发）——————

describe('buildVarDecl —— expanded 标记', () => {
  const base = { name: 'env', label: '环境', required: true, preset: 'env' };

  it('未展开时空字段一律省略（避免把预置浅覆盖成空）', () => {
    const d = buildVarDecl({ ...base, enumText: '', aliasesText: '', pattern: '' });
    assert.equal('enum' in d, false);
    assert.equal('aliases' in d, false);
    assert.equal('pattern' in d, false);
    assert.equal(d.preset, 'env');
  });

  it('展开后清空 = 明确要删掉，必须如实下发（否则用户永远删不掉）', () => {
    const d = buildVarDecl({ ...base, expanded: true, enumText: '', aliasesText: '', weakAliasesText: '' });
    assert.equal(d.enum, null, 'enum 用 null 而非 []，否则撞上「必须是非空数组」的校验');
    assert.deepEqual(d.aliases, {});
    assert.deepEqual(d.weakAliases, {});
    assert.equal(d.pattern, '');
  });

  it('展开后仍保留 preset —— junk 只能来自预置，清掉会静默丢失尾巴词剥离', () => {
    const d = buildVarDecl({ ...base, expanded: true, enumText: 'dev, test' });
    assert.equal(d.preset, 'env');
    assert.deepEqual(d.enum, ['dev', 'test']);
  });
});
