import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FREEFORM_PREFIX,
  parseFreeformCommand,
  buildAnalysisPrompt,
  buildAnswerReply,
  buildFreeformFailureReply,
  classifyDbError,
} from './freeform.logic.js';

describe('parseFreeformCommand', () => {
  it('命中并剥出正文', () => {
    assert.deepEqual(parseFreeformCommand('帮我查数据: 上周订单量'), { hit: true, body: '上周订单量' });
    assert.deepEqual(parseFreeformCommand('帮我查数据：上周订单量'), { hit: true, body: '上周订单量' });
    assert.deepEqual(parseFreeformCommand('帮我查数据 上周订单量'), { hit: true, body: '上周订单量' });
  });

  it('只发前缀 → hit 但 body 空（调用方据此追问，且不占配额）', () => {
    assert.deepEqual(parseFreeformCommand('帮我查数据'), { hit: true, body: '' });
  });

  it('前缀必须在开头 —— 防整篇文档被贴进来全文命中', () => {
    assert.equal(parseFreeformCommand('（略）……然后帮我查数据: x').hit, false);
    assert.equal(parseFreeformCommand('别帮我查数据').hit, false);
  });

  it('空输入不命中', () => {
    for (const v of ['', '   ', null, undefined, 123]) {
      assert.equal(parseFreeformCommand(v).hit, false);
    }
  });

  it('与埋点老路径的前缀互不包含（两条 feature 不会互抢）', () => {
    assert.equal(parseFreeformCommand('帮我统计埋点: x').hit, false);
    assert.equal(FREEFORM_PREFIX, '帮我查数据');
  });
});

describe('buildAnalysisPrompt', () => {
  const dict = { categories: [{ label: '分享' }, { label: '订单' }] };

  it('明写今天日期 —— 模型没有时间概念，相对表述必须有锚点', () => {
    const p = buildAnalysisPrompt('最近7天', dict, '2026-09-07', 'compass_prod');
    assert.match(p, /2026-09-07/);
  });

  it('带上库名与只读声明', () => {
    const p = buildAnalysisPrompt('q', dict, '2026-09-07', 'mydb');
    assert.match(p, /mydb/);
    assert.match(p, /只读/);
  });

  it('注入埋点类目作先验', () => {
    const p = buildAnalysisPrompt('q', dict, '2026-09-07', 'db');
    assert.match(p, /分享、订单/);
  });

  it('无索引时不炸，也不留空占位', () => {
    const p = buildAnalysisPrompt('q', null, '2026-09-07', 'db');
    assert.ok(p.includes('q'));
    assert.doesNotMatch(p, /已知业务模块/);
  });

  it('告知 SHOW/DESCRIBE 不可用并指向替代工具（否则模型会反复重试）', () => {
    const p = buildAnalysisPrompt('q', dict, '2026-09-07', 'db');
    assert.match(p, /SHOW/);
    assert.match(p, /list_tables/);
    assert.match(p, /describe_table/);
  });

  it('要求聚合优先 + 说明截断，且用户问题在末尾', () => {
    const p = buildAnalysisPrompt('我的问题在这', dict, '2026-09-07', 'db');
    assert.match(p, /聚合/);
    assert.match(p, /截断/);
    assert.ok(p.trimEnd().endsWith('我的问题在这'));
  });
});

describe('buildAnswerReply', () => {
  it('正常结论 + 过程信息放在结论之后', () => {
    const s = buildAnswerReply({ text: '上周共 1234 单。', queries: 3, denied: [] });
    assert.ok(s.startsWith('上周共 1234 单。'));
    assert.match(s, /查询 3 次/);
  });

  it('被拒次数要露出来 —— 它解释了「为什么结论看着不完整」', () => {
    const s = buildAnswerReply({ text: '结论', queries: 2, denied: ['pii_denied', 'pii_denied', 'not_select'] });
    assert.match(s, /3 次被安全策略拦下/);
    assert.match(s, /2 次涉及个人信息/);
  });

  it('不逐条列 denyCode（那是给审计看的，对用户没有行动价值）', () => {
    const s = buildAnswerReply({ text: '结论', queries: 1, denied: ['pii_denied'] });
    assert.doesNotMatch(s, /pii_denied/);
  });

  it('模型没输出时给明确回话，不返回空串', () => {
    assert.match(buildAnswerReply({ text: '', queries: 0, denied: [] }), /没能得出结论/);
    assert.match(buildAnswerReply({ text: '   ' }), /没能得出结论/);
  });
});

describe('buildFreeformFailureReply —— 按真实原因分开回话', () => {
  it('额度耗尽要说明「需求本身没问题」', () => {
    const s = buildFreeformFailureReply('exhausted');
    assert.match(s, /额度/);
    assert.match(s, /需求本身没问题/, '否则用户会反复改写一句本来正确的需求');
  });

  it('超时要给可行动的建议', () => {
    assert.match(buildFreeformFailureReply('timeout'), /缩小|更短/);
  });

  it('连不上库要提跳板与自检脚本', () => {
    const s = buildFreeformFailureReply('db_connect', 'Access denied');
    assert.match(s, /跳板/);
    assert.match(s, /check-tracking-db/);
  });

  it('缺配置要指向 APP_DATA_DIR，且不能说成「连不上」', () => {
    // 实测踩过：打包版没加载 .env，报成连接问题会让人一路查到跳板隧道去
    const s = buildFreeformFailureReply('db_config', 'RuntimeError: 缺少环境变量：TRACKING_DB_HOST');
    assert.match(s, /TRACKING_DB/);
    assert.match(s, /com\.principal\.desktop/, '要给出打包态该放哪');
    assert.doesNotMatch(s, /跳板/, '缺配置与连不上是两回事');
  });

  it('未知原因兜底也要给出点信息', () => {
    assert.match(buildFreeformFailureReply('weird', '某某错误'), /某某错误/);
  });
});

describe('classifyDbError —— 三分（没配置 / 连不上 / 查询错）', () => {
  it('优先用脚本给的 kind', () => {
    assert.equal(classifyDbError({ kind: 'config', error: 'x' }), 'db_config');
    assert.equal(classifyDbError({ kind: 'connect', error: 'x' }), 'db_connect');
  });
  it('没有 kind 时按错误文本判', () => {
    assert.equal(classifyDbError({ error: 'RuntimeError: 缺少环境变量：TRACKING_DB_HOST' }), 'db_config');
    assert.equal(classifyDbError({ error: "OperationalError: Can't connect" }), 'db_connect');
    assert.equal(classifyDbError({ error: 'ProgrammingError: syntax error' }), 'db_query');
  });
  it('缺配置优先于连接判定 —— 两者的错误文本可能同时命中', () => {
    assert.equal(classifyDbError({ error: '缺少环境变量：TRACKING_DB_HOST, Access denied' }), 'db_config');
  });
  it('空输入按查询错处理', () => {
    assert.equal(classifyDbError(null), 'db_query');
  });
});
