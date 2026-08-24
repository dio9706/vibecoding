/**
 * 极简 YAML frontmatter 解析。
 *
 * 为什么不引 yaml 库：本项目零构建、依赖克制，而我们只需要读 `paths` 这一个
 * 字符串数组字段。完整 YAML 解析器的能力远超需要，徒增依赖面。
 *
 * 为什么容错要比「够用」再厚一层：解析结果会驱动破坏性自动化——paths 为 null
 * 会被下游判为「无条件加载」，进而产出「删文件、移成 skill、改写全仓引用」的
 * 建议。漏解析或解析脏，代价是动错文件，不是少个字段。所以下面每一处容错都
 * 宁可多认一种写法，也不把认得出的写法丢成 null。
 */

/** 去掉两端的成对引号（单双引号都认） */
function unquote(s) {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === "'" && t.at(-1) === "'") || (t[0] === '"' && t.at(-1) === '"'))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * 剥掉 YAML 行内注释。
 *
 * 必须引号感知：`- 'src/#tmp/**'` 里的 # 是合法路径的一部分，粗暴按 # 截断会把
 * 它砍成 `src/`，反而伪造出一条「看起来很窄」的路径。另外遵循 YAML 规则——只有
 * 前面挨着空白（或位于行首）的 # 才起注释作用，`src/#tmp` 中的不算。
 */
function stripComment(s) {
  let quote = null;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /[ \t]/.test(s[i - 1]))) {
      return s.slice(0, i);
    }
  }
  return s;
}

/**
 * 解析单行流式序列的内部条目，如 `'a', "b"`。
 * 逗号同样要引号感知，否则会切断 `'a,b'` 这类含逗号的字面量。
 */
function parseFlowItems(inner) {
  const items = [];
  let buf = '';
  let quote = null;
  for (const ch of inner) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === ',') {
      items.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  items.push(buf);
  // 丢掉纯空白片段，好让 `[]` 得到 []（而不是 ['']）；带引号的空串 `''` 不受影响
  return items.filter((it) => it.trim() !== '').map(unquote);
}

/**
 * @param {string} raw 文件全文
 * @returns {{hasFrontmatter: boolean, paths: string[]|null}}
 */
export function parseFrontmatter(raw) {
  // BOM 要在一切判断之前剥掉：Windows 上编辑器另存为「UTF-8 with BOM」很常见，
  // 不该让一个不可见字符把整份 frontmatter 判成不存在。
  const text = String(raw || '')
    .replace(/^﻿/, '')
    .replace(/\r\n/g, '\n');

  // 起始分隔行允许行尾空白，与结尾分隔行的宽松度保持一致
  const open = text.match(/^---[ \t]*\n/);
  if (!open) return { hasFrontmatter: false, paths: null };

  const lines = text.slice(open[0].length).split('\n');
  const closeAt = lines.findIndex((line) => /^---[ \t]*$/.test(line));
  if (closeAt === -1) return { hasFrontmatter: false, paths: null };

  const block = lines.slice(0, closeAt);

  const keyAt = block.findIndex((line) => /^paths:([ \t].*)?$/.test(line));
  if (keyAt === -1) return { hasFrontmatter: true, paths: null };

  const inlineValue = stripComment(block[keyAt].slice('paths:'.length)).trim();

  if (inlineValue.startsWith('[')) {
    // 跨行流式序列（`[` 之后换行）刻意不支持：写法罕见，硬猜容易解错，
    // 宁可返回 null 让下游保守处理。
    if (!inlineValue.endsWith(']')) return { hasFrontmatter: true, paths: null };
    // 空数组要如实返回 []：「显式声明不匹配任何文件」和「没写 paths」是相反的两件事
    return { hasFrontmatter: true, paths: parseFlowItems(inlineValue.slice(1, -1)) };
  }

  // 单标量写法 `paths: src/**`，语义上等价于只含一条的列表
  if (inlineValue !== '') return { hasFrontmatter: true, paths: [unquote(inlineValue)] };

  const paths = [];
  for (const line of block.slice(keyAt + 1)) {
    const item = line.match(/^[ \t]*-[ \t]+(.*)$/);
    if (item) {
      paths.push(unquote(stripComment(item[1])));
      continue;
    }
    // 顶格的新键意味着 paths 块结束；缩进行和空行可能是注释或续行，继续往下扫
    if (/^\S/.test(line)) break;
  }

  return { hasFrontmatter: true, paths: paths.length ? paths : null };
}
