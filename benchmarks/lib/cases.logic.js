/**
 * 内部 benchmark 的案例层纯函数（T5，spec `docs/superpowers/specs/2026-10-08-internal-benchmark-design.md`）。
 * 零 IO：schema 校验/归一、扫描候选判定、git numstat 日志解析、验证命令构造、draft 生成。
 * 编排（worktree/agent/verify）在 runner.js；报告在 report.logic.js。
 */

export const CASE_TYPES = ['bug', 'feature'];

const TEST_FILE_RE = /\.test\.js$/;
const HEX_RE = /^[0-9a-f]{7,40}$/i;

/** 判据文件判定（案例 schema 只收测试文件作为可重置的判据） */
export function isTestFile(p) {
  return TEST_FILE_RE.test(String(p || '').trim());
}

/** 相对路径且不含 `..`/绝对路径（防 overlay 越出工作树） */
export function isSafeRelPath(p) {
  const s = String(p || '').trim();
  if (!s) return false;
  if (/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(s)) return false; // 盘符 / UNC / POSIX 绝对
  if (s.split(/[\\/]/).includes('..')) return false;
  if (/[\x00-\x1f]/.test(s)) return false;
  return true;
}

/** 案例归一：trim + 去重 testFiles + 补默认；不校验合法性 */
export function normalizeCase(raw = {}) {
  const testFiles = [...new Set((Array.isArray(raw.testFiles) ? raw.testFiles : []).map((f) => String(f || '').trim()).filter(Boolean))];
  return {
    id: String(raw.id || '').trim(),
    title: String(raw.title || '').trim(),
    type: CASE_TYPES.includes(raw.type) ? raw.type : 'feature',
    input: String(raw.input || '').trim(),
    analysis: String(raw.analysis || '').trim(),
    fixRef: String(raw.fixRef || '').trim(),
    baseRef: String(raw.baseRef || '').trim() || null,
    testFiles,
    verifyCommand: String(raw.verifyCommand || '').trim(),
    tags: [...new Set((Array.isArray(raw.tags) ? raw.tags : []).map((t) => String(t || '').trim()).filter(Boolean))],
    draft: raw.draft === true,
  };
}

/**
 * 案例校验。
 * @param {object} raw 原样案例
 * @param {{knownIds?: Set<string>}} [opts] knownIds 其他案例的 id（查重）
 * @returns {{ok:boolean, errors:string[], case:object}}
 */
export function validateCase(raw, { knownIds = new Set() } = {}) {
  const c = normalizeCase(raw);
  const errors = [];
  if (!c.id) errors.push('id 必填');
  else if (!/^[a-z0-9][a-z0-9-]*$/i.test(c.id)) errors.push(`id 含非法字符（只允许字母数字与 -）：${c.id}`);
  else if (knownIds.has(c.id)) errors.push(`id 重复：${c.id}`);
  if (!c.input) errors.push('input（原始反馈）必填');
  if (!c.fixRef) errors.push('fixRef 必填');
  else if (!HEX_RE.test(c.fixRef)) errors.push(`fixRef 不是合法 commit 引用：${c.fixRef}`);
  if (c.baseRef && !HEX_RE.test(c.baseRef)) errors.push(`baseRef 不是合法 commit 引用：${c.baseRef}`);
  if (!c.testFiles.length) errors.push('testFiles 不能为空');
  for (const f of c.testFiles) {
    if (!isSafeRelPath(f)) errors.push(`testFiles 含不安全路径：${f}`);
    else if (!isTestFile(f)) errors.push(`testFiles 必须是 *.test.js：${f}`);
  }
  return { ok: errors.length === 0, errors, case: c };
}

/** 验证命令构造：显式命令优先（只允许案例文件里人写的值），否则 `node --test <files…>` */
export function buildVerifyCommand(testFiles, explicit = '') {
  const cmd = String(explicit || '').trim();
  if (cmd) return cmd;
  const files = (Array.isArray(testFiles) ? testFiles : []).map((f) => String(f || '').trim()).filter(Boolean);
  return 'node --test ' + files.map((f) => (/\s/.test(f) ? JSON.stringify(f) : f)).join(' ');
}

