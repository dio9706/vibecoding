/**
 * 体检豁免清单（checkup-ignores.json）—— 用户点「这不是问题」的记录，唯一真相源。
 *
 * 与 optimize.json 同样用项目绝对路径作 key：同一台机器上路径唯一，不需要额外生成 id。
 *
 * 为什么独立成一个文件而不是塞进 optimize.json：那份文件装的是「体检产出」
 * （报告、历史、串行闸、LLM 缓存），会被体检流程高频整份读改写；豁免是**人工判断**，
 * 低频、长寿、且值得单独备份。混在一起意味着每次体检落盘都要带上这些人工记录，
 * 一次损坏就把两类数据一起赔进去。
 *
 * 面向人和 AI 的可读副本是 `.claude/optimize/IGNORED.md`，由
 * `features/project-checkup/ignore.js` 从本文件渲染——那是派生物，本文件才是真相源。
 */
import { readJson, updateJson } from './index.js';

const FILE = 'checkup-ignores.json';
const EMPTY = () => ({ projects: {} });

/**
 * 两条记录是否指同一个豁免。
 *
 * 键是 `(dim, code, file)` 三元组，**刻意不含行号**：行号会随任何编辑漂移，
 * 下一次体检就对不上，豁免等于没记。代价是同文件同类型的其他问题会被一起免掉，
 * 这是设计时接受的取舍。
 */
function sameRule(a, b) {
  return a?.dim === b?.dim && a?.code === b?.code && a?.file === b?.file;
}

/** 某项目的全部豁免记录；没有记录时返回空数组（不是 undefined，调用方一律可以直接遍历） */
export function readIgnores(dir) {
  const items = readJson(FILE, EMPTY()).projects?.[dir]?.items;
  return Array.isArray(items) ? items : [];
}

/**
 * 记一条豁免。同三元组**覆盖**而非追加——用户改主意重写理由时，
 * 留下两条互相矛盾的记录比留下最新那条糟糕得多。
 */
export function addIgnore(dir, rule) {
  return updateJson(FILE, EMPTY(), (data) => {
    if (!data.projects) data.projects = {};
    const rec = data.projects[dir] || { items: [] };
    const kept = (rec.items || []).filter((it) => !sameRule(it, rule));
    rec.items = [...kept, rule];
    data.projects[dir] = rec;
    return data;
  });
}

/** 撤销一条豁免。没命中任何记录时返回 undefined 放弃写盘（别为一次空操作刷新文件） */
export function removeIgnore(dir, key) {
  return updateJson(FILE, EMPTY(), (data) => {
    const rec = data.projects?.[dir];
    if (!rec?.items?.length) return undefined;
    const kept = rec.items.filter((it) => !sameRule(it, key));
    if (kept.length === rec.items.length) return undefined;
    rec.items = kept;
    return data;
  });
}
