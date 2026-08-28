/**
 * 事实包的文件系统层：扫盘产出「模型自由探索之前就该知道的硬事实」。
 *
 * 全部只读，不写任何文件。所有失败都吞掉转成空串——事实包是**保底**信息，
 * 缺一节会让地图质量下降，为它中断整个生成得不偿失。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { shouldSkipDir } from '../project-checkup/scan-dirs.logic.js';
import { extractExports, headComment, formatFactPack } from './map-facts.logic.js';

const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|vue|py|go|rs|java|scss|css)$/i;
const TREE_DEPTH = 2;        // 根事实包的目录树深度：够看出项目分层，再深就是把 ls -R 塞进 prompt
const MAX_MODULE_FILES = 60; // 单模块列举上限：超大模块全列会挤爆 prompt，且长尾文件对导航价值递减
const README_LINES = 60;
const GIT_LOG_COUNT = 20;

const readText = (abs) => { try { return fs.readFileSync(abs, 'utf8'); } catch { return ''; } };

/** 目录树（限深），每行一个条目，目录带尾斜杠 */
function treeOf(dir, depth, prefix = '') {
  if (depth <= 0) return [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (shouldSkipDir(e.name, { skipHidden: true })) continue;
    if (e.isDirectory()) {
      out.push(`${prefix}${e.name}/`);
      out.push(...treeOf(path.join(dir, e.name), depth - 1, `${prefix}  `));
    } else if (CODE_EXT.test(e.name) || /\.(md|json)$/i.test(e.name)) {
      out.push(`${prefix}${e.name}`);
    }
  }
  return out;
}

/** 递归收集模块内的代码文件相对路径 */
function filesOf(dir, rel = '') {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (shouldSkipDir(e.name, { skipHidden: true })) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...filesOf(path.join(dir, e.name), r));
    else if (CODE_EXT.test(e.name)) out.push(r);
  }
  return out;
}

/** 模块顶层的 markdown 文件（不含要生成的 CLAUDE.md 本身） */
function listMarkdown(abs) {
  try {
    return fs.readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.md$/i.test(e.name) && e.name !== 'CLAUDE.md')
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** 最近若干条提交的 subject。不是 git 仓库或 git 不可用都返回空串 */
function gitLog(projectDir) {
  try {
    return execFileSync('git', ['log', `-${GIT_LOG_COUNT}`, '--pretty=format:%s'], {
      cwd: projectDir, encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * 根地图的事实包。
 *
 * 「已有的模块地图」这一节很关键：根地图要写模块路由表，而模块地图的存在与否
 * 决定了路由表该指向 `src/foo/CLAUDE.md` 还是直接指向源码目录。
 *
 * @returns {string} 已渲染的事实包文本
 */
export function collectRootFacts(projectDir) {
  let pkgBody = '';
  try {
    const pkg = JSON.parse(readText(path.join(projectDir, 'package.json')));
    pkgBody = [
      pkg.name ? `名称：${pkg.name}` : '',
      pkg.description ? `描述：${pkg.description}` : '',
      pkg.type ? `模块制式：${pkg.type}` : '',
      pkg.main || pkg.bin ? `入口：${pkg.main || JSON.stringify(pkg.bin)}` : '',
      Object.keys(pkg.scripts || {}).length
        ? `脚本：\n${Object.entries(pkg.scripts).map(([k, v]) => `  npm run ${k}  →  ${v}`).join('\n')}`
        : '',
      Object.keys(pkg.dependencies || {}).length
        ? `主要依赖：${Object.keys(pkg.dependencies).slice(0, 25).join('、')}`
        : '',
    ].filter(Boolean).join('\n');
  } catch { /* 没有或读不出 package.json 的项目（Python/Go）照常走，这一节留空 */ }

  // 模块基准与 check-map.js 保持一致：有 src/ 就以它为准，否则退化到项目根。
  // 两边口径必须一样，否则「体检说 src/foo 缺地图」而「生成端去扫 foo」
  const srcDir = path.join(projectDir, 'src');
  const hasSrc = fs.existsSync(srcDir);
  const base = hasSrc ? srcDir : projectDir;
  const prefix = hasSrc ? 'src/' : '';

  const existingMaps = [];
  try {
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory() || shouldSkipDir(e.name, { skipHidden: true })) continue;
      if (fs.existsSync(path.join(base, e.name, 'CLAUDE.md'))) existingMaps.push(`${prefix}${e.name}/CLAUDE.md`);
    }
  } catch { /* 读不到就当没有 */ }

  const readme = ['README.md', 'readme.md', 'README.zh-CN.md']
    .map((n) => readText(path.join(projectDir, n)))
    .find(Boolean) || '';

  return formatFactPack([
    { title: '目录结构（限两层）', body: treeOf(projectDir, TREE_DEPTH).join('\n') },
    { title: 'package.json 要点', body: pkgBody },
    { title: '已有的模块地图', body: existingMaps.join('\n') },
    { title: 'README 开头', body: readme.split('\n').slice(0, README_LINES).join('\n') },
    { title: `最近 ${GIT_LOG_COUNT} 条提交`, body: gitLog(projectDir) },
  ]);
}

/**
 * 单个模块的事实包。
 *
 * 「文件职责」那一节靠 headComment 抽取——本仓库几乎每个模块开头都有一段
 * 「为什么这么做」的块注释，密度和准确度都远超任何静态分析。
 *
 * @param {string} projectDir
 * @param {string} moduleRel 模块相对路径，如 'src/features'
 */
export function collectModuleFacts(projectDir, moduleRel) {
  const abs = path.join(projectDir, moduleRel);
  const files = filesOf(abs);
  const shown = files.slice(0, MAX_MODULE_FILES);

  const lines = shown.map((rel) => {
    const code = readText(path.join(abs, rel));
    const loc = code ? code.split('\n').length : 0;
    const duty = headComment(code);
    const exps = extractExports(code).slice(0, 8);
    const tail = [duty && `职责：${duty}`, exps.length && `导出：${exps.join(', ')}`].filter(Boolean).join('｜');
    return `- ${rel}（${loc} 行）${tail ? `　${tail}` : ''}`;
  });

  if (files.length > shown.length) {
    // 截断要说出来：不说的话模型会以为这就是全部文件，写出一份漏掉一半内容的地图
    lines.push(`- …另有 ${files.length - shown.length} 个文件未列出（模块过大，仅列前 ${MAX_MODULE_FILES} 个）`);
  }

  return formatFactPack([
    { title: `模块 ${moduleRel} 的文件清单`, body: lines.join('\n') },
    { title: '模块内已有的说明文档', body: listMarkdown(abs).join('\n') },
  ]);
}
