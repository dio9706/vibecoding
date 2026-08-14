/** web 入口：上传 / 目录浏览 / 系统选目录 / 常用目录 / 静态托管路由 handler */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { getSavedDirs, addSavedDir, removeSavedDir } from '../../store/saved-dirs.js';
import { sendJson } from './http-util.js';
import { withJsonBody } from './body.js';
import { str } from './input.js';
import { config } from '../../shared/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', '..', '..', 'public'); // 项目根 public/
// 上传目录：打包后写入 APP_DATA_DIR（用户可写），开发态写项目根；避免 C:\Program Files EPERM
const UPLOADS_DIR = process.env.APP_DATA_DIR
  ? path.join(process.env.APP_DATA_DIR, '.uploads')
  : path.join(PUBLIC_DIR, '..', '.uploads');

const SCRIPT_EXTS = { '.py': 'python', '.js': 'node' };
const SCRIPT_MAX = 1 * 1024 * 1024; // 脚本 1MB 上限

/**
 * 纯函数：校验/清洗上传脚本名。basename 防穿越 + 字符清洗；扩展名须 ∈ {.py,.js}。
 * @returns {{ok:true,scriptName:string,scriptType:string}|{ok:false,error:string}}
 */
export function validateScriptName(rawName) {
  const base = path.basename(String(rawName || '')).trim();
  const cleaned = base.replace(/[^\w.\-一-龥]/g, '_');
  const rawExt = path.extname(cleaned);
  const ext = rawExt.toLowerCase();
  const scriptType = SCRIPT_EXTS[ext];
  if (!scriptType) return { ok: false, error: '仅支持 .py / .js 脚本' };
  // 扩展名统一小写：下游 script-runner 的 endsWith('.py') 与 listScriptFiles 正则均大小写敏感
  const scriptName = cleaned.slice(0, cleaned.length - rawExt.length) + ext;
  return { ok: true, scriptName, scriptType };
}

/** 上传拖入的文件副本到 .uploads/，返回绝对路径（浏览器拿不到原始路径，故存副本供 Claude 读取） */
export function handleUpload(req, res, url) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  const rawName = (url.searchParams.get('name') || 'file').trim();
  const chunks = [];
  let size = 0;
  let aborted = false;
  const MAX = 50 * 1024 * 1024; // 50MB 上限
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX && !aborted) {
      aborted = true;
      sendJson(res, 413, { error: '文件过大（>50MB）' });
      req.destroy();
      return;
    }
    if (!aborted) chunks.push(c);
  });
  req.on('end', () => {
    if (aborted) return;
    try {
      const safe = path.basename(rawName).replace(/[^\w.\-一-龥]/g, '_') || 'file';
      const dir = UPLOADS_DIR;
      fs.mkdirSync(dir, { recursive: true });
      const unique =
        Date.now().toString(36) + Math.random().toString(36).slice(2, 5) + '-' + safe;
      const full = path.join(dir, unique);
      fs.writeFileSync(full, Buffer.concat(chunks));
      sendJson(res, 200, { path: full, name: safe });
    } catch (e) {
      sendJson(res, 500, { error: '保存失败：' + (e?.message || e) });
    }
  });
}

/**
 * POST /api/scripts/upload?name=<原文件名> —— 上传动作脚本到 config.scripts.dir（同名覆盖）。
 * 请求体为文件二进制；校验扩展名(.py/.js)与大小(≤1MB)；返回 { scriptName, scriptType }。
 */
export function handleScriptUpload(req, res, url) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  const v = validateScriptName(url.searchParams.get('name') || '');
  if (!v.ok) return sendJson(res, 400, { error: v.error });

  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > SCRIPT_MAX && !aborted) {
      aborted = true;
      sendJson(res, 413, { error: '脚本过大（>1MB）' });
      req.destroy();
      return;
    }
    if (!aborted) chunks.push(c);
  });
  req.on('end', () => {
    if (aborted) return;
    const buf = Buffer.concat(chunks);
    if (!buf.length) return sendJson(res, 400, { error: '脚本内容为空' });
    try {
      const dir = config.scripts.dir;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, v.scriptName), buf);
      sendJson(res, 200, { scriptName: v.scriptName, scriptType: v.scriptType });
    } catch (e) {
      sendJson(res, 500, { error: '保存失败：' + (e?.message || e) });
    }
  });
}

/** 目录浏览：列出某路径下的子目录 */
export function handleBrowse(url, res) {
  const p = (url.searchParams.get('path') || '').trim();
  const target = p || os.homedir();
  try {
    const entries = fs.readdirSync(target, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    const parent = path.dirname(target);
    sendJson(res, 200, { current: target, parent: parent !== target ? parent : null, dirs });
  } catch (err) {
    sendJson(res, 400, { error: `无法读取目录：${err.message}` });
  }
}

/** 系统原生文件夹选择框（Windows：PowerShell FolderBrowserDialog） */
export function handlePickDir(res) {
  if (process.platform !== 'win32') {
    return sendJson(res, 501, { error: '系统对话框仅支持 Windows，请用下方浏览方式选择' });
  }
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$dlg.Description = '选择 Claude 工作目录'",
    '$dlg.ShowNewFolderButton = $true',
    '$top = New-Object System.Windows.Forms.Form',
    '$top.TopMost = $true; $top.ShowInTaskbar = $false',
    'if ($dlg.ShowDialog($top) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dlg.SelectedPath) }',
    '$top.Dispose()',
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded],
    { windowsHide: true, timeout: 180000 },
    (err, stdout) => {
      if (err) return sendJson(res, 500, { error: `无法调用系统对话框：${err.message}` });
      const picked = (stdout || '').trim();
      sendJson(res, 200, { path: picked || null });
    },
  );
}

/** 常用目录（store） */
export function handleSaved(req, res) {
  if (req.method === 'GET') return sendJson(res, 200, { dirs: getSavedDirs() });
  if (req.method === 'POST') {
    return withJsonBody(
      req,
      res,
      (data) => {
        // path 未归一时，传对象/数组会被原样写进 saved-dirs 存储（落盘即污染 JSON）
        const p = str(data.path);
        if (!p) return sendJson(res, 400, { error: 'path 不能为空' });
        let dirs = getSavedDirs();
        if (data.action === 'add') dirs = addSavedDir(p);
        else if (data.action === 'remove') dirs = removeSavedDir(p);
        sendJson(res, 200, { dirs });
      },
      { maxBytes: 64 * 1024 },
    );
  }
  sendJson(res, 405, { error: 'method not allowed' });
}

/** 静态文件托管（仅 public/ 内，防目录穿越） */
export function serveStatic(pathname, res) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not Found');
    }
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
    };
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

/** 清理 .uploads 中的旧副本（>7 天，覆盖最长额度窗口，避免误删待续跑引用的文件） */
export function pruneUploads() {
  try {
    const dir = UPLOADS_DIR;
    if (!fs.existsSync(dir)) return;
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      try {
        if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
      } catch {
        /* 单个文件失败忽略 */
      }
    }
  } catch {
    /* 目录不存在等忽略 */
  }
}
