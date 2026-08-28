import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRootMapPrompt, buildModuleMapPrompt, buildStaleAuditPrompt,
  validateRootMap, validateModuleMap, validateStaleFindings, MAP_SYSTEM_PROMPT,
} from './gen-map.logic.js';

// ---------- prompt ----------

test('根地图 prompt 含事实包、三项必写内容与 JSON 输出约定', () => {
  const p = buildRootMapPrompt('### 目录结构\n\nsrc/');
  assert.ok(p.includes('### 目录结构'));
  assert.ok(p.includes('项目定位'));
  assert.ok(p.includes('常用命令'));
  assert.ok(p.includes('模块路由表'));
  assert.ok(p.includes('{"markdown":'), '必须要求返回 JSON 对象');
  assert.ok(p.includes('200'), '必须写明行数上限');
});

test('模块地图 prompt 带上模块路径', () => {
  const p = buildModuleMapPrompt('src/features', '### 文件清单\n\n- a.js');
  assert.ok(p.includes('src/features'));
  assert.ok(p.includes('- a.js'));
  assert.ok(p.includes('{"markdown":'));
});

test('核对 prompt 要求只报差异、不要重写地图', () => {
  // 这是 M3「只追加不覆盖」承诺在提示词层的落点
  const p = buildStaleAuditPrompt('src/a/CLAUDE.md', '# 旧地图', '### 文件清单');
  assert.ok(p.includes('# 旧地图'));
  assert.ok(p.includes('{"findings":'));
  assert.ok(/不要重写|不需要重写|只列/.test(p));
});

test('系统提示词声明只读，禁止写入', () => {
  assert.ok(/只能读|禁止写入/.test(MAP_SYSTEM_PROMPT.custom));
  assert.equal(MAP_SYSTEM_PROMPT.type, 'custom');
});

// ---------- validateRootMap ----------

const goodRoot = [
  '# 某项目', '',
  '## 项目定位', '',
  '一个做 X 的工具，解决 Y 问题，服务于 Z 场景。核心是把分散的信息收拢成一份可读的索引。', '',
  '## 常用命令', '',
  '- `npm test` 跑全部测试',
  '- `npm start` 起本地服务',
  '- `npm run build` 打包发布产物', '',
  '## 模块路由表', '',
  '| 模块 | 职责 |', '| --- | --- |',
  '| `src/a/` | 干 A，入口与参数校验 |',
  '| `src/b/` | 干 B，持久化 |',
  '| `src/c/` | 干 C，对外查询接口 |',
].join('\n');

test('合格的根地图通过质量闸', () => {
  assert.ok(goodRoot.length > 200, '夹具必须先过长度闸');
  assert.equal(validateRootMap(goodRoot).ok, true);
});

test('太短的产出被拒', () => {
  // 写一份糊弄的地图比不写更糟：M1/M2 不再报缺失、分数上涨，而内容是错的，
  // 之后每一次会话都会被它误导
  const out = validateRootMap('# 项目\n\n没了。');
  assert.equal(out.ok, false);
  assert.match(out.reason, /过短/);
});

test('缺「命令」相关内容的根地图被拒', () => {
  // 夹具刻意避开「命令 / scripts / npm / 怎么跑 / 运行 / 启动 / 构建」这些词，
  // 否则会意外满足那条判据，测不到目标分支
  const md = [
    '# 某项目', '',
    '## 定位', '',
    '一个做 X 的工具，解决 Y 问题，服务于 Z 场景。它的定位是把分散在各处的信息收拢成一份可读的索引，',
    '让接手的人不必从零摸索。这段话唯一的作用是把长度撑过下限，好让长度那条判据不要抢在前面拦下。', '',
    '## 模块路由表', '',
    '| 模块 | 职责 |', '| --- | --- |', '| `src/a/` | 干 A |', '| `src/b/` | 干 B |',
    '| `src/c/` | 干 C，负责把前两者的产物收拢起来对外提供查询 |',
  ].join('\n');
  assert.ok(md.length > 200, '夹具必须先过长度闸，否则测不到目标分支');
  const out = validateRootMap(md);
  assert.equal(out.ok, false);
  assert.match(out.reason, /命令/);
});

test('超过 200 行的根地图被拒', () => {
  // 刚生成就撞上 M5 的阈值，等于生产一个新问题来换旧问题
  const out = validateRootMap(goodRoot + '\n' + '- 填充行\n'.repeat(210));
  assert.equal(out.ok, false);
  assert.match(out.reason, /200/);
});

test('非字符串输入被拒而不抛错', () => {
  for (const bad of [null, undefined, 42, {}]) assert.equal(validateRootMap(bad).ok, false);
});

// ---------- validateModuleMap ----------

test('合格的模块地图通过', () => {
  const md = [
    '# src/features', '',
    '## 文件清单', '',
    '- `a.js` 入口，负责参数校验与分发',
    '- `b.js` 持久化层，所有落库都走它',
    '- `c.logic.js` 纯逻辑，不碰 IO，被 a 和 b 共用', '',
    '## 关键流程', '',
    '请求先进 `a.js` 做校验，校验通过后调 `c.logic.js` 算出待写入的结构，',
    '再交给 `b.js` 落库，最后由 `a.js` 回写状态并返回。', '',
    '## 常见改动入口', '',
    '要改校验规则就改 `a.js`；要加数据库字段去 `b.js`；纯计算逻辑的调整只动 `c.logic.js`。',
  ].join('\n');
  assert.equal(validateModuleMap(md).ok, true);
});

test('只有文件清单、没有流程与改动入口的模块地图被拒', () => {
  // 这正是「纯事实包零工具」方案会产出的东西——ls 的复述，对导航没有增量价值
  const md = ['# src/features', '', '## 文件清单', '',
    ...Array.from({ length: 30 }, (_, i) => `- \`f${i}.js\` 是第 ${i} 个文件`)].join('\n');
  const out = validateModuleMap(md);
  assert.equal(out.ok, false);
  assert.match(out.reason, /流程|改动入口/);
});

// ---------- validateStaleFindings ----------

test('findings 数组被规整成字符串列表', () => {
  const out = validateStaleFindings(['  条目一  ', '条目二', '', null]);
  assert.equal(out.ok, true);
  assert.deepEqual(out.findings, ['条目一', '条目二']);
});

test('空数组是合法结果（核对过、没发现差异）', () => {
  const out = validateStaleFindings([]);
  assert.equal(out.ok, true);
  assert.deepEqual(out.findings, []);
});

test('非数组被拒', () => {
  assert.equal(validateStaleFindings('一条文本').ok, false);
  assert.equal(validateStaleFindings(null).ok, false);
});

test('条目过多时截断', () => {
  const out = validateStaleFindings(Array.from({ length: 50 }, (_, i) => `第 ${i} 条`));
  assert.equal(out.ok, true);
  assert.equal(out.findings.length, 20);
});
