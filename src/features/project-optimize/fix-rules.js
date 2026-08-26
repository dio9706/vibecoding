/**
 * rules → skill 降级的执行层：文件系统那一半。
 * 所有文本变换都在 fix-rules.logic.js，这里只负责扫盘、写盘、删盘和失败分级。
 *
 * 这是整个工具里唯一真正**破坏性**的模块（删文件 + 改写全仓引用），
 * 因此三条纪律贯穿全文：
 *
 * 1. **计划先于动作**：planDemote 必须在任何写操作之前跑完，结果交给 createBackup 打快照。
 *    它自己一个字节都不改盘——否则快照记录的就不是原始状态，还原会还到一个中间态。
 * 2. **失败要分级**：写 skill / 删原文件失败 = 核心失败（fatal），文件系统已处于半完成状态，
 *    继续处理后续文件只会越错越多；引用替换失败不算，那只是文档里留了个旧路径，
 *    skill 本身照常可用，为它中断整批降级不划算。
 * 3. **从不抛异常**：一切都通过返回值的 status/fatal 表达。上层是个 for 循环，
 *    一次抛错会把整批降级掀翻在半路，而此时前面几个文件已经删掉了。
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../shared/logger.js';
import { describeSkill } from './describe-skill.js';
import {
  skillNameOf,
  stripFrontmatter,
  buildSkillFile,
  replaceRuleRefs,
  hasRuleRef,
  isArchivedPath,
} from './fix-rules.logic.js';

/**
 * 遍历时跳过的目录。
 *
 * 前五个是常规的依赖与构建产物。`worktrees` 是照搬 check-prompts.js 的口径但理由更重：
 * `.claude/worktrees/` 下是 git worktree 的完整签出副本，每个副本都是**另一个分支的工作区**。
 * 体检那边收进来只是白烧额度，这里往里写就是直接污染别的分支——而且改动落在本次备份之外，
 * 还原也救不回来。
 */
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'worktrees']);

const msgOf = (e) => e?.message || String(e);

/**
 * 收集仓库内所有 markdown 的相对路径（正斜杠，已排序）。
 *
 * 排序不是为了好看：这个结果同时决定备份 manifest 的条目顺序和引用替换的处理顺序，
 * 固定下来才能让两次同样的操作产出可比对的记录。
 *
 * 归档目录（docs/specs|plans|migration、.claude/optimize-backup）整个排除——
 * 那里记录的是当时的事实，把里面的路径改成今天的写法等于篡改历史。
 *
 * @param {string} projectDir
 * @returns {string[]}
 */
export function collectMarkdown(projectDir) {
  const out = [];

  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIR.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        // 补个斜杠再判，好让归档目录在入口处就被剪掉，不必走进去再逐个文件排除
        if (!isArchivedPath(`${r}/`)) walk(path.join(dir, e.name), r);
        continue;
      }
      if (e.isFile() && e.name.toLowerCase().endsWith('.md') && !isArchivedPath(r)) out.push(r);
    }
  };
  walk(projectDir, '');

  return out.sort();
}

/**
 * 列出本次降级会碰到的全部文件及动作，供 createBackup 打快照。
 *
 * **必须在写任何东西之前调用**，且本身无副作用（有单测把关）。
 *
 * @param {string} projectDir
 * @param {string[]} ruleFileNames 形如 `['design-system.md']`
 * @returns {Array<{path:string, action:'deleted'|'created'|'modified'}>}
 */
export function planDemote(projectDir, ruleFileNames) {
  const names = (ruleFileNames || []).map((n) => String(n));
  const entries = new Map();

  for (const fileName of names) {
    const skillName = skillNameOf(fileName);
    // 源文件不存在也照样登记：createBackup 会自己发现并标成「无内容可备份」，
    // 在这里提前过滤反而会让计划和实际执行的文件集合对不上
    entries.set(`.claude/rules/${fileName}`, 'deleted');
    entries.set(`.claude/skills/${skillName}/SKILL.md`, 'created');
  }

  for (const rel of collectMarkdown(projectDir)) {
    // 已登记成 deleted/created 的不再降级成 modified：文件都要没了，改它没有意义
    if (entries.has(rel)) continue;
    let raw;
    try { raw = fs.readFileSync(path.join(projectDir, rel), 'utf8'); } catch { continue; }
    if (names.some((n) => hasRuleRef(raw, skillNameOf(n)))) entries.set(rel, 'modified');
  }

  return [...entries].map(([p, action]) => ({ path: p, action }));
}

