/**
 * docx → 纯文本（mammoth.extractRawText，够材料用途；不追求版式还原）。
 * 失败抛错，调用方降级为附原文件路径。
 */
import fs from 'node:fs';
import mammoth from 'mammoth';

/** 解析 docx 为文本，并在原目录旁存 .md，返回 md 路径 */
export async function docxToMdFile(docxPath, title = '') {
  const r = await mammoth.extractRawText({ path: docxPath });
  const text = (r.value || '').trim();
  if (!text) throw new Error('docx 解析结果为空');
  const mdPath = docxPath.replace(/\.docx$/i, '') + '.md';
  fs.writeFileSync(mdPath, `# ${title || 'docx 材料'}\n\n${text}`, 'utf8');
  return mdPath;
}
