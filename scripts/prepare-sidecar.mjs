#!/usr/bin/env node
/**
 * 构建期：把 Node 运行时与后端代码 stage 到 src-tauri/，供 Tauri sidecar + resources 打包。
 * 用法：
 *   node scripts/prepare-sidecar.mjs             # 完整：node 二进制 + 后端 staging + 生产依赖
 *   node scripts/prepare-sidecar.mjs --node-only  # 仅拷贝 node 二进制（tauri dev 前置，快）
 * 环境变量：
 *   SIDECAR_TARGET_TRIPLE  目标三元组，默认 x86_64-pc-windows-msvc
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SRC_TAURI = path.join(ROOT, 'src-tauri');
const TRIPLE = process.env.SIDECAR_TARGET_TRIPLE || 'x86_64-pc-windows-msvc';
const NODE_ONLY = process.argv.includes('--node-only');

// process.execPath 拷贝的永远是宿主机 node；跨架构构建会产出"名对实错"的二进制，故加护栏。
const hostArch =
  process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch;
const hostOs =
  process.platform === 'win32'
    ? 'pc-windows-msvc'
    : process.platform === 'darwin'
      ? 'apple-darwin'
      : 'unknown-linux-gnu';
const hostTriple = `${hostArch}-${hostOs}`;
if (TRIPLE !== hostTriple) {
  throw new Error(
    `[prepare-sidecar] 目标 triple (${TRIPLE}) 与宿主 (${hostTriple}) 不一致：` +
      `本脚本拷贝宿主机 node，无法为异构目标产出正确二进制。请在目标平台上构建。`,
  );
}

// 1. Node 二进制 → src-tauri/binaries/node-<triple>[.exe]
const binDir = path.join(SRC_TAURI, 'binaries');
fs.mkdirSync(binDir, { recursive: true });
const ext = TRIPLE.includes('windows') ? '.exe' : '';
const nodeTarget = path.join(binDir, `node-${TRIPLE}${ext}`);
fs.copyFileSync(process.execPath, nodeTarget);
console.log(`[prepare-sidecar] node -> ${nodeTarget}`);
console.log(`[prepare-sidecar]   source=${process.execPath} version=${process.version}`);

if (NODE_ONLY) {
  console.log('[prepare-sidecar] --node-only done.');
  process.exit(0);
}

// 2. 后端代码 staging → src-tauri/resources/sidecar/
//    （tauri.conf 用 {"resources/": ""} 将 src-tauri/resources/** 保结构落到 $RESOURCE/**，
//      即 $RESOURCE/sidecar/**；Rust 侧以 "sidecar/server.js" 解析。）
const RES = path.join(SRC_TAURI, 'resources');
const stage = path.join(RES, 'sidecar');
fs.rmSync(RES, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

// 'data' 必须在列：data/event-dict.json 是埋点统计的埋点索引，缺了它 loadDict() 恒返回 null，
// 埋点统计在打包版里静默失效——而开发机上一切正常（开发直接读仓库根目录）。
// 这类「只在打包后才复现、且不报错只降级」的缺陷排查成本极高，故随代码一起 stage。
for (const item of ['server.js', 'package.json', 'package-lock.json', 'src', 'public', 'data']) {
  const from = path.join(ROOT, item);
  if (!fs.existsSync(from)) {
    throw new Error(`[prepare-sidecar] 缺少必需项，无法产出完整 sidecar: ${item}`);
  }
  fs.cpSync(from, path.join(stage, item), { recursive: true });
}

// 剥离随 src 带入的测试文件（*.test.js / *.test.mjs / *.test.cjs），减小包体
function stripTests(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) stripTests(p);
    else if (/\.test\.[cm]?js$/.test(e.name)) fs.rmSync(p);
  }
}
stripTests(path.join(stage, 'src'));

console.log('[prepare-sidecar] backend files staged.');

// 3. 生产依赖 → src-tauri/resources/sidecar/node_modules
console.log('[prepare-sidecar] installing production deps (npm ci --omit=dev)...');
execSync('npm ci --omit=dev', { cwd: stage, stdio: 'inherit' });

console.log('[prepare-sidecar] done.');