/**
 * 降级一个 rules 文件。五步，前四步任一失败就地返回。
 *
 * @param {string} projectDir
 * @param {string} fileName `.claude/rules/` 下的文件名，含 .md
 * @param {object} [opts]
 * @param {(s:{step:string,file:string,skillName:string})=>void} [opts.onStep] 进度回调，供 SSE 推送
 * @param {(name:string, body:string)=>Promise<{description:string,source:string}>} [opts.describe]
 *   description 生成器。默认 describeSkill（真发 LLM 调用）；单测注入桩件，
 *   否则每跑一次测试就是一次真实调用——又慢又花钱，而这一层要验的是流程不是文案质量。
 * @returns {Promise<{file:string, status:'done'|'skipped'|'failed', fatal:boolean, skillName:string,
 *   refsUpdated:string[], refsFailed:Array<{path:string,reason:string}>,
 *   descriptionSource:string|null, reason:string}>}
 *   `fatal` 为真表示上层应停止处理后续文件（见文件头纪律 2）
 */
export async function demoteOne(projectDir, fileName, { onStep, describe = describeSkill } = {}) {
  const skillName = skillNameOf(fileName);
  const relRule = `.claude/rules/${fileName}`;
  const relSkill = `.claude/skills/${skillName}/SKILL.md`;
  const skillDir = path.join(projectDir, '.claude', 'skills', skillName);
  const absRule = path.join(projectDir, relRule);

  const base = {
    file: relRule,
    skillName,
    fatal: false,
    refsUpdated: [],
    refsFailed: [],
    descriptionSource: null,
    reason: '',
  };
  // 进度回调是推给 UI 看的，它自己炸了不该把降级带下水
  const step = (s) => { try { onStep?.({ step: s, file: relRule, skillName }); } catch { /* 忽略 */ } };

  // ---- 第 1 步：前置校验 ----
  // 目标已存在一律不覆盖：那可能是用户手写的 skill，覆盖掉是不可逆的内容丢失，
  // 而跳过的代价只是这一条没优化成。
  if (fs.existsSync(skillDir)) {
    return { ...base, status: 'skipped', reason: `目标 ${relSkill} 已存在，未覆盖` };
  }
  let raw;
  try {
    raw = fs.readFileSync(absRule, 'utf8');
  } catch (e) {
    // 还没写任何东西，文件系统是干净的 → 不是核心失败，后续文件照常处理
    return { ...base, status: 'failed', reason: `读不到源文件：${msgOf(e)}` };
  }

  // ---- 第 2 步：生成 description ----
  step('describe');
  let described;
  try {
    described = await describe(skillName, stripFrontmatter(raw));
  } catch (e) {
    return { ...base, status: 'failed', reason: `生成 description 失败：${msgOf(e)}` };
  }
  const descriptionSource = described?.source ?? null;

  // ---- 第 3 步：写 skill ----
  step('write-skill');
  try {
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, relSkill),
      buildSkillFile({ name: skillName, description: described?.description, body: stripFrontmatter(raw) }),
      'utf8',
    );
  } catch (e) {
    // 核心失败：写盘这一步失败基本是环境性的（目录被占、磁盘满、权限），
    // 后面每个文件都会以同样方式失败，继续只会刷屏
    logger.warn('fix-rules', '写 skill 文件失败，停止后续降级', { file: relRule, err: msgOf(e) });
    return { ...base, status: 'failed', fatal: true, descriptionSource, reason: `写 ${relSkill} 失败：${msgOf(e)}` };
  }

  // ---- 第 4 步：删原文件 ----
  step('delete-rule');
  try {
    fs.rmSync(absRule, { force: true });
  } catch (e) {
    // 核心失败：skill 已经写出去了，原文件还在 —— 同一份规范此刻有两个副本，
    // 再往下替换引用会让文档指向 skill 而 rules 仍在被动注入，是最糟的中间态
    logger.warn('fix-rules', '删除原 rules 文件失败，停止后续降级', { file: relRule, err: msgOf(e) });
    return { ...base, status: 'failed', fatal: true, descriptionSource, reason: `删除 ${relRule} 失败：${msgOf(e)}` };
  }

  // ---- 第 5 步：全仓替换引用 ----
  step('replace-refs');
  const refsUpdated = [];
  const refsFailed = [];
  for (const rel of collectMarkdown(projectDir)) {
    const abs = path.join(projectDir, rel);
    let content;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch (e) {
      // 读不到就无从判断它含不含引用，如实报出来让用户自己看一眼，别装作没这回事
      refsFailed.push({ path: rel, reason: `读取失败，无法确认是否含引用：${msgOf(e)}` });
      continue;
    }
    if (!hasRuleRef(content, skillName)) continue;
    try {
      fs.writeFileSync(abs, replaceRuleRefs(content, skillName), 'utf8');
      refsUpdated.push(rel);
    } catch (e) {
      refsFailed.push({ path: rel, reason: msgOf(e) });
    }
  }

  if (refsFailed.length) {
    logger.warn('fix-rules', '部分引用未能替换（不阻断降级）', {
      file: relRule,
      failed: refsFailed.length,
      first: refsFailed[0]?.path,
    });
  }

  return { ...base, status: 'done', descriptionSource, refsUpdated, refsFailed };
}
