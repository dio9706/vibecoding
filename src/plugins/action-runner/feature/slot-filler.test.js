import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractVars, pickMissingVars } from './slot-filler.js';

// 抽取路径统一注入 llmExtract，单测不联网、不烧额度（真实 Claude 抽取靠线上日志观测）
const NO_LLM = { llmExtract: async () => null };

/** 一旦被调用就炸 —— 用来断言「这条路径根本没走 LLM」 */
const LLM_FORBIDDEN = {
  llmExtract: async () => {
    throw new Error('不该调用 LLM：本地抽取应当已经覆盖全部必填字段');
  },
};

const cfg = {
  variables: [
    { name: 'phone', label: '手机号', required: true, preset: 'phone' },
    { name: 'env', label: '环境', required: true, preset: 'env' },
  ],
};

describe('本地抽取 —— 主路径零 LLM', () => {
  /**
   * 本次改造的**核心收益**：env 是闭集查表、phone 是正则，都不需要推理。
   * 旧实现每次都 spawn 一个 Claude Code 子进程做这件事（生产实测 8~17s，
   * 光 SDK 冷启就 2.7~3.7s）。这条断言守住「别再退回去」。
   */
  it('必填字段全部本地命中时，绝不调用 LLM', async () => {
    const r = await extractVars(cfg, '请清一下 test 的 15901039503', null, LLM_FORBIDDEN);
    assert.equal(r.env, 'test');
    assert.equal(r.phone, '15901039503');
  });

  it('还缺必填字段时才调 LLM，且只把缺的那些交给它', async () => {
    let asked = null;
    const r = await extractVars(cfg, '帮我清一下 test 环境', null, {
      llmExtract: async (_text, unresolved) => {
        asked = unresolved.map((rv) => rv.name);
        return { phone: '15901039503' };
      },
    });
    assert.deepEqual(asked, ['phone'], 'env 已本地抽到，不该出现在待抽列表里');
    assert.equal(r.env, 'test');
    assert.equal(r.phone, '15901039503');
  });

  it('本地抽到的值不得被 LLM 改写（本地是确定性结果）', async () => {
    const r = await extractVars(cfg, '清一下 test 的 15901039503', null, {
      llmExtract: async () => ({ env: 'prod' }),
    });
    assert.equal(r.env, 'test');
  });
});

/**
 * 抽取器**不认识任何变量名** —— 这是本次改造的核心契约。
 * 改造前 slot-filler 有三处按名字硬编码（NORMALIZERS / regexExtract / hasEnv 分支），
 * 变量改个名字就整套失效，而用户无从察觉。
 */
describe('契约：抽取与变量名无关', () => {
  const decl = {
    required: true,
    enum: ['sh', 'bj'],
    aliases: { 上海: 'sh', 沪: 'sh', 北京: 'bj' },
  };

  for (const name of ['env', 'region', '机房', 'x']) {
    it(`变量叫「${name}」结果一致`, async () => {
      const c = { variables: [{ ...decl, name, label: '机房' }] };
      const r = await extractVars(c, '把上海的数据清一下', null, NO_LLM);
      assert.equal(r[name], 'sh');
    });
  }

  it('自定义 enum 同样享受弃权规则（不是 env 专属）', async () => {
    const c = { variables: [{ ...decl, name: 'region' }] };
    assert.equal((await extractVars(c, '别动上海，清北京', null, NO_LLM)).region, undefined);
    assert.equal((await extractVars(c, '不要上海的', null, NO_LLM)).region, undefined);
  });
});

