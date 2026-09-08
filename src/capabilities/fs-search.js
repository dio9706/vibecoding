/**
 * 受限只读代码检索 —— 把「让模型查一个代码仓库」收窄成一个安全的、可测的能力。
 *
 * 起因：埋点报告里光有中文名还不够，产品要知道「这个埋点到底在什么场景下打的、
 * 它的属性取值各是什么意思」。这些信息只在前端仓库里
 *（`docs/*-events-for-ops.md` 写了属性语义，903 处 `trackClickApi(` 调用点写了触发条件），
 * 库里的 `event_mapping` 没有。
 *
 * ## 为什么不直接给 Agent 内置的 Read/Grep 工具
 *
 * 内置工具没有目录边界，也不认识「哪些文件不该给模型看」。而前端仓库根目录就躺着
 * `.env.local` 和 `private.wx969ed64a29181401.key`（小程序私钥）—— 实测存在，不是假想。
 * 一个只会 grep 代码的工具泄露不了什么，一个能读任意文件的工具能把密钥读出来。
 *
 * 所以本模块提供的是**带边界的检索**：
 *   1. 路径硬限在 root 内（realpath 后前缀校验，挡住 `../` 与符号链接逃逸）
 *   2. 敏感文件一律不读、不出现在结果里（黑名单 + 二进制嗅探）
 *   3. 结果规模封顶（防一次检索把上下文撑爆）
 *
 * 本模块无业务语义（不知道什么是埋点），符合 capabilities 层定位；
 * 「搜哪个仓库」由调用方传入。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 不予读取的文件名/后缀 —— 命中即当作不存在（不报错、不列出，避免暴露其存在性） */
const DENY_PATTERNS = [
  /(^|[/\\])\.env($|\.)/i, // .env / .env.local / .env.prod
  /\.(key|pem|p12|pfx|jks|keystore|crt|cer)$/i,
  /(^|[/\\])id_(rsa|dsa|ecdsa|ed25519)/i,
  /(^|[/\\])\.npmrc$/i,
  /(^|[/\\])\.git([/\\]|$)/i,
  /(^|[/\\])credentials?\./i,
  /(^|[/\\])secrets?\./i,
];

/** 不进入的目录 —— 体积大且无信息量，扫进去只会拖慢并挤占结果配额 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
  'coverage', '.cache', '.turbo', 'unpackage', 'miniprogram_npm',
]);

/** 只在这些后缀里搜（正文可读的源码与文档） */
const TEXT_EXT = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.vue', '.mjs', '.cjs',
  '.json', '.md', '.csv', '.txt', '.yaml', '.yml', '.html', '.css', '.scss',
]);

const MAX_FILE_BYTES = 512 * 1024; // 单文件上限：超过多半是构建产物或数据转储
const MAX_MATCHES = 60; // 单次检索命中上限
const MAX_LINE_LEN = 300; // 单行截断（压缩后的源码一行能有几万字符）
const MAX_READ_BYTES = 60 * 1024; // read() 单次返回上限

/** 命中敏感黑名单？（对**相对路径**判定，规则里的 `/` 与 `\` 都认） */
export function isDenied(relPath) {
  const p = String(relPath || '');
  return DENY_PATTERNS.some((re) => re.test(p));
}

/**
 * 把用户/模型给的相对路径解析成 root 内的绝对路径；越界或命中黑名单返回 null。
 *
 * 用 realpath 而不是只做字符串拼接：符号链接能把 `docs/x` 指到 `C:\secrets`，
 * 纯字符串前缀校验挡不住。文件不存在时退回 resolve 后的路径做前缀校验
 *（不存在的路径读不出东西，但仍要挡住越界写法以免泄露目录结构）。
 */
export function resolveInside(root, relPath) {
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, String(relPath || ''));
  let real = target;
  try {
    real = fs.realpathSync(target);
  } catch {
    /* 不存在：用 resolve 结果继续做边界校验 */
  }
  let realRoot = rootAbs;
  try {
    realRoot = fs.realpathSync(rootAbs);
  } catch {
    /* root 不存在，下面的前缀校验会自然失败 */
  }
  const rel = path.relative(realRoot, real);
  // rel 以 .. 开头或是绝对路径 → 跑到 root 外面去了
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return rel === '' ? null : null;
  }
  if (isDenied(rel)) return null;
  return real;
}

/** 递归列出 root 下可搜的文本文件（相对路径），带数量上限防目录过大 */
function* walk(root, dir = root, budget = { n: 20000 }) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (budget.n <= 0) return;
    const abs = path.join(dir, e.name);
    const rel = path.relative(root, abs);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      yield* walk(root, abs, budget);
      continue;
    }
    if (!e.isFile()) continue;
    if (isDenied(rel)) continue;
    if (!TEXT_EXT.has(path.extname(e.name).toLowerCase())) continue;
    budget.n -= 1;
    yield rel;
  }
}

/**
 * 建一个绑定到某个目录的只读检索器。
 *
 * @param {string} root 仓库根目录（绝对路径）
 * @returns {{ ok: boolean, error?: string, search: Function, read: Function }}
 */
export function createScopedSearch(root) {
  const rootAbs = root ? path.resolve(root) : '';
  const ok = !!rootAbs && fs.existsSync(rootAbs) && fs.statSync(rootAbs).isDirectory();

  return {
    ok,
    error: ok ? undefined : `代码仓库目录不可用：${rootAbs || '(未配置)'}`,

    /**
     * 全文检索。返回 `{ matches: [{file, line, text}], truncated }`。
     * 查询串按**字面量**匹配（不当正则），避免模型写出灾难性回溯的表达式。
     */
    search(query, { max = MAX_MATCHES } = {}) {
      if (!ok) return { error: this.error };
      const q = String(query || '').trim();
      if (!q) return { error: '检索词不能为空' };
      const needle = q.toLowerCase();
      const matches = [];
      for (const rel of walk(rootAbs)) {
        if (matches.length >= max) return { matches, truncated: true };
        const abs = path.join(rootAbs, rel);
        let text;
        try {
          if (fs.statSync(abs).size > MAX_FILE_BYTES) continue;
          text = fs.readFileSync(abs, 'utf8');
        } catch {
          continue;
        }
        if (!text.toLowerCase().includes(needle)) continue; // 先整体判定，省掉逐行开销
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          if (!lines[i].toLowerCase().includes(needle)) continue;
          matches.push({
            file: rel.replace(/\\/g, '/'),
            line: i + 1,
            text: lines[i].trim().slice(0, MAX_LINE_LEN),
          });
          if (matches.length >= max) return { matches, truncated: true };
        }
      }
      return { matches, truncated: false };
    },

    /** 读单个文件（截断到 MAX_READ_BYTES）。越界/敏感/不存在一律返回 error。 */
    read(relPath, { maxBytes = MAX_READ_BYTES } = {}) {
      if (!ok) return { error: this.error };
      const abs = resolveInside(rootAbs, relPath);
      if (!abs) return { error: `路径不可读（越界或受限）：${relPath}` };
      try {
        const st = fs.statSync(abs);
        if (!st.isFile()) return { error: '不是文件' };
        const buf = fs.readFileSync(abs);
        const truncated = buf.length > maxBytes;
        return {
          file: String(relPath).replace(/\\/g, '/'),
          content: buf.subarray(0, maxBytes).toString('utf8'),
          truncated,
        };
      } catch (e) {
        return { error: `读取失败：${e.message}` };
      }
    },
  };
}
