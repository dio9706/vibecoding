/**
 * 证据包收集 —— 全部新维度的唯一取材入口（本层是 fs / git IO，判定逻辑全在 *.logic.js）。
 *
 * ## 为什么要「一次读全、多维度共用」
 *
 * 十个新维度里有七个都要遍历源码。各维度自己读盘的话，一次体检要把整个仓库读十遍
 * （本仓库约 200 个文件、几 MB，重复读的代价还能忍；但用户的项目可能是几千个文件）。
 * 更要紧的是**一致性**：十个维度各自遍历，就会各自漂移出不同的排除规则和文件集，
 * 于是同一个文件在 complexity 里算、在 duplication 里不算——这类不一致排查起来极其痛苦。
 *
 * 所以这里读一次，产出一个不可变的证据包，各召回器从它取材。
 *
 * ## 指纹按「取材范围」分组，而不是一个全局指纹
 *
 * 一个全局指纹会让「改了一行源码」把 docs / deps 的缓存也一起作废——它们跟源码没关系，
 * 白烧一轮判定额度。所以按 scope 分四份：sources / manifest / docs / tracked。
 * 各维度在注册表里声明自己吃哪一份（见 dimensions/registry.js 的 fingerprintScope）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { gitTrackedFiles } from '../git-tracked.js';
import { shouldSkipDir } from '../scan-dirs.logic.js';
import { computeFingerprint } from '../fingerprint.logic.js';
import { measureFile } from './units.logic.js';
import { collectExports } from './symbols.logic.js';
import { logger } from '../../../shared/logger.js';

/**
 * 单文件读取上限。
 *
 * 超过这个体积的「源文件」基本都是生成物：打包产物、内联了 base64 的资源、
 * 导出的数据表。它们既不该被评价代码质量，读进内存还会把整个证据包撑到几百 MB。
 * 512KB 对手写代码是极宽的上限（本仓库最大的源文件不到 40KB）。
 */
const MAX_FILE_BYTES = 512 * 1024;

/** 参与代码级维度的扩展名。这张表决定「什么算源码」，比 git 追踪清单更窄 */
const SOURCE_EXT = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts',
  'py', 'pyi', 'go', 'java', 'kt', 'kts', 'rs', 'swift',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'rb', 'scala', 'dart',
]);

/** 项目自述文件的候选名，按优先级 */
const README_NAMES = ['README.md', 'readme.md', 'README.MD', 'Readme.md', 'README'];

/** 送进模型的分层约定上限：根 CLAUDE.md 可能上千行，只取开头够用 */
const CONVENTIONS_CLIP = 4000;

function extOf(rel) {
  const m = /\.([A-Za-z0-9]+)$/.exec(rel);
  return m ? m[1].toLowerCase() : '';
}

/**
 * 本层**额外**排除的目录段。
 *
 * 为什么不直接加进共用的 `SKIP_DIR`：map / prompts / comments 三个既有维度的判定结果
 * 是多次实测校准出来的（批大小、超时预算都按当时的候选量定的），动它们的扫描范围
 * 等于让那些校准失效。所以新维度的额外排除留在本层。
 *
 * 每一项都对着一类「不该被评价代码质量」的文件：
 *   vendor / third_party —— 三方库副本，不是我们写的（本仓库 public/vendor 有 9 个文件，
 *     其中 marked.umd.js 是压缩产物，光它一个就能刷出十几条假的「命令执行」候选）
 *   archive —— 归档的旧代码，刻意留着不改
 *   target / out / generated / __pycache__ / .next / .nuxt —— 构建与生成产物
 *   venv / .venv —— Python 虚拟环境（里面是整个依赖树）
 */
const EXTRA_SKIP_DIR = new Set([
  'vendor', 'third_party', 'thirdparty', 'archive',
  'target', 'out', 'generated', '__pycache__', '.next', '.nuxt',
  'venv', '.venv', '.tox', '.mypy_cache', '.pytest_cache',
]);

/** 压缩 / 打包产物的文件名特征。它们通常一行几万字符，任何行级度量都无意义 */
const GENERATED_FILE = /\.(?:min|umd|bundle|chunk|esm)\.\w+$|-min\.\w+$/i;

/** 路径里是否含被排除的目录段（git 清单是路径，SKIP_DIR 是目录名，要逐段比） */
function inSkippedDir(rel) {
  const segs = rel.split('/');
  return segs.slice(0, -1).some((seg) => shouldSkipDir(seg) || EXTRA_SKIP_DIR.has(seg));
}