describe('env preset —— 本地词表兜底（LLM 失败/额度耗尽时的唯一防线）', () => {
  const envOf = async (text) => (await extractVars(cfg, text, null, NO_LLM)).env;

  it('英文环境词', async () => {
    const r = await extractVars(cfg, '请清一下 test 的 15901039503', null, NO_LLM);
    assert.equal(r.phone, '15901039503');
    assert.equal(r.env, 'test');
  });

  it('中文环境词也要抓到（核心回归：曾只认 dev/test 英文）', async () => {
    assert.equal(await envOf('帮我拿个体验版的二维码'), 'test');
    assert.equal(await envOf('要开发版的码'), 'dev');
    assert.equal(await envOf('线上版的二维码给我'), 'prod');
  });

  it('prod 也要抓到（曾整个漏掉）', async () => {
    assert.equal(await envOf('给我 prod 的二维码'), 'prod');
  });

  it('「测试一下」这种动词不得误判成 test 环境', async () => {
    assert.equal(await envOf('帮我测试一下这个功能'), undefined);
  });

  /**
   * 两张表（扫描词表 / 归一别名表）曾各写各的并已分叉：ALIASES 收了「正式」「生产」，
   * SCAN_RE 却只有「正式版」「生产环境」，于是「帮我清一下正式环境的数据」扫不出环境。
   * 现在两者同源（都来自 preset 的 enum+aliases），这批用例钉住不再分叉。
   */
  it('曾经分叉的词也要抓到（正式环境 / 生产版 / 开发环境）', async () => {
    assert.equal(await envOf('帮我清一下正式环境的数据'), 'prod');
    assert.equal(await envOf('要生产版的二维码'), 'prod');
    assert.equal(await envOf('开发环境的码给我'), 'dev');
  });

  it('production / development 等英文别名也要抓到，且长词不被短词截断', async () => {
    assert.equal(await envOf('给我 production 的二维码'), 'prod');
    assert.equal(await envOf('give me the development qrcode'), 'dev');
  });

  it('不认识的环境（预发布 / 灰度）一律弃权，绝不猜成相邻环境', async () => {
    assert.equal(await envOf('帮我清一下预发布的数据'), undefined);
    assert.equal(await envOf('灰度环境的二维码'), undefined);
  });
});

/**
 * 本地抽取**不做语义判断**。拿不准必须弃权（判字段缺失 → 交 LLM 或追问），
 * 绝不能猜 —— 猜错的代价是清错环境/退错款（不可逆），多问一句只是一轮对话。
 */
describe('冲突 / 否定护栏 —— 拿不准必须弃权', () => {
  const envOf = async (text) => (await extractVars(cfg, text, null, NO_LLM)).env;

  it('一句话出现两个不同环境词 → 弃权（核心场景：别清 test，清 dev）', async () => {
    assert.equal(await envOf('别清 test，清 dev'), undefined);
    assert.equal(await envOf('不要 test 环境，我要 dev 的'), undefined);
    assert.equal(await envOf('不是开发版，是体验版'), undefined);
    assert.equal(await envOf('把体验版和线上版的码都给我'), undefined);
  });

  it('否定词修饰环境词 → 弃权（只有一个环境词也不能信）', async () => {
    assert.equal(await envOf('别清 test 环境'), undefined);
    assert.equal(await envOf('不要体验版的'), undefined);
    assert.equal(await envOf('不用 dev 的二维码'), undefined);
  });

  it('否定词在**另一个分句**里不影响本句判定（否则误伤面过大）', async () => {
    assert.equal(await envOf('不是很急，清一下 test 环境'), 'test');
    assert.equal(await envOf('这个先不管，给我体验版的码'), 'test');
  });

  it('同一个环境词重复出现不算冲突', async () => {
    assert.equal(await envOf('清一下 test 环境的 test 账号'), 'test');
    assert.equal(await envOf('体验版，就是测试版那个'), 'test');
  });

  it('弃权只作用于本地扫描；LLM 抽出的值仍然采纳（语义判断本就该模型做）', async () => {
    const r = await extractVars(cfg, '别清 test，清 dev', null, { llmExtract: async () => ({ env: 'dev' }) });
    assert.equal(r.env, 'dev');
  });

  it('多个手机号也弃权（同一判据：宁可追问也不猜）', async () => {
    const r = await extractVars(cfg, 'test 环境，15901039503 还是 13800138000', null, NO_LLM);
    assert.equal(r.phone, undefined);
  });
});

