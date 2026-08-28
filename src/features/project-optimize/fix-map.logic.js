/**
 * 维度① 地图修复的纯逻辑：不碰文件系统，不发 LLM 调用。
 *
 * 死链修复刻意做成**完全确定性**的：check-map.js 已经建好了全仓路径索引，
 * 「这条失效引用该指向哪」是个查表问题。引入模型只会把一个有确定答案的问题
 * 变成一个有概率答错的问题，而答错的代价是把地图里本来正确的路径改坏。
 */

/**
 * 为一条失效引用找出唯一的正确路径。
 *
 * 判据只有一条：**basename 在全仓索引里唯一命中**。歧义和无候选一律不改。
 *
 * 这条极保守的判据同时解决了 check-map.logic.js:55-57 记录的那类无法消除的误报——
 * 地图引用 OSS/CDN 资源时会省略域名前缀（`static/font-webp/icon-star-white.webp`），
 * 看起来和本地路径一模一样，检测器分不出来、必然报成死链。这类引用在仓库里
 * 找不到同名文件，落进 'none' 分支自然被跳过，不需要额外加规则去认它们。
 *
 * @param {string} ref 失效的引用（可能以 / 结尾表示目录）
 * @param {string[]} pathIndex 全仓相对路径索引（正斜杠），来自 check-map.js 的 buildPathIndex
 * @returns {{status:'unique',target:string}|{status:'ambiguous',candidates:string[]}|{status:'none'}}
 */
export function resolveDeadLinkTarget(ref, pathIndex) {
  const raw = String(ref ?? '').trim();
  const list = Array.isArray(pathIndex) ? pathIndex : [];
  if (!raw || !list.length) return { status: 'none' };

  const isDir = raw.endsWith('/');
  const needle = raw.replace(/\/+$/, '');
  const base = needle.split('/').filter(Boolean).pop();
  if (!base) return { status: 'none' };

  // 排除原路径自身：它在索引里就说明不是死链，产出「改成自己」是个空操作
  const hits = list.filter((p) => p !== needle && p.split('/').pop() === base);
  if (!hits.length) return { status: 'none' };
  if (hits.length > 1) return { status: 'ambiguous', candidates: hits };
  return { status: 'unique', target: isDir ? `${hits[0]}/` : hits[0] };
}

/** 正则元字符转义：路径里出现 `+`、`.`、`(` 都得按字面量匹配 */
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 把一行里被反引号包裹的旧路径换成新路径。
 *
 * 两条刻意的约束：
 *
 * 1. **只认反引号包裹的**。裸文本里的同名字符串可能是散文叙述的一部分，
 *    改它就是篡改原文。这也和 extractPathRefs 的提取口径保持一致——
 *    提取时只认反引号，改写时也只认反引号，两边对得上才不会改到没被检测过的东西。
 * 2. **匹配不到返回 null**。体检和优化之间文件可能被人改过，报告里的行号会漂。
 *    返回 null 让调用方跳过这一条；原样返回会被误当成改写成功，
 *    结果是「报告说修好了、文件里那条死链还在」。
 *
 * 行号后缀（`src/a.js:123`）要保留：extractPathRefs 报上来的 ref 是剥掉行号的，
 * 改写时不还回去等于顺手删掉了作者的定位信息。
 *
 * @returns {string|null} 改写后的整行；该行不含目标字面量时为 null
 */
export function rewriteRefInLine(line, oldRef, newRef) {
  const text = String(line ?? '');
  const pattern = new RegExp('`' + escapeRe(oldRef) + '(:\\d+(?:-\\d+)?)?`', 'g');
  if (!pattern.test(text)) return null;
  pattern.lastIndex = 0;
  return text.replace(pattern, (_m, lineSuffix) => '`' + newRef + (lineSuffix || '') + '`');
}

/**
 * 核对块的锚点。用 HTML 注释而不是标题文字做锚：标题带日期会变，
 * 用它去定位等于每次都找不到旧块、于是无限追加。
 */
export const STALE_AUDIT_ANCHOR = '<!-- checkup:stale-audit -->';

/**
 * 在过期地图末尾写入「自动核对」块——**只追加/替换这一块，正文一字不动**。
 *
 * 为什么不重写整篇：模块地图里往往有人手写的踩坑记录和口径约定，
 * 这些恰恰是模型从代码里看不出来的部分，重写必然丢失，而备份要用户主动去翻才发现。
 *
 * 幂等靠锚点实现：锚点总是位于文件末尾（本函数是唯一的写入者），
 * 所以再次调用时把锚点及其之后的内容整个截掉再重写。
 * 不幂等的后果是跑三次优化就在地图末尾挂三段互相矛盾的过期核对记录。
 *
 * ⚠️ 调用方必须知道：写入会刷新文件 mtime，而 check-map.js:107 判过期正是靠
 * 「代码 mtime - 地图 mtime」。也就是说这次写入会让该地图的 M3 告警在下次体检时消失，
 * 但地图正文并没有变新鲜。所以块内文案必须自己足够醒目——它是唯一还在提醒的人。
 *
 * @param {string} md 地图原文
 * @param {{date:string, staleDays:number, findings:string[]}} args
 * @returns {string}
 */
