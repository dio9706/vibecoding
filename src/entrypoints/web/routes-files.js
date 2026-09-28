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

/** Markdown 读取白名单：只放行这两个扩展名，避免 /api/fs/read 变成通用任意文件读取 */
const READ_EXTS = new Set(['.md', '.markdown']);
const READ_MAX = 10 * 1024 * 1024; // 10MB

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

/**
 * 纯函数：批量判断路径类型。
 *
 * 设计为批量而非单条——一次拖拽可能带入数十个文件，逐个 HTTP 请求过于碎片化。
 * 任何异常都归为 'missing' 而不上抛：一个脏路径不该让整批拖拽失败。
 *
 * @param {unknown[]} paths
 * @returns {{path:string, kind:'file'|'dir'|'missing', size?:number, mtime?:number}[]}
 */
export function statPaths(paths) {
  return (Array.isArray(paths) ? paths : []).map((raw) => {
    const p = str(raw);
    if (!p) return { path: '', kind: 'missing' };
    try {
      const st = fs.statSync(p); // 跟随符号链接：指向普通文件的软链应视为文件
      if (st.isDirectory()) return { path: p, kind: 'dir' };
      if (st.isFile()) return { path: p, kind: 'file', size: st.size, mtime: st.mtimeMs };
      return { path: p, kind: 'missing' }; // 管道 / 设备等特殊文件按不存在处理
    } catch {
      return { path: p, kind: 'missing' };
    }
  });
}

/**
 * 纯函数：校验 /api/fs/read 的 path 参数。
 * @returns {{ok:true, path:string}|{ok:false, error:string}}
 */
export function validateReadPath(raw) {
  const p = str(raw);
  if (!p) return { ok: false, error: '缺少 path 参数' };
  if (!path.isAbsolute(p)) return { ok: false, error: '仅支持绝对路径' };
  if (!READ_EXTS.has(path.extname(p).toLowerCase())) {
    return { ok: false, error: '仅支持 .md / .markdown 文件' };
  }
  return { ok: true, path: p };
}

/** POST /api/fs/stat —— body { paths: string[] }，批量返回类型。上限 200 条防滥用。 */
export function handleFsStat(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  return withJsonBody(req, res, (data) => {
    const paths = Array.isArray(data?.paths) ? data.paths.slice(0, 200) : [];
    sendJson(res, 200, { results: statPaths(paths) });
  });
}

/**
 * GET /api/fs/read?path= —— 读 Markdown 内容。
 *
 * 安全边界：扩展名白名单 + 必须是普通文件 + 10MB 上限。大小在读之前用 stat 拦，
 * 不能先 readFileSync 再判——那样 1GB 文件已经进了内存。
 */
export function handleFsRead(url, res) {
  const v = validateReadPath(url.searchParams.get('path'));
  if (!v.ok) return sendJson(res, 400, { error: v.error });
  let st;
  try {
    st = fs.statSync(v.path);
  } catch {
    return sendJson(res, 404, { error: '文件不存在：' + v.path });
  }
  if (!st.isFile()) return sendJson(res, 400, { error: '不是普通文件' });
  if (st.size > READ_MAX) return sendJson(res, 413, { error: '文件过大（>10MB）' });
  try {
    sendJson(res, 200, {
      content: fs.readFileSync(v.path, 'utf8'),
      size: st.size,
      mtime: st.mtimeMs,
    });
  } catch (e) {
    sendJson(res, 500, { error: '读取失败：' + (e?.message || e) });
  }
}

/**
 * 纯函数：校验 /api/fs/download 的 path 参数。
 *
 * 安全边界与 `/api/fs/read` **刻意不同**：那条靠扩展名白名单（.md/.markdown）放行任意绝对路径，
 * 放出去的是纯文本；下载必须放开扩展名（附件可能是 json/yaml/pdf/图片），此时再不限目录，
 * 这个端点就成了任意文件读取口 —— 拿 `?path=C:\Users\x\.ssh\id_rsa` 就能把私钥下走。
 *
 * 所以改用**目录白名单**：只放行 `.uploads/` 树内的文件。这刚好覆盖全部「附件」来源 ——
 * 同事消息附件在 `.uploads/feishu/`、API 文档在 `.uploads/apidocs/`、web 拖入的在顶层。
 * 用 `path.relative` 判归属而不是 `startsWith`：后者在 Windows 上对盘符大小写敏感
 *（`C:\` 与 `c:\` 会判成不同根），而 win32 的 relative 本身是大小写不敏感的。
 * 判据里的 `..` 前缀同时挡掉了 `%2e%2e` 一类穿越 —— resolve 之后才比较，穿越已被折叠掉。
 *
 * @returns {{ok:true, path:string}|{ok:false, error:string}}
 */
