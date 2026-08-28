/**
 * 维度① 地图修复的执行层：写盘那一半。
 *
 * 三条纪律，与 fix-rules.js 一致：
 *
 * 1. **计划先于动作**：planMapFix（在 fix-map.logic.js）必须在任何写操作之前跑完，
 *    结果交给 createBackup 打快照。
 * 2. **从不抛异常**：一切通过返回值的 status/reason 表达。上层是循环，
 *    一次抛错会把整批停在半路。
 * 3. **绝不覆盖已有内容**：新建类操作遇到已存在的文件一律跳过；
 *    追加类操作只动自己的锚点块。
 *
 * 比 fix-rules 少一条「失败分级」：本模块的所有操作都是**单文件独立**的
 * （写一份地图、改一行引用），任何一个失败都不会让文件系统进入半完成状态，
 * 因此没有 fatal 的概念，一条失败不影响其余条目继续。
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../shared/logger.js';
import { resolveDeadLinkTarget, rewriteRefInLine, upsertStaleAudit } from './fix-map.logic.js';
import { generateStaleFindings } from './gen-map.js';

const msgOf = (e) => e?.message || String(e);

/**
 * 建立仓库内所有文件和目录的相对路径索引。
 *
 * 与 check-map.js 的 buildPathIndex 同一套口径（含点目录，因为地图会引用 `.claude/`），
 * 但那个函数没有导出。**不要为了复用去改动检测器**——它已定型且被 29 条测试钉住，
 * 而这里只是 20 行的目录遍历，复制一份的成本远低于动它的风险。
 */
function buildPathIndex(projectDir) {
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'worktrees']);
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.push(r);
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
    }
  };
  walk(projectDir, '');
  return out;
}

/**
 * 修复死链：确定性重写，不调 LLM。
 *
 * 定位策略是「**先认报告给的行号，认不上就全文找**」。
 * 只认行号不行：体检和优化之间文件可能被改过，行号会漂，照着漂了的行号改会改坏无关内容。
 * 只全文找也不行：同一条引用可能在多处出现，行号能帮我们优先命中报告实际检出的那处。
 * 两者结合的关键是：**任何时候都以「这一行确实含有该字面量」为准**——
 * rewriteRefInLine 匹配不到就返回 null，这是唯一的放行条件。
 *
 * @param {string} projectDir
 * @param {Array<{file:string, line:number, ref:string}>} deadLinks
 * @returns {{updated:Array<{file:string,from:string,to:string}>, skipped:Array<{file:string,ref:string,reason:string}>}}
 */
export function fixDeadLinks(projectDir, deadLinks) {
  const updated = [];
  const skipped = [];
  const list = Array.isArray(deadLinks) ? deadLinks : [];
  if (!list.length) return { updated, skipped };

  const pathIndex = buildPathIndex(projectDir);

  // 按文件分组：同一份地图里的多条死链一次读、一次写，避免 N 次读写和中途状态不一致
  const byFile = new Map();
  for (const dl of list) {
    if (!byFile.has(dl.file)) byFile.set(dl.file, []);
    byFile.get(dl.file).push(dl);
  }

  for (const [rel, items] of byFile) {
    const abs = path.join(projectDir, rel);
    let raw;
    try {
      raw = fs.readFileSync(abs, 'utf8');
    } catch (e) {
      for (const it of items) skipped.push({ file: rel, ref: it.ref, reason: `读不到文件：${msgOf(e)}` });
      continue;
    }

    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    let dirty = false;

    for (const it of items) {
      const target = resolveDeadLinkTarget(it.ref, pathIndex);
      if (target.status === 'none') {
        skipped.push({
          file: rel, ref: it.ref,
          reason: '仓库里没有找到同名文件，无法确定正确路径（可能是外部资源引用）',
        });
        continue;
      }
      if (target.status === 'ambiguous') {
        skipped.push({
          file: rel, ref: it.ref,
          reason: `有多个候选，无法确定改成哪个：${target.candidates.slice(0, 5).join('、')}`,
        });
        continue;
      }

      // 先试报告给的行号（1-based），不中再全文扫
      const idx = Number(it.line) - 1;
      let hit = -1;
      if (idx >= 0 && idx < lines.length && rewriteRefInLine(lines[idx], it.ref, target.target) !== null) {
        hit = idx;
      } else {
        hit = lines.findIndex((l) => rewriteRefInLine(l, it.ref, target.target) !== null);
      }
      if (hit < 0) {
        skipped.push({ file: rel, ref: it.ref, reason: '文件里已找不到这条引用（体检后被改过？）' });
        continue;
      }

      lines[hit] = rewriteRefInLine(lines[hit], it.ref, target.target);
      updated.push({ file: rel, from: it.ref, to: target.target });
      dirty = true;
    }

    if (!dirty) continue;
    try {
      fs.writeFileSync(abs, lines.join('\n'), 'utf8');
    } catch (e) {
      // 写失败要把这一批已记进 updated 的条目撤回来——它们并没有真的落盘，
      // 留在 updated 里就是在向用户谎报成功
      for (let i = updated.length - 1; i >= 0; i--) {
        if (updated[i].file !== rel) continue;
        skipped.push({ file: rel, ref: updated[i].from, reason: `写入失败：${msgOf(e)}` });
        updated.splice(i, 1);
      }
      logger.warn('fix-map', '死链修复写盘失败', { file: rel, err: msgOf(e) });
    }
  }

  return { updated, skipped };
}

