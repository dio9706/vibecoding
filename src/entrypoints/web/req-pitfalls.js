/**
 * 避坑清单管理 —— 读写 .claude/pitfalls.md 与 CLAUDE.md 文件。
 * 与 req-logic.js（纯函数）分离，独立负责 IO 和文件操作。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 异步读文件。若文件不存在返回 null，其他错误抛出。
 * @param {string} filePath 文件绝对路径
 * @returns {Promise<string|null>} 文件内容或 null
 */
export async function readFile(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * 异步写文件，自动创建父目录。若文件已存在则覆盖。
 * @param {string} filePath 文件绝对路径
 * @param {string} content 文件内容
 * @returns {Promise<void>}
 */
export async function writeFile(filePath, content) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

/**
 * 异步追加或新建文件。若文件不存在则新建，存在则追加。
 * 末尾自动补换行符（如尚未以换行结尾）。
 * @param {string} filePath 文件绝对路径
 * @param {string} content 追加内容
 * @returns {Promise<void>}
 */
export async function appendFile(filePath, content) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const existing = await readFile(filePath);

  if (existing === null) {
    // 文件不存在，新建并末尾补换行
    const newContent = content.endsWith('\n') ? content : content + '\n';
    await fs.writeFile(filePath, newContent, 'utf8');
  } else {
    // 文件存在：若现有内容不以换行结尾，先补换行；然后追加新内容，末尾再补换行
    const prefix = existing.endsWith('\n') ? '' : '\n';
    const toAppend = prefix + content;
    const finalContent = toAppend.endsWith('\n') ? toAppend : toAppend + '\n';
    await fs.appendFile(filePath, finalContent, 'utf8');
  }
}

/**
 * 返回 `<projectDir>/.claude/pitfalls.md` 的绝对路径。
 * @param {string} projectDir 项目目录绝对路径
 * @returns {string} pitfalls.md 绝对路径
 */
export function ensurePitfallsPath(projectDir) {
  return path.join(projectDir, '.claude', 'pitfalls.md');
}

/**
 * 返回 `<projectDir>/CLAUDE.md` 的绝对路径。
 * @param {string} projectDir 项目目录绝对路径
 * @returns {string} CLAUDE.md 绝对路径
 */
export function ensureClaudeMdPath(projectDir) {
  return path.join(projectDir, 'CLAUDE.md');
}

/**
 * 写入避坑清单条目到 pitfalls.md。
 * 读取现有条目 → 去重合并 → 整体写回（原子性保证）。
 * items 格式：字符串数组，每个元素为一条避坑项。
 * @param {string} projectDir 项目目录绝对路径
 * @param {Array<string>} items 避坑条目数组
 * @returns {Promise<void>}
 */
export async function writePitfalls(projectDir, items) {
  const filePath = ensurePitfallsPath(projectDir);

  // 读取现有内容
  const existing = await readFile(filePath);
  const existingLines = existing
    ? existing
        .split('\n')
        .filter((line) => line.trim() && line.trim().startsWith('-'))
        .map((line) => line.replace(/^-\s*/, '').trim())
    : [];

  // 去重合并：新条目仅在首 20 字不重复时才追加
  const seen = new Set(existingLines.map((item) => item.slice(0, 20)));
  const merged = [...existingLines];

  for (const item of items) {
    const key = item.slice(0, 20);
    if (!seen.has(key)) {
      merged.push(item);
      seen.add(key);
    }
  }

  // 格式化并写回
  const formatted = merged.map((item) => `- ${item}`).join('\n');
  const content = formatted ? formatted + '\n' : '';

  await writeFile(filePath, content);
}

/**
 * 确保 CLAUDE.md 含 `@.claude/pitfalls.md` 引用。
 * - CLAUDE.md 不存在 → 创建，仅含该行
 * - 已含引用 → 不动
 * - 无引用 → 追加（前加空行+引用行）
 * @param {string} projectDir 项目目录绝对路径
 * @returns {Promise<void>}
 */
export async function ensureClaudeMdRef(projectDir) {
  const filePath = ensureClaudeMdPath(projectDir);
  const refLine = '@.claude/pitfalls.md';

  const content = await readFile(filePath);

  if (content === null) {
    // 文件不存在，新建仅含引用行
    await writeFile(filePath, refLine + '\n');
  } else if (!content.includes(refLine)) {
    // 文件存在但无引用，追加（前加空行）
    const prefix = content.endsWith('\n') ? '\n' : '\n\n';
    const toAppend = prefix + refLine + '\n';
    await fs.appendFile(filePath, toAppend, 'utf8');
  }
  // 否则已含引用，不动
}
