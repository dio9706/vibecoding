import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveVariable, validateVariable, validateActionVariables } from './var-contract.js';

describe('resolveVariable —— preset 展开', () => {
  it('preset 提供默认值', () => {
    const rv = resolveVariable({ name: 'env', preset: 'env' });
    assert.deepEqual(rv.enum, ['dev', 'test', 'prod']);
    assert.equal(rv.aliases['体验版'], 'test');
    assert.equal(rv.weakAliases['测试'], 'test');
    assert.equal(rv.kind, 'enum');
  });

  /**
   * 浅覆盖而非深合并 —— 深合并下「我想删掉 preset 里的某个别名」无法表达（写什么都只会新增）。
   * 这条断言把语义钉死，免得日后有人「顺手改成深合并」。
   */
  it('显式 aliases 整体覆盖 preset 的同名字段，不做深合并', () => {
    const rv = resolveVariable({ name: 'env', preset: 'env', aliases: { 甲: 'dev' } });
    assert.deepEqual(Object.keys(rv.aliases), ['甲']);
    assert.equal(rv.aliases['体验版'], undefined, 'preset 的别名必须被整体替换掉');
    assert.deepEqual(rv.enum, ['dev', 'test', 'prod'], '没被覆盖的字段仍来自 preset');
  });

  it('不用 preset 手写 enum/aliases 完全等价', () => {
    const a = resolveVariable({ name: 'x', enum: ['sh'], aliases: { 上海: 'sh' } });
    assert.equal(a.kind, 'enum');
    assert.equal(a.aliases['上海'], 'sh');
  });

  it('phone preset 是 pattern 档', () => {
    const rv = resolveVariable({ name: 'phone', preset: 'phone' });
    assert.equal(rv.kind, 'pattern');
    assert.equal(rv.pattern.startsWith('^'), false, 'pattern 不得带锚点（抽取要靠它 matchAll）');
  });

  it('无任何声明 = 自由文本', () => {
    assert.equal(resolveVariable({ name: 'note' }).kind, 'free');
  });

  it('未知 preset 不炸，退化为自由文本（校验层负责拒绝保存）', () => {
    assert.equal(resolveVariable({ name: 'x', preset: '不存在' }).kind, 'free');
  });

  it('配置读坏（aliases 是数组/字符串/null）不得让下游在 Object.entries 上炸', () => {
    for (const bad of [[], 'x', null, 42]) {
      const rv = resolveVariable({ name: 'x', enum: ['a'], aliases: bad });
      assert.deepEqual(rv.aliases, {});
    }
  });

  /**
   * junk 会被拼进 `new RegExp(rv.junk, 'g')`。若允许变量声明覆盖它，
   * 保存一条 `junk: "["` 就等于让这个动作每次抽取都抛异常。它既不在表单里、
   * 也没有自定义场景 —— 只允许来自 preset。
   */
  it('junk 不可被变量声明覆盖（只能来自 preset）', () => {
    const rv = resolveVariable({ name: 'env', preset: 'env', junk: '[' });
    assert.notEqual(rv.junk, '[');
    assert.equal(rv.junk, resolveVariable({ name: 'env', preset: 'env' }).junk);
  });

  it('无 preset 时 junk 为 null，不会凭空冒出一个正则', () => {
    assert.equal(resolveVariable({ name: 'x', enum: ['a'], junk: '.*' }).junk, null);
  });

  it('入参本身是 null/undefined 也不炸', () => {
    assert.equal(resolveVariable(null).kind, 'free');
    assert.equal(resolveVariable(undefined).name, '');
  });
});

