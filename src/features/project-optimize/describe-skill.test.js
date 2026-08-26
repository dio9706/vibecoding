/**
 * describe-skill 纯函数单测。
 *
 * 只测 outlineOf / fallbackDescription / toYamlScalar 三个纯函数：describeSkill 要真发 LLM 调用，
 * 不适合进单测（既慢又烧额度，且断言只能写成「返回了字符串」这种没有信息量的形状），
 * 靠实测脚本人工核对质量。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outlineOf, fallbackDescription, toYamlScalar } from './describe-skill.js';

// ---------- outlineOf ----------

test('抽取一级标题与全部二三级标题', () => {
  const md = [
    '# 统一弹框规范',
    '',
    '> 引言一句话',
    '',
    '## 十条硬规则',
    '正文 A',
    '### 规则 1',
    '正文 B',
    '## 模板骨架',
    '正文 C',
  ].join('\n');

  const o = outlineOf(md);
  assert.equal(o.h1, '统一弹框规范');
  assert.deepEqual(o.subs, ['十条硬规则', '规则 1', '模板骨架']);
});

test('四级及更深的标题不收进 subs', () => {
  // 提纲只要能勾勒范围，h4 往下属于细节，收进来只会挤占 prompt 预算
  const o = outlineOf('# T\n## A\n#### 太深了\n');
  assert.deepEqual(o.subs, ['A']);
});

test('只认第一个 h1，后面的 h1 忽略', () => {
  const o = outlineOf('# 第一个\n## A\n# 第二个\n');
  assert.equal(o.h1, '第一个');
});

test('head 是去掉标题行后的正文开头', () => {
  // 标题已经单独通过 h1/subs 给出去了，head 里再重复一遍纯属浪费 500 字预算
  const o = outlineOf('# 标题\n\n第一段正文。\n\n## 小节\n\n第二段正文。\n');
  assert.ok(!o.head.includes('# 标题'), 'head 不该含 h1 行');
  assert.ok(!o.head.includes('## 小节'), 'head 不该含 h2 行');
  assert.ok(o.head.includes('第一段正文。'));
  assert.ok(o.head.includes('第二段正文。'));
});

test('head 截断到 500 字', () => {
  const o = outlineOf(`# T\n\n${'字'.repeat(900)}`);
  assert.equal(o.head.length, 500);
});

test('CRLF 正文一样能抽', () => {
  const o = outlineOf('# 标题\r\n\r\n## 小节\r\n\r\n正文\r\n');
  assert.equal(o.h1, '标题');
  assert.deepEqual(o.subs, ['小节']);
});

test('闭合式 ATX 标题的尾部井号会被去掉', () => {
  const o = outlineOf('# 标题 #\n## 小节 ##\n');
  assert.equal(o.h1, '标题');
  assert.deepEqual(o.subs, ['小节']);
});

test('无标题的纯正文', () => {
  const o = outlineOf('就是一段普通文字，没有任何标题。');
  assert.equal(o.h1, '');
  assert.deepEqual(o.subs, []);
  assert.equal(o.head, '就是一段普通文字，没有任何标题。');
});

test('空输入与非字符串输入不抛错', () => {
  for (const bad of ['', null, undefined, 123, {}]) {
    const o = outlineOf(bad);
    assert.equal(typeof o.h1, 'string');
    assert.ok(Array.isArray(o.subs));
    assert.equal(typeof o.head, 'string');
  }
});

test('`#` 后面没有空格的不算标题', () => {
  // `#hashtag` 不是 ATX 标题，收进来会污染提纲
  const o = outlineOf('#不是标题\n# 是标题\n');
  assert.equal(o.h1, '是标题');
});

// ---------- fallbackDescription ----------

test('兜底描述格式：标题 —— 覆盖前三个小节。触发语', () => {
  const out = fallbackDescription({ h1: '统一弹框规范', subs: ['十条硬规则', '弹框里有输入框', '内容高度与内部滚动', '模板骨架'] });
  assert.equal(out, '统一弹框规范 —— 覆盖十条硬规则、弹框里有输入框、内容高度与内部滚动。修改相关内容时调用本技能。');
});

test('兜底描述最多列三个小节', () => {
  const out = fallbackDescription({ h1: 'T', subs: ['A', 'B', 'C', 'D', 'E'] });
  assert.ok(out.includes('A、B、C。'));
  assert.ok(!out.includes('D'));
});

test('没有小节时省掉「覆盖」那一截', () => {
  const out = fallbackDescription({ h1: '某规范', subs: [] });
  assert.equal(out, '某规范 —— 修改相关内容时调用本技能。');
});

test('没有 h1 时用占位标题', () => {
  const out = fallbackDescription({ h1: '', subs: ['A'] });
  assert.ok(out.startsWith('本项目规范 —— '));
});

test('兜底描述永远是单行', () => {
  // YAML 单行标量不能含换行，否则加载 skill 时 frontmatter 解析会崩
  const out = fallbackDescription({ h1: '标\n题', subs: ['小\n节'] });
  assert.ok(!/\n/.test(out), '不该含换行');
});

test('缺参数 / 空对象不抛错', () => {
  assert.equal(typeof fallbackDescription(), 'string');
  assert.equal(typeof fallbackDescription({}), 'string');
  assert.ok(fallbackDescription({ subs: null }).length > 0);
});

test('小节里的空串被过滤掉，不会留下悬空的顿号', () => {
  const out = fallbackDescription({ h1: 'T', subs: ['', '  ', 'A', 'B'] });
  assert.ok(out.includes('覆盖A、B。'));
});

test('兜底描述长度足以通过 describeSkill 的最短校验', () => {
  // MIN_DESCRIPTION_LEN = 10；兜底自己要是过不了校验，降级路径就成了死循环
  assert.ok(fallbackDescription({ h1: 'T', subs: [] }).length >= 10);
});

// ---------- toYamlScalar ----------
//
// 这一组测的都是「会让 skill 加载失败或内容被悄悄截断」的写法，比描述写得差严重得多：
// 前者整份规范直接失踪，后者至少还留着半句。buildSkillFile 是裸拼 `description: <值>`，
// 没有引号保护，所以值本身必须已经是合法的 YAML 单行纯量。

test('压掉换行与连续空白', () => {
  assert.equal(toYamlScalar('第一行\n第二行  第三行'), '第一行 第二行 第三行');
});

test('去掉整体包裹的引号', () => {
  // 模型很爱回 `"..."`；值以引号开头会被 YAML 当成带引号标量，内部再有引号就是语法错误
  assert.equal(toYamlScalar('"弹框规范"'), '弹框规范');
  assert.equal(toYamlScalar('「弹框规范」'), '弹框规范');
});

test('句中的「冒号+空格」换成全角', () => {
  // `: ` 是 YAML 纯量里的键值分隔符，出现在值里会把这一行解析成嵌套映射
  assert.equal(toYamlScalar('适用场景: 新增弹框时'), '适用场景：新增弹框时');
});

test('结尾的冒号换成全角', () => {
  // 行尾的 `:` 同样是映射指示符（`description: 适用于:` 直接抛 YAML 语法错误）。
  // 原实现只匹配 `:\s`，而结尾冒号后面没有空白，正好从这个规则底下漏过去。
  assert.equal(toYamlScalar('适用于:'), '适用于：');
  assert.equal(toYamlScalar('适用于::'), '适用于：');
});

test('「空格 + #」换成全角井号', () => {
  // YAML 里前面挨着空白的 # 起注释作用，`description: 处理 #tag 语法` 会被截成「处理」，
  // 而且截断是静默的——skill 照常加载，只是触发场景那半句没了
  assert.equal(toYamlScalar('处理 #tag 语法的输入框'), '处理 ＃tag 语法的输入框');
});

test('句中的井号不受影响', () => {
  // 前面不挨空白的 # 是普通字符（YAML 规则如此），改掉反而篡改了原意
  assert.equal(toYamlScalar('排查 C#调用问题'), '排查 C#调用问题');
});

test('去掉开头的 YAML 指示符', () => {
  // 只有**首字符**是指示符才有语法意义；出现在句中的同样字符是普通字符，不必动
  assert.equal(toYamlScalar('[弹框] 新增弹框时使用'), '弹框] 新增弹框时使用');
  assert.equal(toYamlScalar('- 新增弹框时使用'), '新增弹框时使用');
  assert.equal(toYamlScalar('# 弹框规范'), '弹框规范');
  assert.equal(toYamlScalar('> 弹框规范'), '弹框规范');
  assert.equal(toYamlScalar('*弹框规范'), '弹框规范');
});

test('中文开头的正常描述一个字都不动', () => {
  const ok = '本项目统一弹框规范（十条硬规则）。当需要新增弹框、排查弹框白屏时使用。';
  assert.equal(toYamlScalar(ok), ok);
});

test('空输入与非字符串输入不抛错', () => {
  for (const bad of ['', null, undefined, 123, {}]) {
    assert.equal(typeof toYamlScalar(bad), 'string');
  }
});

test('兜底描述本身已满足 YAML 纯量约束', () => {
  // 兜底文案是拼装出来的，小节标题里带 `:` 或 `#` 会顺着模板漏进 frontmatter
  const out = fallbackDescription({ h1: '规范: 总纲', subs: ['第一步: 提取', '处理 #tag'] });
  assert.equal(out, toYamlScalar(out), '兜底产物应当已经是合法纯量');
});
