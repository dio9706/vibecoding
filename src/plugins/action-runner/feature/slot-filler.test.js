import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractVars, pickMissingVars, normalizeEnv, normalizeVars } from './slot-filler.js';

// 抽取路径统一注入 llmExtract，单测不联网、不烧额度（真实 Claude 抽取靠线上日志观测）
const NO_LLM = { llmExtract: async () => null };

describe('normalizeEnv —— 环境别名归一', () => {
  it('中文别名归一到规范值（线上事故：只有说 test 才认）', () => {
    assert.equal(normalizeEnv('体验版'), 'test');
    assert.equal(normalizeEnv('测试版'), 'test');
    assert.equal(normalizeEnv('开发版'), 'dev');
    assert.equal(normalizeEnv('线上版'), 'prod');
    assert.equal(normalizeEnv('正式版'), 'prod');
    assert.equal(normalizeEnv('生产环境'), 'prod');
  });

  it('英文与大小写变体', () => {
    assert.equal(normalizeEnv('dev'), 'dev');
    assert.equal(normalizeEnv('TEST'), 'test');
    assert.equal(normalizeEnv(' Prod '), 'prod');
  });

  it('剥掉被一起抽出来的尾巴词（与 get_qrcode.py normalize_env 对齐）', () => {
    assert.equal(normalizeEnv('正式版二维码'), 'prod');
    assert.equal(normalizeEnv('体验版的'), 'test');
    assert.equal(normalizeEnv('开发版环境'), 'dev');
  });

  it('识别不了一律 null（绝不瞎猜，宁可当没提供）', () => {
    assert.equal(normalizeEnv('预发布'), null);
    assert.equal(normalizeEnv('随便'), null);
    assert.equal(normalizeEnv(''), null);
    assert.equal(normalizeEnv(null), null);
  });
});

describe('normalizeVars —— 写盘/传参前的统一归一', () => {
  const cfg = { variables: [{ name: 'env', required: true }, { name: 'phone', required: true }] };

  it('env 归一为规范值（脚本 argparse choices=[dev,test] 只认规范值）', () => {
    assert.deepEqual(normalizeVars(cfg, { env: '体验版', phone: '15901039503' }), {
      env: 'test',
      phone: '15901039503',
    });
  });

  it('非法 env 直接丢弃 → 视为该字段缺失（而不是把中文透传给脚本）', () => {
    const out = normalizeVars(cfg, { env: '预发布', phone: '15901039503' });
    assert.equal('env' in out, false);
    assert.deepEqual(pickMissingVars(cfg, out).map((v) => v.name), ['env']);
  });

  it('非 env 变量原样保留', () => {
    assert.deepEqual(normalizeVars({ variables: [{ name: 'note' }] }, { note: '体验版' }), { note: '体验版' });
  });
});

describe('regexExtract 兜底 —— LLM 失败/额度耗尽时的唯一防线', () => {
  const cfg = {
    variables: [
      { name: 'phone', label: '手机号', required: true },
      { name: 'env', label: '环境', required: true },
    ],
  };

  it('英文环境词（原有行为不回归）', async () => {
    const r = await extractVars(cfg, '请清一下 test 的 15901039503', null, NO_LLM);
    assert.equal(r.phone, '15901039503');
    assert.equal(r.env, 'test');
  });

  it('中文环境词也要抓到（核心回归：曾只认 dev/test 英文）', async () => {
    assert.equal((await extractVars(cfg, '帮我拿个体验版的二维码', null, NO_LLM)).env, 'test');
    assert.equal((await extractVars(cfg, '要开发版的码', null, NO_LLM)).env, 'dev');
    assert.equal((await extractVars(cfg, '线上版的二维码给我', null, NO_LLM)).env, 'prod');
  });

  it('prod 也要抓到（曾整个漏掉）', async () => {
    assert.equal((await extractVars(cfg, '给我 prod 的二维码', null, NO_LLM)).env, 'prod');
  });

  it('「测试一下」这种动词不得误判成 test 环境', async () => {
    assert.equal((await extractVars(cfg, '帮我测试一下这个功能', null, NO_LLM)).env, undefined);
  });
});

/**
 * 正则是**兜底**，不做语义判断。拿不准时必须弃权（判字段缺失 → 追问一次），
 * 绝不能猜 —— 猜错的代价是清错环境/退错款，多问一句的代价只是一轮对话。
 */
describe('环境词冲突 / 否定护栏 —— 正则拿不准时必须弃权', () => {
  const cfg = {
    variables: [
      { name: 'phone', label: '手机号', required: true },
      { name: 'env', label: '环境', required: true },
    ],
  };
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

  it('无歧义的单命中不受影响（不得回归）', async () => {
    assert.equal(await envOf('帮我拿个体验版的二维码'), 'test');
    assert.equal(await envOf('请清一下 test 的 15901039503'), 'test');
  });

  it('弃权只作用于正则；LLM 抽出的值仍然采纳（语义判断本就该模型做）', async () => {
    const r = await extractVars(cfg, '别清 test，清 dev', null, { llmExtract: async () => ({ env: 'dev' }) });
    assert.equal(r.env, 'dev');
  });
});

describe('forVar —— 追问中「整条回复即答案」', () => {
  const cfg = { variables: [{ name: 'env', label: '环境', required: true }] };

  it('用户只回两个字「体验」也要认（追问上下文已知在等 env）', async () => {
    const r = await extractVars(cfg, '体验', null, { ...NO_LLM, forVar: 'env' });
    assert.equal(r.env, 'test');
  });

  it('回的是别的问题 → 不得被当成答案', async () => {
    const r = await extractVars(cfg, '这个二维码怎么用啊', null, { ...NO_LLM, forVar: 'env' });
    assert.equal(r.env, undefined);
  });

  it('没有 forVar 时不做整条归一（避免自由文本被整体当值）', async () => {
    const r = await extractVars(cfg, '体验', null, NO_LLM);
    assert.equal(r.env, undefined);
  });
});

describe('pickMissingVars', () => {
  it('识别缺失的必填变量', () => {
    const cfg = {
      variables: [
        { name: 'phone', required: true, prompt: '请输入手机号' },
        { name: 'env', required: true, prompt: '请输入环境' },
      ],
    };
    const missing = pickMissingVars(cfg, { phone: '15901039503' });
    assert.equal(missing.length, 1);
    assert.equal(missing[0].name, 'env');
  });
});
