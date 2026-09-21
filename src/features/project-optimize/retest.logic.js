/**
 * 修复报告的「需要复测什么」——纯逻辑层，不碰文件系统。
 *
 * ## 为什么是规则化而不是让模型写
 *
 * 复测建议一旦编造就是负价值：用户照着一份虚构的清单去测，会以为已经覆盖到了。
 * 本项目每级目录都有 `CLAUDE.md` 写明该模块职责，「改了哪个目录 → 那个目录负责什么」
 * 是确定性的事实推导，不需要模型参与，也就不会有幻觉、不花额度、不用等。
 *
 * 代价是产出比较朴素（列模块与职责，不给具体测试步骤）。这是有意的取舍：
 * 朴素但可信 > 详细但可能是编的。
 */

/**
 * 改动文件按所在目录归拢。根目录文件归到 '.'。
 *
 * 路径先归一成正斜杠：后端在 win32 下产出的 `file` 可能带反斜杠，
 * 不归一的话同一个目录会被切成两组（`src/app` 与 `src\app`）。
 */
export function groupByModule(files) {
  const out = {};
  for (const f of files || []) {
    const p = String(f || '').replace(/\\/g, '/');
    if (!p) continue;
    const at = p.lastIndexOf('/');
    const dir = at < 0 ? '.' : p.slice(0, at);
    (out[dir] ||= []).push(p);
  }
  return out;
}

/**
 * 取 markdown 里第一段能当「职责描述」用的文字。
 *
 * 跳过标题、列表、表格与代码围栏；**引用块要剥掉标记当正文用，不能跳过**——
 * 本仓库的模块地图有两种写法，`src/entrypoints/CLAUDE.md` 把职责概述写在
 * 「# 标题」之后的 `>` 导读块里，`src/features/CLAUDE.md` 则写成普通正文。
 * 跳过引用块会让前一种结构取到下方某个实现细节段落，那不是职责。
 *
 * 拿不到就返回空串，由调用方降级为「只列文件」，**绝不编造**。
 */
export function firstParagraph(md) {
  // 必须跟踪「是否在围栏内」而不是只跳过 ``` 那一行：
  // 只判行首的话，代码块**内部**的普通语句（`const x = 1`）会被当成职责描述取走
  let inFence = false;

  for (const raw of String(md || '').split(/\r?\n/)) {
    let line = raw.trim();
    if (line.startsWith('```')) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (!line) continue;
    if (line.startsWith('#')) continue;
    if (line.startsWith('>')) line = line.slice(1).trim(); // 引用块＝导读，剥标记后当正文
    if (!line) continue;
    if (line.startsWith('-') || line.startsWith('*') || line.startsWith('|')) continue;
    return line;
  }
  return '';
}

/**
 * 组装复测清单。
 *
 * @param {string[]} changedFiles 本次实际改动过的文件
 * @param {Object<string,string>} [responsibilities] 目录 → 职责描述（由 IO 层读 CLAUDE.md 提供）
 * @returns {Array<{dir:string, responsibility:string, files:string[]}>} 按目录名排序（输出稳定）
 */
export function buildRetestList(changedFiles, responsibilities = {}) {
  const grouped = groupByModule(changedFiles);
  return Object.keys(grouped)
    .sort()
    .map((dir) => ({
      dir,
      responsibility: responsibilities?.[dir] || '',
      files: grouped[dir],
    }));
}
