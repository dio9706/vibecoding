import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { localExtract, normalizeValue } from './local-extract.js';
import { resolveVariable } from './var-contract.js';

const ENV = { name: 'env', label: '环境', required: true, preset: 'env' };
const PHONE = { name: 'phone', label: '手机号', required: true, preset: 'phone' };

describe('normalizeValue', () => {
  const rv = resolveVariable(ENV);

  it('enum 成员与别名都归一到规范值', () => {
    assert.equal(normalizeValue(rv, 'test'), 'test');
    assert.equal(normalizeValue(rv, '体验版'), 'test');
    assert.equal(normalizeValue(rv, '正式版'), 'prod');
  });

  it('大小写与空白', () => {
    assert.equal(normalizeValue(rv, 'TEST'), 'test');
    assert.equal(normalizeValue(rv, ' Prod '), 'prod');
  });

  it('剥掉被一起抽出来的尾巴词', () => {
    assert.equal(normalizeValue(rv, '正式版二维码'), 'prod');
    assert.equal(normalizeValue(rv, '体验版的'), 'test');
    assert.equal(normalizeValue(rv, '开发版环境'), 'dev');
  });

  it('weak 档才认歧义裸词', () => {
    assert.equal(normalizeValue(rv, '测试'), null);
    assert.equal(normalizeValue(rv, '测试', { weak: true }), 'test');
  });

  it('识别不了一律 null（绝不瞎猜）', () => {
    assert.equal(normalizeValue(rv, '预发布'), null);
    assert.equal(normalizeValue(rv, ''), null);
    assert.equal(normalizeValue(rv, null), null);
  });

  it('pattern 档做全串校验（自动加锚点）', () => {
    const p = resolveVariable(PHONE);
    assert.equal(normalizeValue(p, '15901039503'), '15901039503');
    assert.equal(normalizeValue(p, '123'), null);
    assert.equal(normalizeValue(p, 'a15901039503b'), null, '必须全串匹配，不能子串命中');
  });

  it('自由文本原样采纳', () => {
    assert.equal(normalizeValue(resolveVariable({ name: 'n' }), ' 随便 '), '随便');
  });
});

describe('localExtract —— 分档与 unresolved', () => {
  it('enum/pattern 本地抽出，free 进 unresolved', () => {
    const { values, unresolved } = localExtract(
      [ENV, PHONE, { name: 'note', required: true }],
      '清一下 test 的 15901039503',
    );
    assert.deepEqual(values, { env: 'test', phone: '15901039503' });
    assert.deepEqual(unresolved.map((r) => r.name), ['note']);
  });

  it('抽不到的 enum 也进 unresolved（交给 LLM 或追问）', () => {
    const { values, unresolved } = localExtract([ENV], '帮我清一下数据');
    assert.deepEqual(values, {});
    assert.deepEqual(unresolved.map((r) => r.name), ['env']);
  });

  it('无名变量被跳过，不产生 undefined 键', () => {
    const { values, unresolved } = localExtract([{ required: true }, ENV], 'test');
    assert.deepEqual(Object.keys(values), ['env']);
    assert.equal(unresolved.length, 0);
  });

  it('variables 为空/非数组不炸', () => {
    assert.deepEqual(localExtract([], 'x').values, {});
    assert.deepEqual(localExtract(null, 'x').values, {});
  });
});

