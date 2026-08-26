/**
 * 一键优化的选材与提示：从体检报告里挑出「能自动修的」，以及生成给用户的手工待办。
 * 纯函数，不碰文件系统。
 */

/** v1 只支持 rules 降级。维度④（无用代码）明确不做，②⑤ 是分析类维度、没有自动修法。 */
export const SUPPORTED_DIMENSIONS = ['rules'];

const RULES_PREFIX = '.claude/rules/';

/**
 * 从体检报告里挑出可自动降级的 rules 文件。
 *
 * `fixable` 这个字段是检测器给的判断，这里**只读不改**——尤其是 `R2_DEMOTE_UNCERTAIN`
 * （有 frontmatter 但解析不出 paths）故意标成不可自动修：降级要删文件、改写全仓引用，
 * 基于一个「可能是解析器不认识的写法」的猜测去做，代价远大于少优化一条。
 *
 * 被挡下的项要如实返回而不是丢掉——用户看到「这条没动，因为 XXX」才知道要去人工处理。
 *
 * @param {object|null} report 体检报告
 * @returns {{files:string[], blocked:Array<{file:string, reason:string}>}} files 是文件名（含 .md）
 */
export function selectFixableRules(report) {
  const issues = report?.dims?.rules?.issues;
  if (!Array.isArray(issues)) return { files: [], blocked: [] };

  const files = [];
  const seen = new Set();
  const blocked = [];

  for (const it of issues) {
    const file = String(it?.file || '');
    // 别的维度将来也可能产出 fixable 的 issue，降级只认 rules 目录下的
    if (!file.startsWith(RULES_PREFIX)) continue;

    if (it.fixable !== true) {
      blocked.push({ file, reason: String(it?.message || '检测器标记为不可自动修复') });
      continue;
    }
    // 同一个文件可能命中多条规则，降级只做一次
    const name = file.slice(RULES_PREFIX.length);
    if (seen.has(name)) continue;
    seen.add(name);
    files.push(name);
  }

  return { files, blocked };
}

/**
 * 生成「机器做不了、需要你自己动手」的提示。
 *
 * 两条，都对应一种「不说就会被误以为已经处理好了」的情况：
 *
 * 1. **勾了不支持的维度**。静默忽略最糟——用户勾了注释维度，看到「优化完成」，
 *    合理地以为注释也处理过了。
 * 2. **根 CLAUDE.md 里还留着旧文件名**。项目地图常有一张「规则文件 | 覆盖范围」的索引表，
 *    表格里写的是裸文件名（`design-system.md`）而不是带目录的路径，
 *    replaceRuleRefs 只认反引号包裹的完整路径，匹配不到它 —— 于是表里留下一行
 *    指向已删除文件的条目。这个改不了自动化：表格的列结构因项目而异，
 *    机器分不清该改成技能名还是整行删掉，只能请用户看一眼。
 *
 * @param {object} [args]
 * @param {string[]} [args.requested] 用户勾选的维度
 * @param {Array<{status:string,file:string,skillName:string}>} [args.results] demoteOne 的结果
 * @param {string|null} [args.rootClaudeMd] 降级完成后根 CLAUDE.md 的内容；读不到传 null
 * @returns {string[]}
 */
export function buildFixNotes({ requested, results, rootClaudeMd } = {}) {
  const notes = [];

  const unsupported = (Array.isArray(requested) ? requested : [])
    .filter((d) => !SUPPORTED_DIMENSIONS.includes(d));
  if (unsupported.length) {
    notes.push(`本次只处理了 rules 降级；勾选的 ${unsupported.join('、')} 维度暂无自动修复能力，未做任何改动。`);
  }

  const md = typeof rootClaudeMd === 'string' ? rootClaudeMd : '';
  if (md) {
    const residual = (Array.isArray(results) ? results : [])
      .filter((r) => r?.status === 'done')
      // 比对原文件名而不是技能名：技能名会出现在刚替换好的 `/xxx` 里，拿它去搜必然误报
      .map((r) => String(r.file || '').slice(RULES_PREFIX.length))
      .filter((name) => name && md.includes(name));

    if (residual.length) {
      notes.push(
        `根 CLAUDE.md 里仍出现 ${residual.join('、')}（多半是索引表里的裸文件名，` +
        '自动替换只认带反引号的完整路径），请手工改成对应技能或删掉该行。',
      );
    }
  }

  return notes;
}
