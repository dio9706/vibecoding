/**
 * 项目级召回器（纯函数）：依赖图、依赖清单、上手文档、仓库卫生深化。
 *
 * 与 `selectors-code.logic.js` 的分野：那边逐行扫**文件内容**，这边看的是**文件之间的关系**
 * 与项目根上的清单文件。两类取材的输入形状和聚合粒度都不同，混在一个文件里会让
 * 「候选是逐行的还是逐边的」这件事变得需要读代码才知道。
 *
 * ## 聚合粒度是本模块最关键的设计
 *
 * 架构与依赖问题**天生是聚合的**：`src/entrypoints` 里 30 个文件都 import 了
 * `src/store`，这是**一条**架构事实，不是 30 条。逐文件报会产出几十条内容雷同的 issue，
 * 用户看不出「哪一条才是问题」，还要为同一个判断付 30 次判定额度。
 * 所以这里一律先聚合到「目录对」「依赖名」「环」这些真正的判断单位，再交给模型。
 */

/* ==================== import 抽取与解析 ==================== */

/** 各语言的 import 形态。只取「目标」这一个捕获组，其余语法差异在这里吸收掉 */
const IMPORT_PATTERNS = [
  /^\s*import\s+(?:[\w*{}\s,$]+\s+from\s+)?['"]([^'"]+)['"]/, // JS/TS: import x from 'y' / import 'y'
  /^\s*export\s+(?:[\w*{}\s,$]+\s+)?from\s+['"]([^'"]+)['"]/, // JS/TS: export { x } from 'y'
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/, // CommonJS
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/, // 动态 import
  /^\s*from\s+([\w.]+)\s+import\b/, // Python: from x import y
  /^\s*import\s+([\w.]+)(?:\s+as\s+\w+)?\s*$/, // Python: import x
  /^\s*import\s+(?:\w+\s+)?"([^"]+)"/, // Go
];

/**
 * 归一化相对路径引用：把 `src/a/b.js` + `../c/d.js` 解成 `src/c/d.js`。
 *
 * 手写而不用 `node:path`：`path.posix.join` 可用，但本模块承诺纯函数零依赖，
 * 而这段逻辑只有十行；更重要的是 Windows 上 `path.join` 会产出反斜杠，
 * 而仓库内路径的唯一口径是正斜杠（`git ls-files` 的输出格式）。
 */
export function resolveRelative(fromRel, target) {
  const fromDir = fromRel.includes('/') ? fromRel.slice(0, fromRel.lastIndexOf('/')) : '';
  const parts = fromDir ? fromDir.split('/') : [];
  for (const seg of target.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/** Node 内建模块：它们出现在 import 里不代表缺依赖 */
const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2',
  'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode',
  'querystring', 'readline', 'repl', 'sqlite', 'stream', 'string_decoder', 'test', 'timers',
  'tls', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

/** 裸依赖名归一：`@scope/pkg/sub` → `@scope/pkg`；`lodash/get` → `lodash` */
export function packageNameOf(spec) {
  const s = String(spec).replace(/^node:/, '');
  if (s.startsWith('@')) return s.split('/').slice(0, 2).join('/');
  return s.split('/')[0];
}

export function isRelative(spec) {
  return spec.startsWith('.') || spec.startsWith('/');
}

/**
 * 抽出一个文件的全部 import 目标。
 *
 * 逐行匹配而不是整文全局正则：`require('x')` 可能出现在行中间，而
 * `^\s*import` 类模式必须锚定行首（否则注释和字符串里的 "import" 会被捞进来）。
 * 两种锚定方式混在一个全局正则里没法同时正确。
 */
export function extractImports(text, rel) {
  const out = new Set();
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const t = raw.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('#')) continue;
    for (const re of IMPORT_PATTERNS) {
      const m = re.exec(raw);
      if (m && m[1]) out.add(m[1]);
    }
  }
  return [...out].map((spec) => ({
    spec,
    relative: isRelative(spec),
    target: isRelative(spec) ? resolveRelative(rel, spec) : packageNameOf(spec),
  }));
}

