/**
 * 会话转录原始事件读取 —— 记忆库与「优化汇总/pitfalls」共用（spec §3）。
 *
 * 与 history.js 的分工：history.js 面向"给人看的历史列表"，返回折叠后的 role/content 消息；
 * 本模块返回**原始事件**，保留 tool_result / tool_use 块结构 —— 预筛器靠它区分
 * 「真用户发言」与「伪装成 user 的工具结果」（spec §14-c）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 把工作目录绝对路径编码为 Claude Code 的 project 目录名（与 CLI 规则一致） */
export function encodeProjectId(cwd) {
  return String(cwd || '').replace(/[:\\/.]/g, '-');
}

/** 某工作目录对应的转录目录 */
export function transcriptDir(cwd) {
  return path.join(os.homedir(), '.claude', 'projects', encodeProjectId(cwd));
}

/** 单个 jsonl → 事件数组。坏行跳过（转录可能被写入中途截断），文件不存在返回 [] */
export function readTranscriptEvents(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      // 坏行跳过：整体失败会让一次写坏的转录永久卡住扫描游标
    }
  }
  return out;
}

/**
 * 列出 mtime 晚于游标的转录，按 mtime 升序（老的先扫，游标推进才单调）。
 * @returns {Array<{file:string, sessionId:string, mtimeMs:number}>}
 */
export function listTranscriptsSince(dir, sinceMs) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (st.mtimeMs <= sinceMs) continue;
    out.push({ file, sessionId: name.slice(0, -'.jsonl'.length), mtimeMs: st.mtimeMs });
  }
  out.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return out;
}