describe('扫描正则的生成规则', () => {
  it('长词优先：development 不被 dev 截断', () => {
    assert.equal(localExtract([ENV], 'the development build').values.env, 'dev');
  });

  it('ASCII 候选带词边界：devil 不得命中 dev', () => {
    assert.equal(localExtract([ENV], 'that is devilish').values.env, undefined);
  });

  it('中文候选不加词边界（中文无词边界，加了反而匹配不上）', () => {
    assert.equal(localExtract([ENV], '请把体验版的码发我').values.env, 'test');
  });

  it('别名里的正则元字符被转义，不当成正则解释', () => {
    const v = { name: 'x', required: true, enum: ['a'], aliases: { 'c++': 'a' } };
    assert.equal(localExtract([v], '我要 c++ 的').values.x, 'a');
    assert.equal(localExtract([v], '我要 cccc 的').values.x, undefined);
  });

  it('候选过多时放弃本地扫描（交给 LLM），不拖慢用户等回复的路径', () => {
    const many = {};
    for (let i = 0; i < 300; i += 1) many[`别名${i}`] = 'a';
    const v = { name: 'x', required: true, enum: ['a'], aliases: many };
    const { values, unresolved } = localExtract([v], '别名7');
    assert.deepEqual(values, {});
    assert.deepEqual(unresolved.map((r) => r.name), ['x']);
  });

  /**
   * 回溯护栏。intent.js 的 CHITCHAT_RE 曾因 `^(?:a|b|…)+$` 里那个 `+` 触发斐波那契级回溯，
   * 'bye'.repeat(44) 要 87 秒并占死整个事件循环。这里的扫描正则**不带外层量词**，
   * 交替分支对 matchAll 是线性的。用一份「候选可由其他候选拼出」的恶意词表 + 4KB 输入钉住。
   */
  it('恶意词表 + 4KB 输入必须瞬间返回（不得回归成带量词的正则）', () => {
    const v = {
      name: 'x',
      required: true,
      enum: ['a'],
      aliases: { ab: 'a', abab: 'a', ababab: 'a', b: 'a', ba: 'a' },
    };
    const text = 'ab'.repeat(2048); // 4KB
    const t0 = Date.now();
    localExtract([v], text);
    const ms = Date.now() - t0;
    assert.ok(ms < 1000, `扫描耗时 ${ms}ms，疑似引入了灾难性回溯`);
  });
});

describe('弃权规则（泛化到任意 enum/pattern 变量）', () => {
  const REGION = {
    name: 'region',
    required: true,
    enum: ['sh', 'bj'],
    aliases: { 上海: 'sh', 北京: 'bj' },
  };

  it('多个不同值 → 弃权', () => {
    assert.equal(localExtract([REGION], '上海和北京都要').values.region, undefined);
  });

  it('同一个值重复 → 不算冲突', () => {
    assert.equal(localExtract([REGION], '上海的，就是上海').values.region, 'sh');
  });

  it('否定词在同分句 → 弃权', () => {
    assert.equal(localExtract([REGION], '别动上海').values.region, undefined);
  });

  it('否定词在别的分句 → 不受影响', () => {
    assert.equal(localExtract([REGION], '不着急，清一下上海').values.region, 'sh');
  });

  it('pattern 档多命中同样弃权', () => {
    assert.equal(localExtract([PHONE], '15901039503 或 13800138000').values.phone, undefined);
  });
});

describe('forVar —— 追问轮的两项额外待遇', () => {
  it('①允许 weakAliases（裸词在追问语境下无歧义）', () => {
    assert.equal(localExtract([ENV], '测试', { forVar: 'env' }).values.env, 'test');
    assert.equal(localExtract([ENV], '测试').values.env, undefined);
  });

  it('②扫不到时把整条消息当候选值', () => {
    assert.equal(localExtract([ENV], ' 体验 ', { forVar: 'env' }).values.env, 'test');
  });

  it('只惠及正在追问的那个变量，不外溢', () => {
    const { values } = localExtract([ENV, PHONE], '测试', { forVar: 'phone' });
    assert.equal(values.env, undefined, 'env 不是追问目标，裸词「测试」仍不认');
  });

  it('答非所问不得被当成答案', () => {
    assert.equal(localExtract([ENV], '这个二维码怎么用啊', { forVar: 'env' }).values.env, undefined);
  });

  it('自由文本变量即使在追问中也不盲取（否则「我不知道」会被当答案）', () => {
    const { values } = localExtract([{ name: 'note', required: true }], '我不知道', { forVar: 'note' });
    assert.equal(values.note, undefined);
  });
});