/* ==================== structure ==================== */

/**
 * 层的粒度取「前两段路径」。
 *
 * 一段太粗（整个 `src` 是一层，什么都看不出）；文件级太细（几百个节点，每条边都是
 * 一条候选）。两段正好落在大多数项目的模块边界上：`src/features`、`src/entrypoints`、
 * `app/services`、`internal/handler`。项目结构不同的话模型会在判定时说明，不必在这里穷举。
 */
export function layerOf(rel) {
  const parts = String(rel).split('/');
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
}

/**
 * 找出文件级 import 环。
 *
 * 只报**最小环**（首次发现即回溯出路径就停）：一个环上的每个节点都能各自报一遍
 * 同一个环，去重后才是一条架构事实。
 */
export function findCycles(graph) {
  const cycles = [];
  const seenSignature = new Set();
  const state = new Map(); // 0=未访问 1=在栈上 2=已完成
  const stack = [];

  const visit = (node) => {
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) || []) {
      if (!graph.has(next)) continue;
      if (state.get(next) === 1) {
        const cycle = stack.slice(stack.indexOf(next));
        // 环的签名与起点无关：排序后去重，免得同一个环按不同起点重复上报
        const sig = [...cycle].sort().join('|');
        if (!seenSignature.has(sig)) {
          seenSignature.add(sig);
          cycles.push(cycle);
        }
      } else if (state.get(next) !== 2) {
        visit(next);
      }
    }
    stack.pop();
    state.set(node, 2);
  };

  for (const node of graph.keys()) if (!state.has(node)) visit(node);
  return cycles;
}

/**
 * 依赖方向与环的候选。
 *
 * @param {object} args
 * @param {Array<{rel:string, text:string}>} args.files
 * @param {string} [args.conventions] 项目自己声明的分层约定（从根 CLAUDE.md / README 抽出）
 * @returns {{candidates:Array, sharedContext:string}}
 */
