/**
 * 复测清单的 IO 层：读各级 CLAUDE.md 取模块职责。
 *
 * 极薄——判断逻辑全在 `retest.logic.js`（本目录 `X.js` + `X.logic.js` 的既定分工）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { groupByModule, firstParagraph, buildRetestList } from './retest.logic.js';

/**
 * 从改动文件列表产出复测清单。
 *
 * 向**上**逐级找 CLAUDE.md：`src/entrypoints/web/` 没有自己的地图时，用
 * `src/entrypoints/` 的——那仍是对的模块描述，只是粗一档。
 *
 * ## 刻意**不**上溯到仓库根
 *
 * 根 `CLAUDE.md` 描述的是整个项目（"Principal 把 headless Claude Code 搬进网页…"），
 * 不是任何一个模块的职责。拿它去填某个目录，产出的是一句听着像模像样、
 * 实则与该目录毫无关系的话——实测把一个根本不存在的目录标成了整个项目的简介。
 * 复测清单里一句错的比一句没有更糟：用户会照着它去测错的东西。
 * 找不到就留空，由渲染层降级为只列文件。
 *
 * 读盘失败一律吞成「这一级没有」：复测清单是修复报告的锦上添花，
 * 不该因为一个权限问题让整份报告出不来。
 *
 * @param {string} dir 项目根目录
 * @param {string[]} changedFiles 本次实际改动过的文件（相对项目根）
 * @returns {Array<{dir:string, responsibility:string, files:string[]}>}
 */
export function collectRetest(dir, changedFiles) {
  const responsibilities = {};

  for (const moduleDir of Object.keys(groupByModule(changedFiles))) {
    // 根目录下的文件（moduleDir === '.'）直接跳过：没有比根更上一级的模块地图可用
    let cur = moduleDir;
    while (cur && cur !== '.') {
      try {
        const para = firstParagraph(fs.readFileSync(path.join(dir, cur, 'CLAUDE.md'), 'utf8'));
        if (para) { responsibilities[moduleDir] = para; break; }
      } catch { /* 这一级没有地图（或读不了），继续往上找 */ }

      const at = cur.lastIndexOf('/');
      cur = at < 0 ? '' : cur.slice(0, at); // 到顶（无斜杠）即停，不落到仓库根
    }
  }

  return buildRetestList(changedFiles, responsibilities);
}