export function validateDownloadPath(raw) {
  const p = str(raw);
  if (!p) return { ok: false, error: '缺少 path 参数' };
  if (!path.isAbsolute(p)) return { ok: false, error: '仅支持绝对路径' };
  const resolved = path.resolve(p);
  const rel = path.relative(path.resolve(UPLOADS_DIR), resolved);
  // 空串 = 就是目录本身；`..` 开头或绝对路径 = 在白名单根之外
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, error: '只能下载应用附件目录内的文件' };
  }
  return { ok: true, path: resolved };
}

/**
 * 构造 Content-Disposition。
 *
 * 两份文件名缺一不可：`filename=` 只能是 ASCII（中文名到这里会变成乱码或被整个丢弃），
 * `filename*=` 才是 RFC 5987 的 UTF-8 形式、现代浏览器优先认它。只给后者的话，
 * 老浏览器会退化成用 URL 末段当文件名（下出来是个没扩展名的 `download`）。
 *
 * 控制字符与引号必须剥掉：它们能提前闭合 header 值，是 header 注入的经典入口。
 */
export function buildContentDisposition(name) {
  const clean = String(name || 'download').replace(/[\r\n"\\]/g, '').replace(/[\u0000-\u001f\u007f]/g, '') || 'download';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_'); // 非 ASCII 一律占位，保住扩展名的位置
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

/**
 * GET /api/fs/download?path=&name= —— 下载附件（原样回文件字节，浏览器另存为）。
 *
 * `name` 可选，用于让下载下来的文件叫「登记名」而不是盘上带随机前缀的副本名
 *（API 文档在盘上是 `muc9i5asi7q-api.md`，用户要的是 `api.md`）。
 * 走流而不是 readFileSync：附件没有 10MB 上限那样的约束，整份读进内存没有必要。
 */
export function handleFsDownload(url, res) {
  const v = validateDownloadPath(url.searchParams.get('path'));
  if (!v.ok) return sendJson(res, 400, { error: v.error });
  let st;
  try {
    st = fs.statSync(v.path);
  } catch {
    return sendJson(res, 404, { error: '文件不存在：' + v.path });
  }
  if (!st.isFile()) return sendJson(res, 400, { error: '不是普通文件' });
  const name = str(url.searchParams.get('name')) || path.basename(v.path);
  res.writeHead(200, {
    // 一律 octet-stream：附件是给用户存盘的，不该让浏览器按类型内联渲染（html 附件会当页面跑起来）
    'Content-Type': 'application/octet-stream',
    'Content-Length': st.size,
    'Content-Disposition': buildContentDisposition(name),
  });
  const stream = fs.createReadStream(v.path);
  // 流中途出错时 header 已发出，改不了状态码，只能断开——继续挂着会让浏览器一直转圈
  stream.on('error', () => res.destroy());
  stream.pipe(res);
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
        const st = fs.statSync(fp);
        // 子目录一律跳过：feishu/（收信原件）与 apidocs/（API 文档档案，见 requirement-ops.js）
        // 都靠「只扫顶层」长期存活。此前这层保护纯属巧合——unlinkSync 删目录必然抛错被下面的
        // catch 吞掉。显式写出来，免得哪天有人图省事换成 rmSync 就把两份档案一起清了。
        if (st.isDirectory()) continue;
        if (st.mtimeMs < cutoff) fs.unlinkSync(fp);
      } catch {
        /* 单个文件失败忽略 */
      }
    }
  } catch {
    /* 目录不存在等忽略 */
  }
}