export function recallImportGraph({ files = [], conventions = '', moduleConventions = {} } = {}) {
  const known = new Set(files.map((f) => f.rel));
  const graph = new Map();
  const edges = new Map(); // `A>B` -> {from, to, samples:[], count}

  // 后缀补全：`./a.js` 能直接命中，`./a` 要试几个扩展名才对得上磁盘上的文件
  const resolveToKnown = (target) => {
    if (known.has(target)) return target;
    for (const ext of ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go']) {
      if (known.has(target + ext)) return target + ext;
    }
    for (const idx of ['/index.js', '/index.ts', '/__init__.py']) {
      if (known.has(target + idx)) return target + idx;
    }
    return null;
  };

  for (const f of files) {
    const deps = [];
    for (const imp of extractImports(f.text, f.rel)) {
      if (!imp.relative) continue;
      const hit = resolveToKnown(imp.target);
      if (!hit || hit === f.rel) continue;
      deps.push(hit);

      const from = layerOf(f.rel);
      const to = layerOf(hit);
      if (from === to) continue;
      const key = `${from}>${to}`;
      if (!edges.has(key)) edges.set(key, { from, to, samples: [], count: 0 });
      const e = edges.get(key);
      e.count += 1;
      if (e.samples.length < 4) e.samples.push(`${f.rel} → ${hit}`);
    }
    graph.set(f.rel, deps);
  }

  const candidates = [];

  for (const e of edges.values()) {
    candidates.push({
      file: e.samples[0] ? e.samples[0].split(' → ')[0] : e.from,
      line: 1,
      text: `依赖边：\`${e.from}\` → \`${e.to}\`，共 ${e.count} 处引用。\n\n示例：\n  ${e.samples.join('\n  ')}`,
      meta: { kind: 'layer-edge', from: e.from, to: e.to, count: e.count },
    });
  }

  for (const cycle of findCycles(graph)) {
    candidates.push({
      file: cycle[0],
      line: 1,
      text: `import 环（${cycle.length} 个文件首尾相连）：\n  ${cycle.join('\n  → ')}\n  → ${cycle[0]}`,
      meta: { kind: 'import-cycle', cycle },
    });
  }

  // 只带出**本次候选真正涉及**的模块文档：全量（本仓库 10 份）会挤掉判据本身的注意力，
  // 而与本轮无关的模块文档对判定毫无帮助
  const involved = new Set();
  for (const c of candidates) {
    if (c.meta.from) involved.add(c.meta.from);
    if (c.meta.to) involved.add(c.meta.to);
    for (const f of c.meta.cycle || []) involved.add(layerOf(f));
  }
  const moduleDocs = [...involved]
    .filter((layer) => moduleConventions[layer])
    .map((layer) => `### \`${layer}\` 自己的模块文档\n\n${moduleConventions[layer]}`)
    .join('\n\n');

  const parts = [conventions
    ? `## 本项目自己声明的分层约定（判定时必须以它为准）\n\n${conventions}`
    : '## 本项目没有显式声明分层约定\n\n请按目录命名推断意图，并在 reason 里说明你推断的层次顺序。'];

  if (moduleDocs) {
    // **分层例外几乎只写在模块文档里**。实测事故（2026-09-04）：根文档写「下层不得 import 上层」，
    // 而 `src/shared/CLAUDE.md` 写明 config / messages / bot-activity「刻意反向 import」并给了理由；
    // 只喂根文档，这两条有据可依的设计就被判成了 A1_DEP_VIOLATION
    parts.push('## 相关模块自己的约定文档（**分层例外常写在这里，优先级高于根文档的通则**）');
    parts.push(moduleDocs);
  }

  parts.push([
    '## 关于候选形状的两点说明（不看清会误判）',
    '',
    '1. `依赖边：A → B` 是**目录级聚合**的结果，只表示「A 目录下有某个文件 import 了 B 目录下的某个文件」。',
    '   同时看到 `A → B` 和 `B → A` **不等于存在 import 环**——很可能是 A 里的甲 import B 里的乙、',
    '   而 B 里的丙 import A 里的丁，四个文件之间根本没有环。',
    '   **真正的文件级环会作为独立的「import 环」候选单独给出**；没有那种候选就说明不存在环，',
    '   请不要从两条方向相反的目录边推断出环，也不要据此描述「环导致的后果」。',
    '2. 判定必须落到「违反了项目声明的哪一条」。项目在模块文档里明确写为刻意设计并给了理由的边，',
    '   判 `acceptable` 并在 reason 里引用那条理由——那不是疏漏，是已经权衡过的决定。',
  ].join('\n'));

  return { candidates, sharedContext: parts.join('\n\n') };
}

/* ==================== deps ==================== */

/**
 * 依赖健康候选。
 *
 * @param {object} args
 * @param {Array<{rel:string, text:string}>} args.files
 * @param {{deps:Record<string,string>, devDeps:Record<string,string>, kind:string}} args.manifest
 */