// —————— 以下为 2026-09-04 对抗式复核发现的缺陷的回归测试 ——————
// 这些行为在复核前全部是错的，而当时 2351 条测试全绿 —— 缺的正是这几条断言。

describe('回归：否定词在值之后（复核 h2）', () => {
  // 旧实现只看命中值**左侧**的半句，于是否定词在值之后就完全失效；
  // 值在句首时被检查的那半句恒为空串，弃权分支根本没机会触发。
  const cases = ['线上环境不要清数据', '正式环境不要动', 'prod 千万不要动', 'test 别清'];
  for (const text of cases) {
    it(`「${text}」必须弃权`, () => {
      const { values, unresolved } = localExtract([ENV], text);
      assert.deepEqual(values, {}, '不得抽出任何值');
      assert.equal(unresolved[0].reason, 'abstained', '弃权而非「没提到」');
    });
  }

  it('否定词落在前一分句则不误伤', () => {
    assert.equal(localExtract([ENV], '不是很急，清一下 test 环境').values.env, 'test');
  });

  it('同一个值多次出现，后一次带否定也要弃权', () => {
    // distinct 只有一个值，不触发多值弃权；旧实现只查 hits[0] 所在分句
    assert.deepEqual(localExtract([ENV], '清 test，别清 test').values, {});
  });
});

describe('回归：连字符候选的词边界（复核 m1）', () => {
  // \b 断言「两侧词性相异」，而 - 不是 \w：给 --production 加前导 \b 会让语义反转成
  // 「要求前一个字符是词字符」，正常语境下反而扫不到。
  const V = {
    name: 'mode',
    required: true,
    enum: ['verbose', 'prod'],
    aliases: { '-v': 'verbose', '--production': 'prod' },
  };

  it('前导连字符别名能命中', () => {
    assert.equal(localExtract([V], '用 -v 跑一下').values.mode, 'verbose');
  });

  it('规范值被词字符粘住时仍靠别名命中', () => {
    assert.equal(localExtract([V], '发一下 --production').values.mode, 'prod');
  });

  it('后置连字符候选不炸也不误命中', () => {
    const D = { name: 'y', required: true, enum: ['2026'], aliases: { '2026-': '2026' } };
    assert.equal(localExtract([D], '2026- 的数据').values.y, '2026');
  });
});

describe('回归：别名表不得走原型链（复核 l1）', () => {
  // 追问轮会把整条用户消息当候选串送进 normalizeValue，cand 不再受 Object.keys 约束
  const rv = resolveVariable(ENV);
  for (const evil of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
    it(`「${evil}」不得命中 Object.prototype`, () => {
      assert.equal(normalizeValue(rv, evil, { weak: true }), null);
    });
  }
});

describe('回归：别名目标值必须落在 enum 内（复核 h1 运行时闸）', () => {
  it('preset 别名指向被收窄掉的值时丢弃而非采纳', () => {
    // 运维选 preset=env 再把合法值收窄成 dev/test（刻意禁掉 prod）。
    // resolveVariable 是浅覆盖，preset 的「正式环境 → prod」原样保留 —— 这里必须拦住。
    const rv = resolveVariable({ name: 'env', preset: 'env', enum: ['dev', 'test'] });
    assert.equal(normalizeValue(rv, '正式环境'), null);
    assert.deepEqual(localExtract([{ name: 'env', required: true, preset: 'env', enum: ['dev', 'test'] }],
      '清一下正式环境的数据').values, {});
  });

  it('收窄后仍在集合内的值照常命中', () => {
    const rv = resolveVariable({ name: 'env', preset: 'env', enum: ['dev', 'test'] });
    assert.equal(normalizeValue(rv, '体验版'), 'test');
  });
});
