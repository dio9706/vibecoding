/**
 * CLAUDE.md 的 @ 引用行幂等挂接。记忆库与「优化汇总/pitfalls」共用（spec §3）。
 *
 * 铁律：只追加引用行，绝不改写、重排、删除任何既有内容。
 * CLAUDE.md 里是用户手写的规矩，写坏它会污染此后所有会话 —— 比功能失效严重得多。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 引用行是否已存在（子串匹配：写在注释或句中也算，避免重复追加） */
export function hasImport(claudeMdPath, importLine) {
  try {
    return fs.readFileSync(claudeMdPath, 'utf8').includes(importLine);
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

/**
 * @returns {{created:boolean, appended:boolean}}
 */
export function ensureImport(claudeMdPath, importLine) {
  let body = null;
  try {
    body = fs.readFileSync(claudeMdPath, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  if (body === null) {
    fs.mkdirSync(path.dirname(claudeMdPath), { recursive: true });
    fs.writeFileSync(claudeMdPath, `${importLine}\n`, 'utf8');
    return { created: true, appended: true };
  }

  if (body.includes(importLine)) return { created: false, appended: false };

  // 原文末尾无换行时先补一个，否则会和引用行粘成一行
  const sep = body.length === 0 || body.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(claudeMdPath, `${sep}${importLine}\n`, 'utf8');
  return { created: false, appended: true };
}