export function recallDepManifest({ files = [], manifest = null } = {}) {
  // na 而不是「零候选=满分」：没有依赖清单时这个维度是**无法判断**，不是「依赖很健康」。
  // 混为一谈会让一个没有 package.json 的项目凭空拿到满分并抬高总分
  if (!manifest) {
    return { candidates: [], sharedContext: '', na: '项目没有可识别的依赖清单（package.json / requirements.txt / go.mod）' };
  }

  const declared = new Map();
  for (const [name, ver] of Object.entries(manifest.deps || {})) declared.set(name, { ver, dev: false });
  for (const [name, ver] of Object.entries(manifest.devDeps || {})) {
    if (!declared.has(name)) declared.set(name, { ver, dev: true });
  }

  const used = new Map(); // pkg -> Set<file>
  for (const f of files) {
    for (const imp of extractImports(f.text, f.rel)) {
      if (imp.relative) continue;
      const pkg = imp.target;
      if (NODE_BUILTINS.has(pkg.replace(/^node:/, ''))) continue;
      if (!used.has(pkg)) used.set(pkg, new Set());
      used.get(pkg).add(f.rel);
    }
  }

  const candidates = [];

  for (const [name, info] of declared) {
    if (used.has(name)) continue;
    candidates.push({
      file: manifest.file,
      line: 1,
      text: `依赖 \`${name}@${info.ver}\`（${info.dev ? 'devDependencies' : 'dependencies'}）`
        + '在源码里找不到任何 import。\n\n'
        + '注意：构建工具、CLI、插件、类型包、被配置文件按名字引用的依赖都可能没有 import 语句。',
      meta: { kind: 'unused-dep', name, dev: info.dev, version: info.ver },
    });
  }

  for (const [pkg, where] of used) {
    if (declared.has(pkg)) continue;
    candidates.push({
      file: [...where][0],
      line: 1,
      text: `\`${pkg}\` 被 ${where.size} 个文件 import，但没有出现在依赖清单里。\n\n`
        + `引用方：${[...where].slice(0, 6).join('、')}`,
      meta: { kind: 'missing-dep', name: pkg, files: [...where].slice(0, 6) },
    });
  }

  // 功能重复只能整体看：逐个依赖问「你和谁重复」是问不出来的
  if (declared.size > 1) {
    candidates.push({
      file: manifest.file,
      line: 1,
      text: '完整依赖清单（请判断有无两个及以上依赖在做同一件事，例如同时装了两个 HTTP 客户端、'
        + '两个日期库、两个测试框架）：\n\n'
        + [...declared.entries()].map(([n, i]) => `- ${n}@${i.ver}${i.dev ? ' (dev)' : ''}`).join('\n'),
      meta: { kind: 'dep-overlap', count: declared.size },
    });
  }

  return { candidates, sharedContext: '' };
}

/* ==================== docs ==================== */

/** README 里的命令行代码块：判「照着能不能跑起来」的证据 */
function extractCommandBlocks(md) {
  const out = [];
  const lines = String(md ?? '').split(/\r?\n/);
  let inFence = false;
  let buf = [];
  let startLine = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (t.startsWith('```')) {
      if (inFence) {
        if (buf.length) out.push({ line: startLine, body: buf.join('\n') });
        inFence = false;
        buf = [];
      } else {
        inFence = true;
        startLine = i + 1;
      }
      continue;
    }
    if (!inFence) continue;
    // 只留看起来像命令的行；纯代码示例不属于「上手步骤」
    if (/^\s*(?:\$\s*)?(?:npm|pnpm|yarn|npx|node|python3?|pip3?|go|cargo|make|docker|sh|bash|\.\/)\b/.test(lines[i])) {
      buf.push(lines[i].trim());
    }
  }
  return out;
}

export function recallOnboardingDocs({ readme = null, manifest = null } = {}) {
  const candidates = [];
  const scripts = manifest?.scripts || {};
  const scriptList = Object.entries(scripts).map(([k, v]) => `- npm run ${k} → ${v}`).join('\n');

  if (!readme || !String(readme.text || '').trim()) {
    candidates.push({
      file: 'README.md',
      line: 1,
      text: '项目没有 README（或内容为空）。新人 / AI 拿到这个仓库时没有任何上手入口。',
      meta: { kind: 'no-readme' },
    });
    return { candidates, sharedContext: scriptList ? `## 项目真实可用的脚本\n\n${scriptList}` : '' };
  }

  const md = String(readme.text);
  const blocks = extractCommandBlocks(md);

  if (blocks.length === 0) {
    candidates.push({
      file: readme.rel,
      line: 1,
      text: `${readme.rel} 里没有任何可执行的命令块（安装 / 启动 / 测试）。\n\n`
        + `文档开头 40 行：\n${md.split(/\r?\n/).slice(0, 40).join('\n')}`,
      meta: { kind: 'no-commands' },
    });
  }

  for (const b of blocks) {
    candidates.push({
      file: readme.rel,
      line: b.line,
      text: `${readme.rel}:${b.line} 的命令块：\n\n${b.body}`,
      meta: { kind: 'command-block', line: b.line },
    });
  }

  return {
    candidates,
    sharedContext: scriptList
      ? `## 项目真实可用的脚本（判「文档里的命令是否有效」以它为准）\n\n${scriptList}`
      : '## 项目清单里没有声明任何脚本',
  };
}

