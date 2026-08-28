/**
 * 维度①：项目地图的完备性与新鲜度。
 *
 * 死链检测是这里最有价值的一条：地图会过期，但过期得悄无声息。
 * 引用路径失效是「地图和代码脱节」最容易机器验证的信号。
 */

export const STALE_DAYS = 14;

// 认得出的源码/文档扩展名，用于把「路径引用」和「命令、变量名」区分开
const PATH_EXT =
  /\.(md|js|mjs|cjs|ts|tsx|jsx|vue|py|go|rs|java|json|scss|css|html|yml|yaml|sh|toml|csv|txt|xml|svg|png|jpg|jpeg|gif|webp|lock|env|conf|ini|bat|ps1|makefile)$/i;

// 能精确解析到仓库内位置的目录前缀，用于把路由表里的目录引用和概念性指代区分开
const DIR_PREFIX = /^(src|\.claude)\//;

/**
 * 从 markdown 正文里提取路径引用（反引号包裹的部分）。
 *
 * 这里的取舍是**宁可漏报，不可误报**：提取结果会喂给死链检测，而死链 issue 标了
 * `fixable: true`，将来会被自动化去「修」。一条误报意味着自动化去修一个不存在的问题，
 * 代价远高于少检出一条。所以下面每条排除规则都优先保证不产生假引用。
 *
 * @returns {Array<{ref:string,line:number}>}
 */