describe('forVar —— 追问中「整条回复即答案」', () => {
  const one = { variables: [{ name: 'env', label: '环境', required: true, preset: 'env' }] };

  it('用户只回两个字「体验」也要认（追问上下文已知在等 env）', async () => {
    const r = await extractVars(one, '体验', null, { ...NO_LLM, forVar: 'env' });
    assert.equal(r.env, 'test');
  });

  it('回的是别的问题 → 不得被当成答案', async () => {
    const r = await extractVars(one, '这个二维码怎么用啊', null, { ...NO_LLM, forVar: 'env' });
    assert.equal(r.env, undefined);
  });

  it('没有 forVar 时裸词不认（自由文本里「体验」歧义太大）', async () => {
    const r = await extractVars(one, '体验', null, NO_LLM);
    assert.equal(r.env, undefined);
  });
});

describe('归一与丢弃', () => {
  it('非法值直接丢弃 → 视为该字段缺失（而不是把中文透传给脚本）', async () => {
    const r = await extractVars(cfg, '随便什么', null, { llmExtract: async () => ({ env: '预发布' }) });
    assert.equal('env' in r, false);
    assert.deepEqual(pickMissingVars(cfg, r).map((v) => v.name), ['phone', 'env']);
  });

  it('模型幻觉出的未声明字段一律丢弃', async () => {
    const r = await extractVars(cfg, '随便', null, {
      llmExtract: async () => ({ env: 'test', phone: '15901039503', 不存在的字段: 'x' }),
    });
    assert.equal('不存在的字段' in r, false);
  });

  it('自由文本变量原样保留（无 enum/pattern 声明）', async () => {
    const c = { variables: [{ name: 'note', label: '备注', required: true }] };
    const r = await extractVars(c, 'x', null, { llmExtract: async () => ({ note: '体验版' }) });
    assert.equal(r.note, '体验版');
  });

  it('格式不符的手机号不透传（pattern 校验会加锚点）', async () => {
    const r = await extractVars(cfg, 'test 环境', null, { llmExtract: async () => ({ phone: '123' }) });
    assert.equal('phone' in r, false);
  });
});

describe('pickMissingVars', () => {
  it('识别缺失的必填变量', () => {
    const c = {
      variables: [
        { name: 'phone', required: true, prompt: '请输入手机号' },
        { name: 'env', required: true, prompt: '请输入环境' },
      ],
    };
    const missing = pickMissingVars(c, { phone: '15901039503' });
    assert.equal(missing.length, 1);
    assert.equal(missing[0].name, 'env');
  });
});

describe('onLlmStart —— 即时应答只在真等模型时才触发', () => {
  const CFG = {
    variables: [
      { name: 'env', label: '环境', required: true, preset: 'env' },
      { name: 'note', label: '备注', required: true }, // 自由文本，本地抽不出
    ],
  };

  it('本地全命中 → 不触发（主路径，不该弹「请稍等」）', async () => {
    const local = { variables: [{ name: 'env', label: '环境', required: true, preset: 'env' }] };
    let fired = 0;
    const got = await extractVars(local, '给我 test 的二维码', null, {
      onLlmStart: () => (fired += 1),
      llmExtract: async () => {
        throw new Error('本地已全命中，不该调 LLM');
      },
    });
    assert.equal(got.env, 'test');
    assert.equal(fired, 0);
  });

  it('有自由文本必填字段 → 触发一次', async () => {
    let fired = 0;
    await extractVars(CFG, '给我 test 的二维码', null, {
      onLlmStart: () => (fired += 1),
      llmExtract: async () => ({ note: 'x' }),
    });
    assert.equal(fired, 1);
  });

  it('回调抛异常不得影响抽取（它只是发条提示）', async () => {
    const got = await extractVars(CFG, '给我 test 的二维码', null, {
      onLlmStart: () => {
        throw new Error('飞书 429');
      },
      llmExtract: async () => ({ note: 'x' }),
    });
    assert.equal(got.env, 'test');
    assert.equal(got.note, 'x');
  });
});