/**
 * 非 git 仓库时的降级遍历。
 *
 * 与 git 清单的差别必须说清楚：这条路径拿不到 .gitignore 的排除信息，所以会把
 * 构建产物一起收进来（git-tracked.js 记录过这个事故：同一处注释被报 3 次）。
 * 靠 SKIP_DIR + 扩展名白名单尽量兜住，但仍不如 git 清单准。这是「有结果」与「准确」之间
 * 的取舍——非 git 项目直接不体检，比多报几条更糟。
 */
function walkAll(dir) {
  const out = [];
  const walk = (cur, rel) => {
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (shouldSkipDir(e.name)) continue;
        walk(path.join(cur, e.name), rel ? `${rel}/${e.name}` : e.name);
      } else if (e.isFile()) {
        out.push(rel ? `${rel}/${e.name}` : e.name);
      }
    }
  };
  walk(dir, '');
  return out;
}

/** 读一个文件；读不到 / 过大一律返回 null（调用方按「不存在」处理） */
function readText(full, limit = MAX_FILE_BYTES) {
  try {
    const st = fs.statSync(full);
    if (!st.isFile() || st.size > limit) return null;
    return fs.readFileSync(full, 'utf8');
  } catch {
    return null;
  }
}

/** package.json / requirements.txt / go.mod —— 认哪个就读哪个 */
function readManifest(dir) {
  const pkgText = readText(path.join(dir, 'package.json'));
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText);
      return {
        file: 'package.json',
        kind: 'npm',
        deps: pkg.dependencies || {},
        devDeps: pkg.devDependencies || {},
        scripts: pkg.scripts || {},
      };
    } catch (e) {
      // package.json 语法错本身就是个问题，但它不属于任何一个维度的判据；
      // 记一条日志、当没有清单处理，别让整个体检因为一个坏 JSON 停下
      logger.warn('checkup/collect', 'package.json 解析失败，依赖维度将跳过', { err: e?.message });
      return null;
    }
  }

  const req = readText(path.join(dir, 'requirements.txt'));
  if (req) {
    const deps = {};
    for (const line of req.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9._-]+)\s*(?:[=<>~!]=?\s*(.+))?\s*$/.exec(line);
      if (m && !line.trim().startsWith('#')) deps[m[1]] = m[2] || '*';
    }
    return { file: 'requirements.txt', kind: 'pip', deps, devDeps: {}, scripts: {} };
  }

  const gomod = readText(path.join(dir, 'go.mod'));
  if (gomod) {
    const deps = {};
    for (const m of gomod.matchAll(/^\s*([\w.\-/]+)\s+v(\S+)/gm)) deps[m[1]] = `v${m[2]}`;
    return { file: 'go.mod', kind: 'go', deps, devDeps: {}, scripts: {} };
  }

  return null;
}

function readReadme(dir) {
  for (const name of README_NAMES) {
    const text = readText(path.join(dir, name));
    if (text !== null) return { rel: name, text };
  }
  return null;
}

/**
 * 项目自己声明的分层/架构约定。
 *
 * 优先根 CLAUDE.md：AI 协作项目会把「依赖方向」这类约定写在那里（本仓库就是），
 * 它比任何启发式推断都权威。没有就退回 README。两个都没有时返回空串，
 * 召回器会据此告诉模型「按目录命名推断，并说明你推断的层序」。
 */
function readConventions(dir) {
  for (const name of ['CLAUDE.md', 'AGENTS.md', 'ARCHITECTURE.md', 'docs/ARCHITECTURE.md']) {
    const text = readText(path.join(dir, name));
    if (text) return text.slice(0, CONVENTIONS_CLIP);
  }
  return '';
}

/** 单份模块级约定文档的截断长度。分层例外通常写在开头的「模块定位」段里 */
const MODULE_CONVENTIONS_CLIP = 1600;