export function extractPathRefs(md) {
  const out = [];
  const lines = String(md || '').split('\n');

  lines.forEach((text, idx) => {
    const re = /`([^`\n]+)`/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      let ref = m[1].trim();
      // 剥掉 `src/a.js:123` 这类行号后缀——地图里习惯这么写
      ref = ref.replace(/:\d+(-\d+)?$/, '');
      // 命令行、含空格的内容不是路径
      if (/\s/.test(ref)) continue;
      // glob 通配符（`src/**\/*.vue`）描述的是一类文件，磁盘上没有这个字面路径，
      // 拿去做存在性检查必然是假死链
      if (/[*?]/.test(ref)) continue;
      // 尖括号是文档里的占位符模板（`src/api/<业务域>/`），同样不是真实引用
      if (/[<>]/.test(ref)) continue;
      // brace 展开记法（`components/plate-picker-{cocreate,text2plate}.vue`）是作者
      // 把多个文件缩写成一条，磁盘上没有这个字面路径
      if (/[{}]/.test(ref)) continue;
      // 波浪号要么是区间记法（`supp-step1~3/index.vue`），要么是 home 目录引用，
      // 两种都不是仓库内的字面路径
      if (/~/.test(ref)) continue;
      // 占位符段：`.claude/rules/xxx.md`、`src/api/xxx/`、`__tests__/xxx.test.ts`
      // 都是文档在讲命名规则时的代称。按整段匹配而非子串——避免误伤
      // 真实存在的 `xxxService.ts` 这类命名。
      const segs = ref.split('/').filter(Boolean);
      if (segs.some((s) => s === 'xxx' || s.startsWith('xxx.'))) continue;
      // 已知的一类无法消除的误报：地图里引用 OSS/CDN 资源时会省略域名前缀，
      // 看起来和本地路径完全一样（如 `static/font-webp/icon-star-white.webp`）。
      // 没有可靠判别方式，接受这类零星误报。
      // 文件引用：要带已知扩展名，且必须含斜杠。裸文件名（`params.scss`、
      // `components.md`）实测几乎都是已存在文件的 basename 简写，而非根级文件
      // 引用，按仓库根去查必然是假死链
      const isKnownFile = PATH_EXT.test(ref) && ref.includes('/');
      // 目录引用：只认前缀明确的。模块路由表整表都是 `src/xxx/` 形式，而路由表
      // 恰恰是地图里最容易过期的部分（目录改名、分包重构、模块下线），正是死链
      // 检测最该抓的。反过来无前缀的（`request/` 实为 `src/api/request/`、
      // `.uploads/` 是约定投递目录）是概念性指代，解析基准不确定，实测是误报主因
      const isScopedDir = ref.endsWith('/') && DIR_PREFIX.test(ref);
      if (!isKnownFile && !isScopedDir) continue;
      out.push({ ref, line: idx + 1 });
    }
  });

  return out;
}

/**
 * 一条路径引用可能的解析基准。
 *
 * 地图作者习惯省略 src/ 前缀（写 `hooks/useBabyFoodPopups.ts` 指
 * `src/hooks/useBabyFoodPopups.ts`），所以存在性检查要多试几个基准，
 * 任一命中就不算死链。宁可漏报也不误报——死链 issue 是可自动修复的，
 * 假死链会让自动化去"修"一个不存在的问题。
 */
export function candidatePaths(ref) {
  return [ref, `src/${ref}`];
}

/**
 * @param {object} input
 * @param {boolean} input.hasRootMap
 * @param {Array<{name:string,hasMap:boolean,staleDays:number}>} input.modules
 * @param {Array<{file:string,line:number,ref:string}>} input.deadLinks
 * @param {number} input.rootMapLines
 */
export function evaluateMap({ hasRootMap, modules, deadLinks, rootMapLines }) {
  if (!hasRootMap) {
    return {
      score: 0,
      status: 'done',
      issues: [{
        code: 'M1_NO_ROOT_MAP',
        severity: 'error',
        file: 'CLAUDE.md',
        line: 1,
        message: '项目根没有 CLAUDE.md，每次会话都要从零摸索代码结构',
        fixable: true,
        fixHint: '生成根地图：项目定位 + 常用命令 + 模块路由表',
      }],
    };
  }

  const issues = [];
  let score = 60;

  // 覆盖率：没有可统计模块时视为满分，避免小项目被误判
  const total = modules.length;
  const covered = modules.filter((m) => m.hasMap).length;
  const coverage = total === 0 ? 1 : covered / total;
  score += coverage * 20;

  for (const m of modules) {
    if (!m.hasMap) {
      issues.push({
        code: 'M2_MISSING_MAP',
        severity: 'warn',
        file: `${m.name}/CLAUDE.md`,
        line: 1,
        message: `模块 ${m.name} 没有地图，AI 定位这个模块要靠全仓搜索`,
        fixable: true,
        fixHint: '生成模块地图：文件清单 + 关键流程 + 常见改动入口',
      });
    }
  }

  // 过期扣分，下限 -20
  const staleList = modules.filter((m) => m.hasMap && m.staleDays > STALE_DAYS);
  score -= Math.min(20, staleList.length * 4);
  for (const m of staleList) {
    issues.push({
      code: 'M3_STALE_MAP',
      severity: 'warn',
      file: `${m.name}/CLAUDE.md`,
      line: 1,
      message: `代码比地图新 ${m.staleDays} 天，地图可能已和实现脱节`,
      // 自动修复要按天数写进核对块。只留在 message 里的话，
      // 改一次文案就得同步改修复端的正则，而漏改不会报错、只会静默失效
      staleDays: m.staleDays,
      fixable: true,
      fixHint: '重新核对该模块地图的文件清单与关键流程',
    });
  }

  // 死链扣分，下限 -15
  score -= Math.min(15, deadLinks.length * 3);
  for (const d of deadLinks) {
    issues.push({
      code: 'M4_DEAD_LINK',
      severity: 'warn',
      file: d.file,
      line: d.line,
      message: `引用的 ${d.ref} 不存在`,
      // 同上：修复端要拿原始 ref 去查索引、去比对行内容，不能从文案里反解
      ref: d.ref,
      fixable: true,
      fixHint: '修正为正确路径，或删除该引用',
    });
  }

  // 根地图体积（官方建议 < 200 行）
  if (rootMapLines > 300) {
    score -= 10;
    issues.push({
      code: 'M5_OVERSIZED',
      severity: 'info',
      file: 'CLAUDE.md',
      line: 1,
      message: `根地图 ${rootMapLines} 行，超过官方建议的 200 行，会挤占上下文并降低遵循度`,
      fixable: false,
      fixHint: '把只在特定任务用得上的内容下沉到模块地图或 skill',
    });
  } else if (rootMapLines > 200) {
    score -= 5;
    issues.push({
      code: 'M5_OVERSIZED',
      severity: 'info',
      file: 'CLAUDE.md',
      line: 1,
      message: `根地图 ${rootMapLines} 行，超过官方建议的 200 行`,
      fixable: false,
      fixHint: '把只在特定任务用得上的内容下沉到模块地图或 skill',
    });
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), status: 'done', issues };
}
