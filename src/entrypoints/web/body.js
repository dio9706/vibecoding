/**
 * 请求体读取收口 —— 替代散落在 routes-* 的 24 处 `let body=''; req.on('data', c => body += c)`。
 *
 * 那个写法叠了三个缺陷：
 *  1. **无大小上限**：灌 4GB body 即单请求 OOM（同仓 /api/upload 等三处本来就有上限，属遗漏）。
 *  2. **按块 toString**：`body += c` 让每个 Buffer 块各自 utf8 解码，多字节字符跨块被切成 U+FFFD，
 *     而 JSON.parse 照样成功（U+FFFD 是合法 JSON 字符串字符）→ 中文 prompt 被静默污染，无任何报错。
 *     本项目主用中文 prompt，>64KB 即触发。必须 Buffer.concat 后整体解码。
 *  3. **顶层 null**：`JSON.parse('null')` 得到 null，调用方 `data.prompt` 直接 TypeError；
 *     该异常抛在 req 的 'end' 监听器里 → uncaughtException → 进程退出。
 */

import { sendJson } from './http-util.js';
import { logger } from '../../shared/logger.js';

/** 默认 1MB：管理类 API 的 body 都是小 JSON；上传走 routes-files 自己的上限。 */
const DEFAULT_MAX_BYTES = 1024 * 1024;

/**
 * 读取并解析 JSON 请求体。**不抛异常**，始终以结构化结果返回。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{maxBytes?: number}} [opts]
 * @returns {Promise<{ok:true, data:object} | {ok:false, status:number, error:string}>}
 */
export function readJsonBody(req, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const done = (r) => {
      if (settled) return; // 防重：超限 destroy 后可能仍有一次 'data'/'error' 派发
      settled = true;
      resolve(r);
    };

    req.on('data', (c) => {
      if (settled) return;
      size += c.length; // Buffer.length 是字节数，中文按 3 字节计
      if (size > maxBytes) {
        // 不 destroy、也不 pause，而是**丢弃已缓冲的数据并把剩余上行排空**。
        // 实测过的两条错误做法：
        //   - req.destroy()：把响应通道一并杀掉，客户端只看到 ECONNRESET，看不到 413
        //   - req.pause()  ：上行不再被读取，socket 缓冲写满后同样以重置收场
        // resume() 把余下字节读掉即丢，内存仍然有界（不再往 chunks 里塞），
        // 响应得以完整送达，连接也能正常收尾。
        chunks.length = 0;
        req.resume();
        return done({ ok: false, status: 413, error: '请求体过大' });
      }
      chunks.push(c);
    });

    req.on('end', () => {
      // 整体解码，而不是逐块 —— 这是中文不被截断的关键
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return done({ ok: true, data: {} });
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return done({ ok: false, status: 400, error: '请求体不是合法 JSON' });
      }
      // null 与标量归一为 {}：调用方一律按对象取字段，不能让 data.x 抛 TypeError
      if (parsed === null || typeof parsed !== 'object') return done({ ok: true, data: {} });
      done({ ok: true, data: parsed });
    });

    // 客户端中途断连：判负而不是让 Promise 永久挂起（挂起会连带泄漏 res）
    req.on('error', () => done({ ok: false, status: 400, error: '请求中断' }));
  });
}

/**
 * 读 body → 交给业务回调，并兜住回调抛出的一切异常。
 *
 * 替代 `req.on('end', async () => {...})` 这个写法：回调内抛错时既没有 catch，
 * 全仓也没有进程级 uncaughtException/unhandledRejection 兜底，后果是
 * **进程退出 + 该请求永久挂死**（res 从未 end）。典型触发：routes-run 的
 * startClaudeRun 同步抛错、routes-ops 的 updateTask 写盘 EPERM/ENOSPC。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {(data:object)=>any} fn 业务回调，可同步可 async
 * @param {{maxBytes?: number}} [opts]
 */
export async function withJsonBody(req, res, fn, opts) {
  const r = await readJsonBody(req, opts);
  if (!r.ok) {
    // 超限的连接不再复用：body 已被丢弃，keep-alive 会让后续请求错位读到残留字节
    if (r.status === 413) res.setHeader('Connection', 'close');
    return sendJson(res, r.status, { error: r.error });
  }
  try {
    return await fn(r.data);
  } catch (e) {
    logger.error('http', '请求处理异常', { err: e?.message || String(e) });
    // 回调可能已经先发过响应（如先 sendJson(200) 再异步起任务时炸），
    // 此时再写头会抛 ERR_HTTP_HEADERS_SENT，必须先判 headersSent。
    if (!res.headersSent) sendJson(res, 500, { error: '服务器内部错误' });
  }
}