/**
 * 解析 `git log --no-merges --numstat --format=%x00%H%x1f%h%x1f%s%x1f%P` 的输出。
 * 块内：首行元数据（hash/short/subject/parents），其后为 numstat（`ins\tdel\tpath`）。
 * @returns {Array<{hash:string, short:string, subject:string, parents:string[], files:Array<{path:string, insertions:number|null, deletions:number|null}>}>}
 */
export function parseGitNumstatLog(stdout) {
  const out = [];
  for (const block of String(stdout || '').split('\x00').slice(1)) {
    const nl = block.indexOf('\n');
    const meta = (nl < 0 ? block : block.slice(0, nl)).replace(/\r$/, '');
    const body = nl < 0 ? '' : block.slice(nl + 1);
    const [hash, short, subject, parents] = meta.split('\x1f');
    if (!hash) continue;
    const files = [];
    for (const line of body.split('\n')) {
      const t = line.replace(/\r$/, '');
      if (!t) continue;
      const m = t.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m) continue;
      files.push({
        path: m[3],
        insertions: m[1] === '-' ? null : Number(m[1]),
        deletions: m[2] === '-' ? null : Number(m[2]),
      });
    }
    out.push({ hash, short, subject: subject || '', parents: (parents || '').trim().split(/\s+/).filter(Boolean), files });
  }
  return out;
}

const DOCS_RE = /^(docs\/|tests\/archive\/|.*\.md$)/i;

/**
 * 提交是否可作为案例（回放式）：
 *  - 非合并、有父提交；
 *  - 至少 1 个测试文件 且 至少 1 个非测试/非文档文件（「测试+实现」同改才构成回放题）；
 *  - 规模可控（默认 ≤12 文件、插入+删除 ≤800 行，避免大杂烩提交）；
 *  - 主题不是纯 test/docs（那种提交往往只改测试口径，回放没有活干）。
 */
export function isCaseCandidate(commit, { maxFiles = 12, maxDiffLines = 800 } = {}) {
  if (!commit || !commit.hash) return false;
  if (!commit.parents || commit.parents.length === 0) return false;
  const files = commit.files || [];
  const tests = files.filter((f) => isTestFile(f.path));
  const impl = files.filter((f) => !isTestFile(f.path) && !DOCS_RE.test(f.path));
  if (!tests.length || !impl.length) return false;
  if (files.length > maxFiles) return false;
  const lines = files.reduce((n, f) => n + (f.insertions || 0) + (f.deletions || 0), 0);
  if (lines > maxDiffLines) return false;
  const subject = String(commit.subject || '');
  if (/^(test|docs|chore)(\(|:|：)/i.test(subject)) return false;
  return true;
}

/** 主题 → id 片段（小写、非 ASCII 字母数字转 -、限长；全中文标题会得到空串，id 回退为纯短哈希） */
export function slugify(text, max = 40) {
  const s = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, max) || '';
}

/** 括号里的 scope（如 `fix(memory-bank): …` → memory-bank）作为 tag */
function scopeTag(subject) {
  const m = String(subject || '').match(/^[a-z]+\(([^)]+)\)/i);
  return m ? [m[1].toLowerCase()] : [];
}

/**
 * 由扫描到的提交生成 draft 案例（input 先占位为提交主题，**必须人工改写成用户口吻反馈**后才算有效题）。
 * @returns {object} 案例对象（未校验）
 */
export function draftCaseFromCommit(commit) {
  if (!commit || !commit.hash) return null;
  const files = commit.files || [];
  const tests = files.filter((f) => isTestFile(f.path)).map((f) => f.path);
  if (!tests.length) return null;
  const rawSubject = String(commit.subject || '').trim();
  const title = rawSubject.replace(/^[a-z]+(\([^)]*\))?[:：]\s*/i, '').trim();
  const slug = slugify(title);
  return {
    id: slug ? `${commit.short}-${slug}` : commit.short,
    title,
    type: /^(fix|hotfix)/i.test(rawSubject) ? 'bug' : 'feature',
    draft: true,
    input: title, // 占位；人工改写目标：像用户提交的反馈那样说清现象/预期
    analysis: '',
    fixRef: commit.short,
    baseRef: null,
    testFiles: tests,
    verifyCommand: '',
    tags: scopeTag(rawSubject),
  };
}
