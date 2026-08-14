import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 必须在 import user-log.js 之前设置：store/index.js 在模块加载时就把 DATA_DIR 定死了
process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'userlog-'));
const { appendUserLog, readUserLog, userLogStats, userLogFile } = await import('./user-log.js');

test('文件不存在时：读回空、统计全零，且不抛错', () => {
  assert.deepEqual(readUserLog(), { entries: [], offset: 0 });
  assert.deepEqual(userLogStats(), { count: 0, chars: 0, bytes: 0, firstAt: null, lastAt: null });
});

test('追加后可回读，字段完整且 text 逐字无损', () => {
  const text = '  以后注释一律用中文\n\n包含空行、末尾空格 和 emoji 🚀  ';
  assert.equal(
    appendUserLog({
      at: 1000,
      text,
      source: 'web',
      kind: 'send',
      convId: 'c1',
      sessionId: 's1',
      cwd: 'C:\\proj',
      model: 'sonnet',
    }),
    true,
  );
  const { entries } = readUserLog();
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    at: 1000,
    text, // 一个字符都不能少：首尾空白/换行/emoji 原样保留
    source: 'web',
    kind: 'send',
    convId: 'c1',
    sessionId: 's1',
    cwd: 'C:\\proj',
    model: 'sonnet',
  });
});

test('steer（插话打断）作为独立 kind 被如实记录', () => {
  appendUserLog({ at: 2000, text: '停，别改那个文件', source: 'web', kind: 'steer', convId: 'c1' });
  const { entries } = readUserLog();
  assert.equal(entries[1].kind, 'steer');
  assert.equal(entries[1].sessionId, null); // 未传的字段归 null，不是 undefined（JSONL 里 undefined 会整个字段消失）
});

test('kind 非法值 fail-closed 归 send —— 绝不能把未知输入误标成高价值的 steer', () => {
  appendUserLog({ at: 3000, text: '飞书这边说一句', source: 'feishu', kind: 'whatever' });
  const { entries } = readUserLog();
  assert.equal(entries[2].kind, 'send');
  assert.equal(entries[2].source, 'feishu');
});

test('游标读取：offset 续读只拿新增部分，且返回的 offset 可继续用', () => {
  const first = readUserLog({ limit: 1 });
  assert.equal(first.entries.length, 1);
  assert.equal(first.entries[0].at, 1000);
  assert.ok(first.offset > 0);

  const rest = readUserLog({ offset: first.offset });
  assert.deepEqual(
    rest.entries.map((e) => e.at),
    [2000, 3000],
  );

  // 追平后再读：无新增
  const empty = readUserLog({ offset: rest.offset });
  assert.deepEqual(empty.entries, []);
  assert.equal(empty.offset, rest.offset);

  // 新增一条后，老游标只读到增量
  appendUserLog({ at: 4000, text: '又一条', source: 'web' });
  const inc = readUserLog({ offset: rest.offset });
  assert.deepEqual(
    inc.entries.map((e) => e.at),
    [4000],
  );
});

test('时间范围：since 独占、until 含界', () => {
  const { entries } = readUserLog({ since: 1000, until: 3000 });
  assert.deepEqual(
    entries.map((e) => e.at),
    [2000, 3000],
  );
});

test('until 命中时游标停在该处，不吞掉窗口之外的后续记录', () => {
  const r = readUserLog({ until: 2000 });
  assert.deepEqual(
    r.entries.map((e) => e.at),
    [1000, 2000],
  );
  // 用返回的 offset 续读，被 until 挡住的那条必须还在
  const next = readUserLog({ offset: r.offset });
  assert.deepEqual(
    next.entries.map((e) => e.at),
    [3000, 4000],
  );
});

test('统计：条数与字符数', () => {
  const s = userLogStats();
  assert.equal(s.count, 4);
  assert.equal(s.firstAt, 1000);
  assert.equal(s.lastAt, 4000);
  const { entries } = readUserLog();
  assert.equal(
    s.chars,
    entries.reduce((a, e) => a + e.text.length, 0),
  );
  assert.ok(s.bytes > 0);
});

test('空/畸形输入一律拒写，不落坏数据也不抛错', () => {
  const before = userLogStats().count;
  assert.equal(appendUserLog(), false);
  assert.equal(appendUserLog(null), false);
  assert.equal(appendUserLog({ text: '' }), false);
  assert.equal(appendUserLog({ text: '   \n  ' }), false); // 纯空白等于没说话
  assert.equal(appendUserLog({ text: 123 }), false); // 非字符串
  assert.equal(appendUserLog({ text: { a: 1 } }), false);
  assert.equal(userLogStats().count, before);
});

test('坏行（进程被杀留下的半截 JSON）跳过，不影响其余行', () => {
  fs.appendFileSync(userLogFile(), '{"at":5000,"text":"半截\n');
  appendUserLog({ at: 6000, text: '坏行之后的正常记录', source: 'web' });
  const { entries } = readUserLog();
  assert.deepEqual(
    entries.map((e) => e.at),
    [1000, 2000, 3000, 4000, 6000],
  );
});

test('未以换行结尾的尾行不被消费：游标停在最后一个完整行，等它写完下轮再读', () => {
  const done = readUserLog();
  fs.appendFileSync(userLogFile(), '{"at":7000,"text":"还没写完的一行"'); // 无结尾 \n
  const r = readUserLog({ offset: done.offset });
  assert.deepEqual(r.entries, []);
  assert.equal(r.offset, done.offset);
  fs.appendFileSync(userLogFile(), '}\n'); // 补齐
  const r2 = readUserLog({ offset: done.offset });
  assert.deepEqual(
    r2.entries.map((e) => e.at),
    [7000],
  );
});

test('非字符串元数据归一为 null —— 循环引用之类的东西根本进不到 JSON.stringify', () => {
  const circular = { id: 'x' };
  circular.self = circular;
  assert.equal(appendUserLog({ at: 9000, text: '带脏元数据', source: 'web', convId: circular, cwd: 42 }), true);
  const { entries } = readUserLog({ since: 8000 });
  assert.equal(entries[0].convId, null);
  assert.equal(entries[0].cwd, null);
});

// 必须放最后：把日志文件替换成目录会让后续所有读写都失败
test('写盘失败静默降级：返回 false，绝不向上抛（不能因为记日志把用户对话弄挂）', () => {
  const file = userLogFile();
  fs.rmSync(file, { force: true });
  fs.mkdirSync(file); // 同名目录 → appendFileSync 必然报错
  assert.equal(appendUserLog({ at: 10000, text: '写不进去', source: 'web' }), false);
  // 读取侧同样不能抛
  assert.deepEqual(readUserLog(), { entries: [], offset: 0 });
  assert.deepEqual(userLogStats(), { count: 0, chars: 0, bytes: 0, firstAt: null, lastAt: null });
});