describe('validateVariable —— 保存时拦，不静默修正', () => {
  it('合法声明返回 null', () => {
    assert.equal(validateVariable({ name: 'env', preset: 'env' }), null);
    assert.equal(validateVariable({ name: 'x', enum: ['a', 'b'], aliases: { 甲: 'a' } }), null);
    assert.equal(validateVariable({ name: 'p', pattern: '\\d{4}' }), null);
  });

  it('enum 与 pattern 互斥', () => {
    const err = validateVariable({ name: 'x', enum: ['a'], pattern: '\\d+' });
    assert.match(err, /不能同时声明/);
  });

  it('未知 preset 被拒（静默忽略会让用户以为生效了）', () => {
    assert.match(validateVariable({ name: 'x', preset: 'date' }), /不存在/);
  });

  /**
   * 别名映射到 enum 之外的值，会归一出脚本 argparse 不认识的东西 ——
   * 用户看到的是一坨 argparse 报错而不是一句人话。必须在保存时就拦。
   */
  it('别名的值必须落在 enum 内', () => {
    const err = validateVariable({ name: 'x', enum: ['a'], aliases: { 甲: 'zzz' } });
    assert.match(err, /不在合法值/);
  });

  it('声明了别名却没有 enum → 别名无处可映射', () => {
    assert.match(validateVariable({ name: 'x', aliases: { 甲: 'a' } }), /没有合法值/);
  });

  it('pattern 带锚点被拒（会让抽取永远匹配不到自由文本）', () => {
    assert.match(validateVariable({ name: 'p', pattern: '^\\d{4}$' }), /去掉首尾锚点/);
    assert.match(validateVariable({ name: 'p', pattern: '\\d{4}$' }), /去掉首尾锚点/);
  });

  it('无法编译的 pattern 被拒', () => {
    assert.match(validateVariable({ name: 'p', pattern: '[unclosed' }), /无法编译/);
  });

  it('enum 必须是非空字符串数组', () => {
    assert.match(validateVariable({ name: 'x', enum: [] }), /非空数组/);
    assert.match(validateVariable({ name: 'x', enum: ['a', ''] }), /非空字符串/);
  });

  it('空别名键被拒', () => {
    assert.match(validateVariable({ name: 'x', enum: ['a'], aliases: { '  ': 'a' } }), /空别名/);
  });

  it('错误串里带变量 label，用户能定位是哪一条', () => {
    const err = validateVariable({ name: 'x', label: '机房', enum: ['a'], pattern: 'b' });
    assert.match(err, /机房/);
  });
});

describe('validateActionVariables', () => {
  it('没有 variables 字段 = 本次不涉及，放行', () => {
    assert.equal(validateActionVariables({}), null);
    assert.equal(validateActionVariables({ variables: null }), null);
  });

  it('variables 非数组被拒', () => {
    assert.match(validateActionVariables({ variables: 'x' }), /必须是数组/);
  });

  it('返回第一条错误', () => {
    const err = validateActionVariables({
      variables: [{ name: 'ok', preset: 'env' }, { name: 'bad', preset: '不存在' }],
    });
    assert.match(err, /不存在/);
  });
});

// —————— 2026-09-04 对抗式复核回归 ——————

describe('回归：preset 别名必须与收窄后的 enum 对账（复核 h1）', () => {
  it('preset=env + 合法值收窄成 dev/test → 保存必须报错', () => {
    // 这条路径 Web 表单直接可达：选预置 env，再把「合法值」填成 dev, test。
    // 旧实现只校验 v.aliases（此处 undefined，直接 continue）→ 放行 →
    // 运行时「正式环境」仍被映射成 prod，即运维刻意要禁掉的那个值。
    const err = validateVariable({ name: 'env', label: '环境', preset: 'env', enum: ['dev', 'test'] });
    assert.ok(err, '必须报错');
    assert.match(err, /预置/, '错误文案要指明冲突来自预置');
    assert.match(err, /展开预置为可编辑/, '要告诉用户怎么解决');
  });

  it('完全不相交的 enum 同样拦下', () => {
    assert.ok(validateVariable({ name: 'env', preset: 'env', enum: ['a', 'b'] }));
  });

  it('只加不减（enum 是 preset 的超集）不受影响', () => {
    assert.equal(validateVariable({ name: 'env', preset: 'env', enum: ['dev', 'test', 'prod', 'staging'] }), null);
  });

  it('只覆盖 aliases 不够 —— preset 的 weakAliases 仍在冲突，必须一起覆盖', () => {
    // 浅覆盖是**按字段**独立的：写了 aliases 只替换 aliases，weakAliases 仍来自 preset
    //（env preset 的 weakAliases 里有「正式 → prod」）。这条锐边是有意的 ——
    // 要彻底脱离 preset 就得两个表都给，Web 表单的「展开预置为可编辑」正是干这件事。
    const onlyAliases = validateVariable({
      name: 'env', preset: 'env', enum: ['dev', 'test'], aliases: { 开发版: 'dev' },
    });
    assert.ok(onlyAliases, '只覆盖 aliases 时仍应报错');
    assert.match(onlyAliases, /正式|prod/);

    const both = validateVariable({
      name: 'env', preset: 'env', enum: ['dev', 'test'],
      aliases: { 开发版: 'dev', 体验版: 'test' },
      weakAliases: { 开发: 'dev', 测试: 'test' },
    });
    assert.equal(both, null, '两个表都覆盖后应放行');
  });

  it('脏声明 aliases: 42 不得被 plainObject 兜底后静默放过', () => {
    assert.ok(validateVariable({ name: 'x', enum: ['a'], aliases: 42 }));
  });
});