/**
 * 各模块目录自己的约定文档（`<模块目录>/CLAUDE.md`）。
 *
 * ## 为什么必须收：**分层例外写在这里，不在根文档里**
 *
 * 2026-09-04 实测事故。本仓库根 CLAUDE.md 声明「下层不得 import 上层」，
 * 而 `src/shared/CLAUDE.md` 里写着一条例外：
 *
 * > **单一入口聚合层**：`config` / `messages` / `bot-activity`。它们**刻意反向 import**
 * > `src/store` 与 `src/integrations`……这不是分层倒挂的疏漏，而是为了让
 * > 「读 env / 拼用户可见文案 / 埋点」各自只有一个出口。
 *
 * 原实现只读根文档（本仓库 3424 字），模型完全看不到这条例外，
 * 于是把两条**有据可依的刻意设计**判成了 `A1_DEP_VIOLATION`。
 * 在架构文档写得越用心的项目上，这个误判只会越多——因为例外恰恰是被认真记录下来的那部分。
 *
 * 取材范围与 `layerOf` 对齐（前两段路径），这样召回出的每条依赖边都能配上双方的模块文档。
 *
 * @returns {Record<string, string>} `{'src/shared': '<文档开头>', ...}`
 */
function readModuleConventions(dir, relList) {
  const layers = new Set();
  for (const rel of relList) {
    const parts = rel.split('/');
    if (parts.length >= 2) layers.add(`${parts[0]}/${parts[1]}`);
  }

  const out = {};
  for (const layer of layers) {
    for (const name of ['CLAUDE.md', 'AGENTS.md']) {
      const text = readText(path.join(dir, layer, name));
      if (text) {
        out[layer] = text.slice(0, MODULE_CONVENTIONS_CLIP);
        break;
      }
    }
  }
  return out;
}

/**
 * 收集一次证据包。
 *
 * @param {string} dir 项目根
 * @returns {Promise<{
 *   dir:string,
 *   files:Array<{rel:string, full:string, text:string, measure:{total:number,significant:number}}>,
 *   exports:Array<object>,
 *   tracked:Array<{rel:string, size:number}>,
 *   manifest:object|null,
 *   readme:{rel:string,text:string}|null,
 *   conventions:string,
 *   moduleConventions:Record<string,string>,
 *   isRepo:boolean,
 *   fingerprints:{sources:string, manifest:string, docs:string, tracked:string},
 * }>}
 */
export async function collectEvidence(dir) {
  const trackedSet = await gitTrackedFiles(dir);
  const isRepo = trackedSet !== null;
  const relList = isRepo ? [...trackedSet] : walkAll(dir);

  const tracked = [];
  const files = [];
  const sourceStats = [];

  for (const rel of relList) {
    if (inSkippedDir(rel)) continue;
    const full = path.join(dir, rel);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile()) continue;

    // tracked 是 hygiene 维度的取材面：**不**按扩展名过滤，
    // 因为「不该入库的文件」恰恰多半不是源码
    tracked.push({ rel, size: st.size });

    if (!SOURCE_EXT.has(extOf(rel))) continue;
    if (GENERATED_FILE.test(rel)) continue;
    if (st.size > MAX_FILE_BYTES) continue;
    const text = readText(full, MAX_FILE_BYTES);
    if (text === null) continue;

    files.push({ rel, full, text, measure: measureFile(text) });
    sourceStats.push({ path: rel, mtime: st.mtimeMs, size: st.size });
  }

  const manifest = readManifest(dir);
  const readme = readReadme(dir);

  // 导出符号表在这里算一次：naming 与 deadcode 两个维度共用，
  // 而它内部要建一张全仓 token 索引，算两遍纯属浪费
  const exportsList = collectExports(files);

  const statOf = (rel) => {
    try {
      const st = fs.statSync(path.join(dir, rel));
      return { path: rel, mtime: st.mtimeMs, size: st.size };
    } catch {
      return { path: rel, mtime: 0, size: 0 };
    }
  };

  return {
    dir,
    files,
    exports: exportsList,
    tracked,
    manifest,
    readme,
    conventions: readConventions(dir),
    // 模块级文档：分层**例外**写在这里而不是根文档（见 readModuleConventions 的事故记录）
    moduleConventions: readModuleConventions(dir, relList),
    isRepo,
    fingerprints: {
      sources: computeFingerprint(sourceStats),
      manifest: computeFingerprint(manifest ? [statOf(manifest.file)] : []),
      docs: computeFingerprint([
        ...(readme ? [statOf(readme.rel)] : []),
        ...(manifest ? [statOf(manifest.file)] : []),
      ]),
      // tracked 指纹只用清单本身（路径+体积），不含 mtime：
      // 「哪些文件在版本库里」是这个维度的全部判据，改内容不影响结论
      tracked: computeFingerprint(tracked.map((t) => ({ path: t.rel, mtime: 0, size: t.size }))),
    },
  };
}
