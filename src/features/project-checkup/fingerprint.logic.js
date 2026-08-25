// 项目体检的指纹缓存：判断「这次要分析的输入有没有变过」，没变就复用上次的 LLM 结果。
//
// 取舍说明：
// - 用 mtime+size 而不是内容哈希，是因为读全部文件内容算哈希本身就要遍历一次磁盘，
//   而 mtime+size 只需 stat 调用，成本低得多。代价是理论上存在「内容变了但 mtime 和
//   size 都没变」的情况会被误判为未变——这种情况需要精确构造（比如故意伪造 mtime），
//   正常开发流程不会遇到；真遇到了，用户可以点「强制重新分析」绕过缓存。
// - 用 md5 而不是更强的哈希算法，是因为这里不是安全场景，只是变更检测，
//   不需要抗碰撞、抗碰撞攻击的强哈希，md5 又快又短，够用。
//
// 本模块是纯函数模块：不 import fs，文件的 stat 信息（path/mtime/size）由调用方读好后传入。

import { createHash } from 'node:crypto';

/**
 * 根据文件列表（path + mtime + size）计算一个稳定的指纹字符串。
 * @param {{path: string, mtime: number, size: number}[]} files
 * @returns {string} 16 位十六进制字符串
 */
export function computeFingerprint(files) {
  // 先按 path 排序再拼接：目录遍历顺序在不同平台/文件系统上不保证一致，
  // 排序后指纹只取决于「文件集合的内容」，与遍历顺序无关。
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const raw = sorted.map((f) => `${f.path}:${f.mtime}:${f.size}`).join('|');
  return createHash('md5').update(raw).digest('hex').slice(0, 16);
}

/**
 * 判断缓存是否可以直接复用，避免重新调用 LLM。
 * @param {{fingerprint?: string, result?: unknown} | null | undefined} cache
 * @param {string} fingerprint 本次计算出的指纹
 * @returns {boolean}
 */
export function isCacheValid(cache, fingerprint) {
  if (!cache) return false;
  if (cache.fingerprint !== fingerprint) return false;
  // 只有指纹没有 result，说明上一次分析中途失败或被中断，没能跑完，
  // 不能当作有效缓存来复用，否则会把「没结果」误当成「结果为空」。
  if (cache.result === undefined || cache.result === null) return false;
  return true;
}
