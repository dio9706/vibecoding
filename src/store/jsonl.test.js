import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// APP_DATA_DIR 必须在任何 store 模块被引入**之前**设定：store/index.js 的 DATA_DIR 是模块级
// 常量，且它以无查询串的 './index.js' 被引入 → 全进程只实例化一次，用 ?case= 打散被测模块
// 也换不掉它（实测：设 A 写一条、改 B 再用新实例写一条，两条都落在 A）。
// 故整个文件共享一个数据目录，各用例靠不同文件名互相隔离。
const TMP = path.join(os.tmpdir(), `cad-jsonl-test-${process.pid}`);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.APP_DATA_DIR = TMP;

const { readJsonl, compactJsonl, withinRetention } = await import('./jsonl.js');

after(() => {
  delete process.env.APP_DATA_DIR;
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('readJsonl：按文件序返回（旧→新），坏行跳过，缺文件返回空数组', () => {
  assert.deepStrictEqual(readJsonl('missing.jsonl'), [], '文件不存在应返回空数组');

  fs.writeFileSync(
    path.join(TMP, 'read.jsonl'),
    ['{"n":1}', '', '{"n":2', '{"n":3}', '   '].join('\n') + '\n',
  );
  assert.deepStrictEqual(
    readJsonl('read.jsonl').map((e) => e.n),
    [1, 3],
    '空行与半行（进程被杀留下）应跳过，其余保持文件序',
  );
});

test('withinRetention：时间窗含边界，time 缺失/不可解析一律保留', () => {
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const iso = (ms) => new Date(ms).toISOString();

  assert.equal(withinRetention({ time: iso(now) }, now, 3 * DAY), true);
  assert.equal(withinRetention({ time: iso(now - 3 * DAY) }, now, 3 * DAY), true, '3 天整边界应保留');
  assert.equal(withinRetention({ time: iso(now - 3 * DAY - 1000) }, now, 3 * DAY), false);
  assert.equal(withinRetention({}, now, 3 * DAY), true, 'time 缺失应保留，避免误删');
  assert.equal(withinRetention({ time: 'not-a-date' }, now, 3 * DAY), true);
});

test('compactJsonl：超限裁尾部保留最新 + 时间窗过滤 + 无变化不写盘', async () => {
  const file = path.join(TMP, 'c.jsonl');

  // 1) 仅条数超限
  fs.writeFileSync(file, [1, 2, 3, 4, 5].map((n) => JSON.stringify({ n })).join('\n') + '\n');
  compactJsonl('c.jsonl', { max: 3 });
  assert.deepStrictEqual(
    readJsonl('c.jsonl').map((e) => e.n),
    [3, 4, 5],
    '应保留最新 3 条（尾部）',
  );

  // 2) 无变化不写盘：mtime 不应改变
  const before = fs.statSync(file).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  compactJsonl('c.jsonl', { max: 3 });
  assert.equal(fs.statSync(file).mtimeMs, before, '未超限未过期时不应触碰文件');

  // 3) 时间窗过滤
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ n: 'old', time: new Date(now - 4 * DAY).toISOString() }),
      JSON.stringify({ n: 'new', time: new Date(now).toISOString() }),
    ].join('\n') + '\n',
  );
  compactJsonl('c.jsonl', { max: 100, retainMs: 3 * DAY });
  assert.deepStrictEqual(readJsonl('c.jsonl').map((e) => e.n), ['new']);
});

test('compactJsonl：全部被清空时写出空文件而非留下坏行', () => {
  const file = path.join(TMP, 'e.jsonl');
  const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify({ n: 1, time: old }) + '\n');

  compactJsonl('e.jsonl', { max: 10, retainMs: 24 * 60 * 60 * 1000 });
  assert.equal(fs.readFileSync(file, 'utf8'), '', '全过期应得到空文件');
  assert.deepStrictEqual(readJsonl('e.jsonl'), []);
});
