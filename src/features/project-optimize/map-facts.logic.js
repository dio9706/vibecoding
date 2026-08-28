/**
 * 事实包的纯逻辑：从源码文本里抽取「这个文件/模块是干什么的」信号。
 *
 * 事实包的作用不是省 token，而是**保底**：模型拿着只读工具自由探索时，
 * 可能只读了两三个文件就下结论。事实包保证文件清单、导出符号这类硬事实至少是对的，
 * 模型的自由探索只用来补充「关键流程」这类需要理解才能写出来的部分。
 */

/** 单条注释摘要的最大长度：一行够说清职责，再长就是把整段文档搬进事实包 */
const COMMENT_CLIP = 120;

/**
 * 抽出文件的具名导出。
 *
 * 只认行首（允许前导空白）的 `export`，是为了排开注释里的示例代码——
 * 本仓库注释密度很高，注释里写 `// export function xxx()` 举例很常见，
 * 收进来会让地图列出根本不存在的 API。
 *
 * 不收 `export default` 和 `export * from`：前者没有对读者有用的名字，
 * 后者没有具名信息，两者对「这个模块提供什么」都不构成回答。
 *
 * @param {string} code
 * @returns {string[]}
 */
export function extractExports(code) {
  const text = String(code ?? '');
  const out = [];
  const re = /^[ \t]*export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

/**
 * 取文件顶部块注释的首个实义行，作为该文件的职责摘要。
 *
 * 必须在文件开头（允许前导空白）：文件中部的块注释描述的是局部逻辑，
 * 拿它冒充文件职责会让地图给出错误的导航。
 *
 * 本仓库几乎每个模块开头都有一段「为什么这么做」的块注释，信息密度极高——
 * 这是本项目特有的红利，比任何静态分析都准。
 *
 * @param {string} code
 * @returns {string} 摘要；没有开头块注释时为空串
 */
export function headComment(code) {
  const text = String(code ?? '');
  const m = /^\s*\/\*\*?([\s\S]*?)\*\//.exec(text);
  if (!m) return '';
  for (const raw of m[1].split('\n')) {
    const line = raw.replace(/^\s*\*?\s?/, '').trim();
    if (line) return line.slice(0, COMMENT_CLIP);
  }
  return '';
}

/**
 * 把若干小节渲染成喂给模型的事实包文本。
 *
 * 空小节整节丢掉：留下「### 依赖\n（无）」这种空壳既占 token，
 * 又让模型误以为「无」是一条需要写进地图的事实。
 *
 * @param {Array<{title:string, body:string}>} sections
 * @returns {string}
 */
export function formatFactPack(sections) {
  return (Array.isArray(sections) ? sections : [])
    .filter((s) => String(s?.body ?? '').trim())
    .map((s) => `### ${s.title}\n\n${String(s.body).trim()}`)
    .join('\n\n');
}
