/**
 * 只读文件开头若干行 —— 拿够就立刻停止读盘。
 *
 * 存在的理由：history.js 的元数据提取注释写着「避免读取整个大文件」，实现却是
 * `readFile(整个文件)` 再 `.split('\n').slice(0, 50)`，而 listHistorySessions 对目录下
 * **每个** jsonl 都调一次。实测本机某 project 目录 325 个 jsonl 共 2.1GB、单文件最大 40MB，
 * 一次 GET /api/history 就要串行读完这 2.1GB 并做同等体量的字符串分配。
 */
import fs from 'node:fs';

/**
 * 读取文件的前 maxLines 行。
 * 用 utf8 编码的可读流（内部走 StringDecoder，多字节字符跨 chunk 不会被截断），
 * 行数够了立刻 destroy，后续字节根本不会被读进来。
 *
 * @param {string} filePath
 * @param {number} maxLines
 * @param {{createStream?: (p:string)=>NodeJS.ReadableStream}} [deps] 注入点，便于单测断言「提前停止」
 * @returns {Promise<string[]>}
 */
export function readFirstLines(filePath, maxLines, { createStream } = {}) {
  const make = createStream || ((p) => fs.createReadStream(p, { encoding: 'utf8' }));
  return new Promise((resolve, reject) => {
    const stream = make(filePath);
    const lines = [];
    let buf = '';
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      if (err) return reject(err);
      // 收尾：最后一行可能没有换行符
      if (lines.length < maxLines && buf) lines.push(buf);
      resolve(lines);
    };

    stream.on('data', (chunk) => {
      if (settled) return;
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        lines.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (lines.length >= maxLines) return finish(); // 够了就走，不再读后面的字节
      }
    });
    stream.on('end', () => finish());
    stream.on('error', (e) => finish(e));
  });
}
