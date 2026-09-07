/**
 * 持久化变量与本地抽取的交互 —— 2026-09-04 对抗式复核（h3）的回归测试。
 *
 * 为什么单独一个文件：`extractVars` 传 userId 时会经 store/user-vars 读盘，而 store/index.js
 * 在**模块初始化时**定死数据目录，所以 APP_DATA_DIR 必须早于任何动态 import 设好
 *（同 store/user-vars.test.js 的做法）。slot-filler.test.js 里全部用例传的都是 userId=null，
 * 这条读盘路径此前零覆盖 —— 缺陷正好藏在这里。
 *
 * 被守护的行为：持久化旧值可以顶掉一个「本次没提到」的必填字段（那是「第二次不用再报手机号」
 * 这个功能），但**绝不能**顶掉一个「提到了却读不准」的字段 —— 下游是清数据 / 退款这类不可逆脚本。
 */
import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'persistent-vars-test-'));
process.env.APP_DATA_DIR = TMP_DIR;
const { setVar } = await import('../../../store/user-vars.js');
const { extractVars } = await import('./slot-filler.js');

after(() => fs.rmSync(TMP_DIR, { recursive: true, force: true }));

const USER = 'ou_h3';
const OLD_PHONE = '13800138000';

/** 清理动作：env 闭集 + phone 正则，phone 持久化。与生产上那条破坏性动作同形。 */
const ACTION = {
  id: 'ac_h3',
  name: '清理账号数据',
  variables: [
    { name: 'env', label: '环境', required: true, preset: 'env' },
    { name: 'phone', label: '手机号', required: true, persistent: true, preset: 'phone' },
  ],
};

/** 记录 LLM 是否被调用，并可指定它返回什么 */
function spyLlm(returns = null) {
  const calls = [];
  const fn = async (text, unresolved) => {
    calls.push({ text, names: unresolved.map((rv) => rv.name) });
    return returns;
  };
  return { fn, calls };
}

beforeEach(() => setVar(USER, 'phone', OLD_PHONE));

describe('持久化旧值只能顶「没提到」，不能顶「读不准」（复核 h3）', () => {
  it('本次没提手机号 → 沿用旧号，且不调 LLM（这是该功能本身）', async () => {
    const llm = spyLlm();
    const got = await extractVars(ACTION, '清一下 test 环境的数据', USER, { llmExtract: llm.fn });
    assert.deepEqual(got, { env: 'test', phone: OLD_PHONE });
    assert.equal(llm.calls.length, 0, '两个必填都有值，不该烧 LLM');
  });

  it('说了两个号（改号场景）→ 弃权，必须调 LLM 且新号覆盖旧号', async () => {
    // 旧实现：phone 因 persistent 命中被排除出 needLlm → 完全不调 LLM →
    // 静默沿用旧号 → 清掉另一个人的数据。
    const llm = spyLlm({ phone: '13900139000' });
    const got = await extractVars(
      ACTION,
      '我的号从 13800138000 换成 13900139000，清一下 test',
      USER,
      { llmExtract: llm.fn },
    );
    assert.equal(llm.calls.length, 1, '弃权字段必须触发 LLM');
    assert.ok(llm.calls[0].names.includes('phone'), '提示词里必须包含被持久值顶掉的字段');
    assert.equal(got.phone, '13900139000', '新号要覆盖旧号');
  });

  it('弃权且 LLM 也没给出值 → 丢弃旧值改为追问，绝不沿用', async () => {
    const llm = spyLlm(null); // 模型超时/额度耗尽/抽不出
    const got = await extractVars(
      ACTION,
      '我的号从 13800138000 换成 13900139000，清一下 test',
      USER,
      { llmExtract: llm.fn },
    );
    assert.equal(got.phone, undefined, '宁可追问，也不能拿旧号去执行不可逆脚本');
    assert.equal(got.env, 'test');
  });

  it('环境被否定词修饰 → 弃权触发 LLM（即便手机号已有持久值）', async () => {
    const llm = spyLlm({ env: 'dev' });
    const got = await extractVars(ACTION, '线上环境不要动，清 dev', USER, { llmExtract: llm.fn });
    assert.equal(llm.calls.length, 1);
    assert.equal(got.env, 'dev');
  });

  it('LLM 被调用时，提示词字段表含全部必填 unresolved（含被持久值顶掉的）', async () => {
    // 触发条件由 env 提供（没有持久值），payload 必须把 phone 也带上，
    // 否则用户这次说的新号永远没机会进来。
    const llm = spyLlm();
    await extractVars(ACTION, '帮我清一下数据', USER, { llmExtract: llm.fn });
    assert.equal(llm.calls.length, 1);
    assert.deepEqual(llm.calls[0].names.sort(), ['env', 'phone']);
  });
});
