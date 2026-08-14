import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFirstLines } from './read-first-lines.js';

/**
 * 背景：history.js 的 parseSessionMetadata 注释写着「避免读取整个大文件」，
 * 实现却是 `await fs.promises.readFile(filePath,'utf8')` 然后 `.split('\n').slice(0,50)` ——
 * 为了前 50 行把整个文件读进内存。listHistorySessions 对目录下**每个** jsonl 都调一次。
 * 实测本机某个 project 目录：325 个 jsonl / 共 2.1GB，单文件最大 40MB。
 * 一次 GET /api/history 就会串行读完 2.1GB 并做同样体量的字符串分配。
 */

/** 造一个可记录「被消费了多少块」的流，用来证明确实提前停止了 */
function countingStream(chunks) {
  const consumed = [];
  const s = new Readable({
    read() {
      const c = chunks[consumed.length];
      if (c === undefined) return this.push(null);
      consumed.push(c);
      this.push(c);
    },
  });
  s.consumed = consumed;
  return s;
}

test('readFirstLines：返回不超过 maxLines 行', async () => {
  const lines = await readFirstLines('x', 3, {
    createStream: () => countingStream(['a\nb\nc\nd\ne\n']),
  });
  assert.deepEqual(lines, ['a', 'b', 'c']);
});

test('readFirstLines：拿够行数后立即停止消费后续数据（核心回归：不整读）', async () => {
  let stream;
  const chunks = ['l1\nl2\n', 'l3\nl4\n', 'l5\nl6\n', 'l7\nl8\n'];
  await readFirstLines('x', 2, {
    createStream: () => (stream = countingStream(chunks)),
  });
  assert.ok(
    stream.consumed.length < chunks.length,
    `拿够 2 行后仍消费了全部 ${stream.consumed.length}/${chunks.length} 块 —— 说明还在整读`,
  );
});

test('readFirstLines：文件行数少于 maxLines 时返回全部', async () => {
  const lines = await readFirstLines('x', 50, { createStream: () => countingStream(['a\nb\n']) });
  assert.deepEqual(lines, ['a', 'b']);
});

test('readFirstLines：最后一行没有换行符时也不丢', async () => {
  const lines = await readFirstLines('x', 50, { createStream: () => countingStream(['a\nb\nc']) });
  assert.deepEqual(lines, ['a', 'b', 'c']);
});

test('readFirstLines：空内容返回空数组', async () => {
  assert.deepEqual(await readFirstLines('x', 10, { createStream: () => countingStream([]) }), []);
  assert.deepEqual(await readFirstLines('x', 10, { createStream: () => countingStream(['']) }), []);
});

test('readFirstLines：一行被切在多个 chunk 里能正确拼回', async () => {
  const lines = await readFirstLines('x', 10, {
    createStream: () => countingStream(['{"ty', 'pe":"us', 'er"}\n{"type":"assistant"}\n']),
  });
  assert.deepEqual(lines, ['{"type":"user"}', '{"type":"assistant"}']);
});

test('readFirstLines：真实文件——只读开头即可拿到前几行（大文件不受总体积拖累）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfl-'));
  const f = path.join(dir, 'big.jsonl');
  // 前 3 行是有效数据，后面追加 8MB 填充，模拟长会话
  const head = ['{"type":"user"}', '{"type":"assistant"}', '{"type":"user"}'].join('\n') + '\n';
  fs.writeFileSync(f, head + ('{"type":"padding","d":"' + 'x'.repeat(4000) + '"}\n').repeat(2000));
  try {
    const t0 = Date.now();
    const lines = await readFirstLines(f, 3);
    assert.deepEqual(lines, ['{"type":"user"}', '{"type":"assistant"}', '{"type":"user"}']);
    assert.ok(Date.now() - t0 < 1000, '读前 3 行不该受文件总体积影响');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readFirstLines：文件不存在时抛错（调用方已有 try/catch）', async () => {
  await assert.rejects(() => readFirstLines(path.join(os.tmpdir(), 'nope-' + Date.now()), 5));
});