/**
 * 写一份新生成的地图（M1 / M2 共用）。
 *
 * @param {string} projectDir
 * @param {string} rel 目标相对路径，如 'CLAUDE.md' 或 'src/a/CLAUDE.md'
 * @param {() => Promise<{ok:boolean, markdown:string, reason:string}>} generate
 *   生成器。单测注入桩件——否则每跑一次测试就是一次真实 LLM 调用，
 *   又慢又花钱，而这一层要验的是写盘流程不是文案质量
 * @returns {Promise<{file:string, kind:string, status:'done'|'skipped'|'failed', reason:string}>}
 */
export async function writeGeneratedMap(projectDir, rel, generate) {
  const base = { file: rel, kind: 'gen-map', reason: '' };
  const abs = path.join(projectDir, rel);

  // 已存在一律不覆盖：那可能是用户手写的地图，覆盖是不可逆的内容丢失，
  // 而跳过的代价只是这一条没优化成（同 fix-rules.js 第 1 步的取舍）
  if (fs.existsSync(abs)) {
    return { ...base, status: 'skipped', reason: `${rel} 已存在，未覆盖` };
  }

  let out;
  try {
    out = await generate();
  } catch (e) {
    return { ...base, status: 'failed', reason: `生成异常：${msgOf(e)}` };
  }

  // 闸没过就一个字节都不写。写半成品会让 M1/M2 不再报缺失、分数上涨，
  // 而地图内容是错的——之后每一次会话都会被它误导（见 gen-map.logic.js 开头）
  if (!out?.ok || !out.markdown) {
    return { ...base, status: 'failed', reason: out?.reason || '生成失败' };
  }

  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `${out.markdown.trimEnd()}\n`, 'utf8');
  } catch (e) {
    return { ...base, status: 'failed', reason: `写入失败：${msgOf(e)}` };
  }

  return { ...base, status: 'done' };
}

/**
 * 给一份过期地图追加「自动核对」块（M3）。
 *
 * ⚠️ 这次写入会刷新地图 mtime，从而让 check-map.js 判定的 staleDays 归零——
 * 下次体检不再报 M3、map 分数还会涨，**但地图正文并没有变新鲜**。
 * 这是「只追加不覆盖」这个选择的必然代价，应对是两条：
 * 追加块自带日期且足够醒目（upsertStaleAudit 负责），
 * 以及编排层在优化结果里显式告知用户（buildFixNotes 负责）。
 * 两条都别删。
 *
 * @param {string} projectDir
 * @param {string} rel 地图相对路径
 * @param {number} staleDays
 * @param {object} [opts]
 * @param {(dir:string, rel:string)=>Promise<{ok:boolean,findings:string[],reason:string}>} [opts.generate]
 * @param {string} [opts.date] 写进块标题的日期（注入以便测试）
 * @param {AbortSignal} [opts.signal]
 */
export async function writeStaleAudit(projectDir, rel, staleDays, { generate, date, signal } = {}) {
  const base = { file: rel, kind: 'stale-audit', reason: '' };
  const abs = path.join(projectDir, rel);

  const run = generate || ((d, r) => generateStaleFindings(d, r, { signal }));
  let out;
  try {
    out = await run(projectDir, rel);
  } catch (e) {
    return { ...base, status: 'failed', reason: `核对异常：${msgOf(e)}` };
  }
  if (!out?.ok) return { ...base, status: 'failed', reason: out?.reason || '核对失败' };

  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    return { ...base, status: 'failed', reason: `读不到地图文件：${msgOf(e)}` };
  }

  try {
    const stamp = date || new Date().toISOString().slice(0, 10);
    fs.writeFileSync(abs, upsertStaleAudit(raw, { date: stamp, staleDays, findings: out.findings }), 'utf8');
  } catch (e) {
    return { ...base, status: 'failed', reason: `写入失败：${msgOf(e)}` };
  }

  return {
    ...base,
    status: 'done',
    reason: out.findings.length ? `记录了 ${out.findings.length} 条差异` : '未发现明显差异',
  };
}
