/**
 * docx → 纯文本（mammoth.extractRawText，够材料用途；不追求版式还原）。
 * 失败抛错，调用方降级为附原文件路径。
 */
import fs from 'node:fs';

/** 解析 docx 为文本，并在原目录旁存 .md，返回 md 路径 */
export async function docxToMdFile(docxPath, title = '') {
  // 按需加载：mammoth 单独占 3.6MB heap，而只有「用户丢了个 Word 材料进来」这条路径会走到。
  // 静态 import 会让每个进程一启动就常驻它（本模块被材料处理链无条件引用）。
  const { default: mammoth } = await import('mammoth');
  const r = await mammoth.extractRawText({ path: docxPath });
  const text = (r.value || '').trim();
  if (!text) throw new Error('docx 解析结果为空');
  const mdPath = docxPath.replace(/\.docx$/i, '') + '.md';
  fs.writeFileSync(mdPath, `# ${title || 'docx 材料'}\n\n${text}`, 'utf8');
  return mdPath;
}