/* ==================== hygiene 深化 ==================== */

/** 明确该入库的源码 / 配置扩展名。不在表里的才需要判 */
const EXPECTED_EXT = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'py', 'pyi', 'go', 'java', 'kt', 'rs',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'swift', 'php', 'rb', 'scala', 'dart', 'sh', 'bash',
  'md', 'json', 'yml', 'yaml', 'toml', 'xml', 'html', 'css', 'scss', 'less', 'svg', 'sql',
  'txt', 'lock', 'gitignore', 'env', 'ini', 'conf', 'properties', 'gradle', 'dockerfile',
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'woff', 'woff2', 'ttf', 'otf',
]);

/** 临时/废弃语义的命名片段。比确定性规则的 `tmp-|temp-|debug-` 前缀宽得多，靠模型收口 */
const TEMP_SEMANTICS = /(?:^|[.\-_/])(?:tmp|temp|bak|backup|old|copy|orig|draft|scratch|probe|wip|deprecated|unused)(?:$|[.\-_/])/i;

/** 超过这个字节数的入库文件值得问一句（大文件会让 clone 变慢，且多半是产物） */
const BIG_FILE_BYTES = 1024 * 1024;

/**
 * 已被确定性规则（check-hygiene.logic.js 的 H1/H2）覆盖的，不重复送判。
 * 两层的分工：那层零误报、只认最保险的形状；这层负责补召回率。
 */
const DETERMINISTIC_COVERED = [/\.(?:jsonl|log)$/i, /^(?:tmp|temp|debug)-[^/]*$/i];

export function recallSuspiciousTracked({ tracked = [], isRepo = true } = {}) {
  // 与 check-hygiene.logic.js 的 na 口径对齐：不是 git 仓库就无从谈「版本库卫生」
  if (!isRepo) return { candidates: [], sharedContext: '', na: '不是 git 仓库，无法判断版本库卫生' };

  const candidates = [];

  for (const f of tracked) {
    const rel = f.rel;
    if (DETERMINISTIC_COVERED.some((re) => re.test(rel))) continue;
    // 依赖锁文件与夹具本该入库，别去骚扰它们
    if (/(?:^|\/)(?:fixtures|__fixtures__|vendor|node_modules)(?:\/|$)/.test(rel)) continue;

    const ext = (/\.([A-Za-z0-9]+)$/.exec(rel) || [, ''])[1].toLowerCase();
    const reasons = [];
    if (ext && !EXPECTED_EXT.has(ext)) reasons.push(`扩展名 .${ext} 不属于常规源码/配置`);
    if (TEMP_SEMANTICS.test(rel)) reasons.push('路径里含临时/废弃语义的命名');
    if (f.size > BIG_FILE_BYTES) reasons.push(`体积 ${(f.size / 1024 / 1024).toFixed(1)} MB`);
    if (!reasons.length) continue;

    candidates.push({
      file: rel,
      line: 1,
      text: `git 追踪中的可疑文件 \`${rel}\`：${reasons.join('；')}。\n\n`
        + '请判断它是否**本该**在版本库里。',
      meta: { kind: 'suspicious-tracked', size: f.size, ext },
    });
  }

  return { candidates, sharedContext: '' };
}
