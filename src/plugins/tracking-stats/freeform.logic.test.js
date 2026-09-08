import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FREEFORM_PREFIX,
  parseFreeformCommand,
  buildAnalysisPrompt,
  buildAnswerReply,
  buildFreeformFailureReply,
  classifyDbError,
  splitHtmlReport,
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

  it('帮我统计埋点 也归本路径（2026-09-07 合并，老用户习惯不打断）', () => {
    assert.deepEqual(parseFreeformCommand('帮我统计埋点: 上周分享点击'), { hit: true, body: '上周分享点击' });
    assert.deepEqual(parseFreeformCommand('帮我统计埋点：上周分享点击'), { hit: true, body: '上周分享点击' });
    assert.equal(FREEFORM_PREFIX, '帮我查数据');
  });

  it('两个前缀都要在开头，中间出现不算', () => {
    assert.equal(parseFreeformCommand('顺便帮我统计埋点: x').hit, false);
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

  it('强制翻译埋点 key —— 首版漏了这条，报告满屏 ruyee_xxx 等于没写', () => {
    const p = buildAnalysisPrompt('q', dict, '2026-09-07', 'db');
    assert.match(p, /event_mapping/, '要指名权威词典表');
    assert.match(p, /is_deleted/, '要提醒过滤软删');
    assert.match(p, /LEFT JOIN/, '要给出可照抄的 JOIN 写法');
    assert.match(p, /COALESCE/, '词典查不到时要兜底而不是丢行');
    assert.match(p, /不允许出现裸埋点 key|裸埋点/, '要把这条写成硬性要求');
  });

  it('要求保留 key 在括号里 —— 只给中文名会丢掉研发的可追溯性', () => {
    const p = buildAnalysisPrompt('q', dict, '2026-09-07', 'db');
    assert.match(p, /括号/);
    assert.match(p, /ruyee_dish_toggle_meal/, '给一个具体示范，模型才照做');
  });

  it('默认排除内测用户 —— 团队自己人天天点，不排会把小功能数字抬高', () => {
    const p = buildAnalysisPrompt('q', dict, '2026-09-07', 'db');
    assert.match(p, /internal_user/, '要指名内测名单表');
    assert.match(p, /login_id NOT IN/, '埋点表按 login_id 排除（不是 distinct_id）');
    assert.match(p, /uid NOT IN/, '业务表按 uid 排除');
    assert.match(p, /devtools/, '同时排掉研发调试流量');
  });

  it('用户标识必须指明 login_id 而非 distinct_id（实测口径）', () => {
    // distinct_id 是设备级匿名串，与 mini_openid 零匹配；login_id 与 user.uid 匹配 99.87%
    const p = buildAnalysisPrompt('q', dict, '2026-09-07', 'db');
    assert.match(p, /login_id/);
    assert.match(p, /distinct_id/, '要解释两者区别，否则模型还是会混用');
    assert.match(p, /设备|匿名/, '要说清 distinct_id 认设备不认人');
  });

  it('提醒 login_id(varchar) 与 uid(bigint) 的类型不匹配', () => {
    // 直接用 = 比会隐式转换，实测 807 个内测账号炸成 37682 条错误匹配
    const p = buildAnalysisPrompt('q', dict, '2026-09-07', 'db');
    assert.match(p, /CAST/);
    assert.match(p, /COLLATE|utf8mb4/);
  });

  it('给出按手机号查用户的两步配方（PII 可做条件不可做输出）', () => {
    const p = buildAnalysisPrompt('q', dict, '2026-09-07', 'db');
    assert.match(p, /WHERE phone/, '要给出可照抄的第一步');
    assert.match(p, /筛选条件/);
    assert.match(p, /查不到就直说/, '不许拿别的用户顶替');
  });

  it('提醒 NOT IN 的 NULL 陷阱（子查询含 NULL 会整体返回空集）', () => {
    const p = buildAnalysisPrompt('q', dict, '2026-09-07', 'db');
    assert.match(p, /NOT EXISTS|IS NOT NULL/);
  });

  it('要求把「已排除内测」写进报告 —— 口径不说，数字就没法跟别处对上', () => {
    const p = buildAnalysisPrompt('q', dict, '2026-09-07', 'db');
    assert.match(p, /已排除内测/);
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

describe('splitHtmlReport —— 聊天摘要与 HTML 附件分离', () => {
  it('切出 html 并把剩余文字作为聊天正文', () => {
    const raw = ['结论：共 100 人。', '', '```html', '<h1>报告</h1>', '```'].join('\n');
    const { html, chat } = splitHtmlReport(raw);
    assert.equal(html, '<h1>报告</h1>');
    assert.equal(chat, '结论：共 100 人。');
  });

  it('没有 html 围栏时原样作聊天正文，html 为 null', () => {
    const { html, chat } = splitHtmlReport('就一句话结论');
    assert.equal(html, null);
    assert.equal(chat, '就一句话结论');
  });

  it('空围栏不当成报告（免得发一个空附件）', () => {
    assert.equal(splitHtmlReport(['x', '```html', '', '```'].join('\n')).html, null);
  });

  it('大小写容错', () => {
    assert.equal(splitHtmlReport(['```HTML', '<p>a</p>', '```'].join('\n')).html, '<p>a</p>');
  });

  it('空输入不炸', () => {
    assert.deepEqual(splitHtmlReport(null), { html: null, chat: '' });
  });
});

describe('buildAnalysisPrompt —— 前端查证段按需出现', () => {
  const dict = { categories: [] };

  it('挂载了前端工具才出现相关段落', () => {
    const on = buildAnalysisPrompt('q', dict, '2026-09-07', 'db', { hasFrontend: true });
    assert.match(on, /search_frontend/);
    assert.match(on, /read_frontend/);
    assert.match(on, /属性取值/);
  });

  it('未配置前端仓库时整段不出现 —— 免得模型反复试探不存在的工具', () => {
    const off = buildAnalysisPrompt('q', dict, '2026-09-07', 'db');
    assert.doesNotMatch(off, /search_frontend/);
    assert.doesNotMatch(off, /read_frontend/);
  });

  it('要求查不到就说查不到，不许按 key 字面猜', () => {
    const on = buildAnalysisPrompt('q', dict, '2026-09-07', 'db', { hasFrontend: true });
    assert.match(on, /不要凭 key 的字面拼写去猜/);
  });

  it('要求产出自包含 HTML（离线可开、无外链、无 script）', () => {
    const p = buildAnalysisPrompt('q', dict, '2026-09-07', 'db');
    assert.match(p, /```html/);
    assert.match(p, /自包含/);
    assert.match(p, /charset/);
    assert.match(p, /script/);
  });
});
