#!/usr/bin/env node
/**
 * vendor 同步 —— 把 node_modules 里的浏览器构建产物拷进 public/vendor/。
 *
 * ## 为什么需要这个脚本
 *
 * 前端是原生 `<script>` 加载、无打包器，Tauri 打包也只带 `public/`，
 * 所以三方库必须在 `public/vendor/` 有一份实体文件。
 *
 * 但此前这几份文件是**手工拷进来的**，不在 package.json 里：
 *   - `npm audit` 完全看不到它们 —— 前端实际运行的代码处于审计盲区；
 *   - 版本只能靠翻文件头注释，升级没有入口，谁都不知道该升到哪；
 *   - 就算 `npm audit fix` 修了 node_modules，前端加载的副本一行都不会变。
 *
 * 纳管后：版本由 package.json 锁定，`npm audit` 能真实覆盖前端，
 * 升级 = `npm update` + 跑一次本脚本。
 *
 * ## 用法
 *
 *   node scripts/sync-vendor.mjs           # 同步（覆盖写入）
 *   node scripts/sync-vendor.mjs --check   # 只校验不写，有漂移则退出码 1
 *
 * `--check` 用于构建前拦截两类事故：升级依赖后忘了同步、以及有人直接手改
 * vendor 文件（那种改动下次同步会被静默冲掉）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const VENDOR_DIR = path.join(ROOT, 'public', 'vendor');

/**
 * 同步清单。
 *
 * 目标文件名刻意与 npm 包内的源文件名保持一致（而不是沿用历史名字），
 * 这样「vendor 里这份是哪个包的哪个构建」不需要查文档就能看出来。
 * 历史遗留的 `anime.iife.min.js` / `marked.min.js` 都名不符实
 * （npm 已不提供 IIFE 构建；marked 的 UMD 也不是压缩版）。
 */
const MANIFEST = [
  { pkg: 'dompurify', from: 'dist/purify.min.js', to: 'purify.min.js' },
  { pkg: 'marked', from: 'lib/marked.umd.js', to: 'marked.umd.js' },
  { pkg: 'animejs', from: 'dist/bundles/anime.umd.min.js', to: 'anime.umd.min.js' },
];

/** vendor 根目录下允许存在的文件；多出来的会被告警（大概率是升级后的孤儿副本） */
const ALLOWED = new Set([...MANIFEST.map((m) => m.to), 'VERSIONS.md']);

/** 读取已安装依赖的实际版本；读不到时返回 null 由调用方报错 */
function installedVersion(pkg) {
  try {
    const pj = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'node_modules', pkg, 'package.json'), 'utf8'),
    );
    return pj.version || null;
  } catch {
    return null;
  }
}

/** 生成版本清单正文。落盘留档，方便 code review 时直接看出版本变化 */
function renderVersions(rows) {
  const lines = [
    '# public/vendor 版本清单',
    '',
    '> 本文件由 `node scripts/sync-vendor.mjs` 自动生成，**请勿手工编辑**。',
    '> 版本由 package.json 锁定；升级请改 package.json 后重跑同步脚本。',
    '',
    '| 文件 | npm 包 | 版本 | 包内来源 |',
    '|---|---|---|---|',
  ];
  for (const r of rows) {
    lines.push(`| \`${r.to}\` | ${r.pkg} | ${r.version} | \`${r.from}\` |`);
  }
  lines.push('');
  lines.push('引用位置：`public/index.html`（script 标签）、`public/js/util.render.test.js`（渲染测试直接加载）。');
  lines.push('');
  return lines.join('\n');
}

const checkOnly = process.argv.includes('--check');
const problems = [];
const rows = [];
let changed = 0;

for (const item of MANIFEST) {
  const version = installedVersion(item.pkg);
  if (!version) {
    problems.push(`依赖 ${item.pkg} 未安装（先跑 npm install）`);
    continue;
  }
  const src = path.join(ROOT, 'node_modules', item.pkg, item.from);
  if (!fs.existsSync(src)) {
    // 包升级后构建产物改名/挪位会走到这里。静默跳过等于埋雷，必须报错。
    problems.push(`${item.pkg}@${version} 里找不到 ${item.from}（构建产物可能已改名，需更新 MANIFEST）`);
    continue;
  }
  const buf = fs.readFileSync(src);
  if (!buf.length) {
    problems.push(`${item.pkg} 的 ${item.from} 是空文件`);
    continue;
  }

  const dest = path.join(VENDOR_DIR, item.to);
  const same = fs.existsSync(dest) && fs.readFileSync(dest).equals(buf);
  rows.push({ ...item, version });

  if (same) continue;
  changed++;
  if (checkOnly) {
    problems.push(`${item.to} 与 ${item.pkg}@${version} 不一致（需跑 npm run sync:vendor）`);
  } else {
    fs.mkdirSync(VENDOR_DIR, { recursive: true });
    fs.writeFileSync(dest, buf);
    console.log(`✔ ${item.to}  ←  ${item.pkg}@${version}/${item.from}  (${buf.length} B)`);
  }
}

// 孤儿文件检测：vendor 根目录（不含 tauri/ 子目录，那些是 Tauri 官方 API 脚本，另行维护）
if (fs.existsSync(VENDOR_DIR)) {
  for (const name of fs.readdirSync(VENDOR_DIR)) {
    const full = path.join(VENDOR_DIR, name);
    if (fs.statSync(full).isDirectory()) continue;
    if (!ALLOWED.has(name)) {
      problems.push(`vendor 里有未登记的文件 ${name}（历史副本？确认后删除，否则会被误当成现役依赖）`);
    }
  }
}

// 版本清单：只在真正同步时写，--check 模式不产生副作用
if (!checkOnly && rows.length === MANIFEST.length) {
  const target = path.join(VENDOR_DIR, 'VERSIONS.md');
  const text = renderVersions(rows);
  if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== text) {
    fs.writeFileSync(target, text);
    console.log('✔ VERSIONS.md 已更新');
  }
}

if (problems.length) {
  console.error('');
  console.error(checkOnly ? '✗ vendor 校验未通过：' : '✗ vendor 同步存在问题：');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

console.log(
  checkOnly
    ? `✓ vendor 与 package.json 一致（${MANIFEST.length} 个文件）`
    : changed
      ? `✓ 同步完成，${changed} 个文件已更新`
      : `✓ vendor 已是最新（${MANIFEST.length} 个文件无变化）`,
);