export function upsertStaleAudit(md, { date, staleDays, findings } = {}) {
  const list = (Array.isArray(findings) ? findings : [])
    .map((f) => String(f ?? '').trim())
    .filter(Boolean);

  const body = list.length
    ? [
        `代码比本地图新 ${staleDays} 天。以下条目与当前代码不符，**地图正文尚未更新**：`,
        '',
        ...list.map((f) => `- ${f}`),
      ]
    : [`代码比本地图新 ${staleDays} 天，自动核对**未发现明显不符**，但仍建议人工确认关键流程。`];

  const block = [
    STALE_AUDIT_ANCHOR,
    `## ⚠️ 自动核对（${date}）`,
    '',
    ...body,
    '',
  ].join('\n');

  const text = String(md ?? '').replace(/\r\n/g, '\n');
  const at = text.indexOf(STALE_AUDIT_ANCHOR);
  const keep = (at < 0 ? text : text.slice(0, at)).replace(/\s*$/, '');

  return keep ? `${keep}\n\n${block}` : block;
}

/** 缺结构化字段时给用户的统一说法：报告版本旧，不是问题本身修不了 */
const STALE_REPORT_REASON = '体检报告缺少修复所需的结构化字段（版本较旧），请重新体检后再优化';

/**
 * 从体检报告里把地图维度的 issue 分流到四条修复路径。
 *
 * 与 selectFixableRules 并列而不是合并：两者的产物形状完全不同
 * （那边是文件名列表，这边是四类异构任务），硬塞进一个函数只会让两边都难读。
 *
 * **M1 的特殊性**：check-map.logic.js:95 在没有根地图时 early-return，
 * 那份报告里 M2/M3/M4 根本不存在。所以 rootMap 为真时，编排层必须在写完根地图后
 * 重新体检一次，才能拿到真实的其余清单。
 *
 * @param {object|null} report
 * @returns {{rootMap:boolean, modules:string[], stale:Array<{file:string,staleDays:number}>,
 *   deadLinks:Array<{file:string,line:number,ref:string}>, blocked:Array<{file:string,reason:string}>}}
 */
export function selectFixableMap(report) {
  const out = { rootMap: false, modules: [], stale: [], deadLinks: [], blocked: [] };
  const issues = report?.dims?.map?.issues;
  if (!Array.isArray(issues)) return out;

  for (const it of issues) {
    const file = String(it?.file || '');
    if (it?.fixable !== true) {
      out.blocked.push({ file, reason: String(it?.message || '检测器标记为不可自动修复') });
      continue;
    }

    switch (it.code) {
      case 'M1_NO_ROOT_MAP':
        out.rootMap = true;
        break;
      case 'M2_MISSING_MAP':
        out.modules.push(file.replace(/\/CLAUDE\.md$/, ''));
        break;
      case 'M3_STALE_MAP':
        // 从 message 里正则反解 staleDays 是错的：文案一改就静默失效。
        // 缺字段就如实说「报告太旧」，让用户重新体检——比猜一个数字诚实
        if (typeof it.staleDays === 'number') out.stale.push({ file, staleDays: it.staleDays });
        else out.blocked.push({ file, reason: STALE_REPORT_REASON });
        break;
      case 'M4_DEAD_LINK':
        if (typeof it.ref === 'string' && it.ref) out.deadLinks.push({ file, line: it.line, ref: it.ref });
        else out.blocked.push({ file, reason: STALE_REPORT_REASON });
        break;
      default:
        out.blocked.push({ file, reason: `未知的地图问题类型 ${it.code}，未做处理` });
    }
  }

  return out;
}

/**
 * 列出本次地图修复会写到的全部文件及动作，供 createBackup 打快照。
 *
 * **必须在任何写操作之前调用**，且本身无副作用（同 planDemote 的纪律）。
 *
 * created 与 modified 必须分对：backup.logic.js:24 对 created 标 `backed:false`，
 * 还原时靠删除它回到原状。标反了——把新建的根地图登记成 modified——
 * 还原会去找一份优化前根本不存在的备份内容，结果是文件留在原地删不掉。
 * 同理，一个文件既被新建又被改（根地图刚生成又要修它的死链），整体算 created。
 *
 * @param {ReturnType<typeof selectFixableMap>} [selection]
 * @returns {Array<{path:string, action:'created'|'modified'}>}
 */
export function planMapFix(selection) {
  const s = selection || {};
  const entries = new Map();

  const put = (p, action) => {
    if (!p) return;
    // created 覆盖 modified，反之不覆盖
    if (action === 'created' || !entries.has(p)) entries.set(p, action);
  };

  if (s.rootMap) put('CLAUDE.md', 'created');
  for (const mod of s.modules || []) put(`${mod}/CLAUDE.md`, 'created');
  for (const st of s.stale || []) put(st.file, 'modified');
  for (const dl of s.deadLinks || []) put(dl.file, 'modified');

  return [...entries].map(([path, action]) => ({ path, action }));
}
