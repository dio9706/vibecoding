import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readJsonBody, withJsonBody } from './body.js';

/**
 * 背景：web 入口有 24 处「let body=''; req.on('data', c => body += c)」，三个缺陷叠加：
 *   1. 无大小上限 → 灌 4GB body 即 OOM
 *   2. `body += c` 对每个 Buffer 块独立 toString('utf8')，多字节字符跨块被切成 U+FFFD，
 *      而 JSON.parse 照样成功（U+FFFD 是合法 JSON 字符串字符）→ 中文 prompt 被静默污染
 *   3. JSON.parse 'null' 得到 null，后续 data.prompt 直接 TypeError → 进程崩
 * readJsonBody 统一收口这三点。
 */

/** 用真实 Readable（IncomingMessage 的基类）驱动，按给定分块喂数据 */
function reqOf(chunks) {
  const r = new Readable({ read() {} });
  queueMicrotask(() => {
    for (const c of chunks) r.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    r.push(null);
  });
  return r;
}

test('readJsonBody：正常 JSON 解析为对象', async () => {
  const r = await readJsonBody(reqOf(['{"prompt":"hi","n":1}']));
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, { prompt: 'hi', n: 1 });
});

test('readJsonBody：空 body 视为 {}（沿用旧行为 JSON.parse(body || "{}")）', async () => {
  const r = await readJsonBody(reqOf([]));
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, {});
});

test('readJsonBody：中文在 chunk 边界被切开时仍能完整还原（核心回归）', async () => {
  const payload = JSON.stringify({ prompt: '中'.repeat(2000) });
  const buf = Buffer.from(payload, 'utf8');
  // 在多字节字符中间切开：'中' = E4 B8 AD，切点落在字符内部
  const cut = 10;
  assert.notEqual(buf[cut], buf.toString('utf8').charCodeAt(0)); // 确认切点确实在多字节序列里
  const r = await readJsonBody(reqOf([buf.subarray(0, cut), buf.subarray(cut)]));

  assert.equal(r.ok, true);
  assert.equal(r.data.prompt, '中'.repeat(2000));
  assert.equal(r.data.prompt.includes('�'), false, '出现替换字符 → 仍在按块 toString');
});

test('readJsonBody：超过 maxBytes 判负并给 413', async () => {
  const r = await readJsonBody(reqOf(['x'.repeat(5000)]), { maxBytes: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.status, 413);
});

test('readJsonBody：上限按字节计而非字符数（中文 3 字节）', async () => {
  // 400 个中文 = 1200 字节，超过 1000 字节上限
  const r = await readJsonBody(reqOf([Buffer.from('中'.repeat(400), 'utf8')]), { maxBytes: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.status, 413);
});

test('readJsonBody：畸形 JSON 判负并给 400，不抛异常', async () => {
  const r = await readJsonBody(reqOf(['{not json']));
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test('readJsonBody：JSON null 归一为 {}，避免调用方 data.x 抛 TypeError', async () => {
  const r = await readJsonBody(reqOf(['null']));
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, {});
});

test('readJsonBody：顶层为标量时归一为 {}', async () => {
  for (const raw of ['123', '"hi"', 'true']) {
    const r = await readJsonBody(reqOf([raw]));
    assert.equal(r.ok, true, `raw=${raw}`);
    assert.deepEqual(r.data, {}, `raw=${raw}`);
  }
});

test('readJsonBody：流出错时判负而不是永久挂起', async () => {
  const req = new Readable({ read() {} });
  queueMicrotask(() => req.destroy(new Error('socket hang up')));
  const r = await readJsonBody(req);
  assert.equal(r.ok, false);
});

// ── withJsonBody ───────────────────────────────────────────────
// 背景：多个 handler 写成 `req.on('end', async () => {...})`，回调内抛错既没有 catch
// 也没有进程级兜底 → unhandledRejection 崩进程，且 res 从未 end → 请求永久挂死。
// 典型：routes-run.js 的 startClaudeRun 同步抛错、routes-ops.js 的 updateTask 写盘 EPERM。

/** 记录写入的最小 res 替身（覆盖 sendJson / withJsonBody 用到的表面） */
function resSpy() {
  return {
    statusCode: 0,
    body: '',
    headersSent: false,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
      return this;
    },
    writeHead(code) {
      this.statusCode = code;
      this.headersSent = true;
      return this;
    },
    end(s) {
      this.body = s || '';
      return this;
    },
  };
}

test('withJsonBody：body 正常时把解析结果交给回调', async () => {
  const res = resSpy();
  let got = null;
  await withJsonBody(reqOf(['{"a":1}']), res, (data) => {
    got = data;
  });
  assert.deepEqual(got, { a: 1 });
});

test('withJsonBody：body 超限时不调用回调，直接回 413', async () => {
  const res = resSpy();
  let called = false;
  await withJsonBody(
    reqOf(['x'.repeat(99)]),
    res,
    () => {
      called = true;
    },
    { maxBytes: 10 },
  );
  assert.equal(called, false, '超限时业务回调不应被执行');
  assert.equal(res.statusCode, 413);
});

test('withJsonBody：回调同步抛错 → 回 500，不冒泡（核心回归：否则崩进程）', async () => {
  const res = resSpy();
  await withJsonBody(reqOf(['{}']), res, () => {
    throw new Error('startClaudeRun 同步炸了');
  });
  assert.equal(res.statusCode, 500);
});

test('withJsonBody：回调返回的 Promise reject → 回 500，不产生 unhandledRejection', async () => {
  const res = resSpy();
  await withJsonBody(reqOf(['{}']), res, async () => {
    throw new Error('await 里炸了');
  });
  assert.equal(res.statusCode, 500);
});

test('withJsonBody：超限时客户端应收到干净的 413，而不是连接被重置', async () => {
  // 真服务器 + 真 fetch：早先的实现在 'data' 里直接 req.destroy()，
  // 把响应通道一起杀了 → 客户端拿到 ECONNRESET 而非 413（实测复现）。
  //
  // body 取 8KB 而非 512KB：8KB 能一次性写进 socket 缓冲，客户端在服务端响应前就发完了，
  // 因而结果是**确定的**。512KB 会边传边被响应打断，在满载 CI 上偶发 ECONNRESET —— 那是
  // 「响应早于上传结束」的固有竞态（nginx/express 同样存在），不是本条要守的回归。
  // 对 destroy() 那个 bug 而言两种体量的区分力相同：它会无差别地立刻重置连接。
  const { createServer } = await import('node:http');
  const server = createServer((req, res) =>
    withJsonBody(req, res, () => sendJsonLocal(res, 200, { ok: true }), { maxBytes: 1024 }),
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ big: 'x'.repeat(8 * 1024) }),
    });
    assert.equal(res.status, 413);
  } finally {
    server.close();
  }
});

function sendJsonLocal(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

test('withJsonBody：回调已先发响应再抛错 → 不重复写头（防 ERR_HTTP_HEADERS_SENT）', async () => {
  const res = resSpy();
  await withJsonBody(reqOf(['{}']), res, () => {
    res.writeHead(200);
    res.end('{"ok":true}');
    throw new Error('响应发出后才炸');
  });
  assert.equal(res.statusCode, 200, '已发出的响应状态不应被 500 覆盖');
  assert.equal(res.body, '{"ok":true}');
});
