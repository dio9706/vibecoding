import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

/**
 * 用户消息气泡里的路径识别。
 *
 * 背景：初版正则是 `/\/[^\s\n]{2,}/g`，任何斜杠后面跟两个非空白字符都算「Unix 绝对路径」。
 * 中文里斜杠几乎都是「或」的意思——「是否有宠物/宝宝是2个不同的判断」整句被吞成路径，
 * 再因为不含 `.` 被判成目录，于是正常聊天内容里凭空长出 📁 chip。
 *
 * 更糟的是这道防线是唯一的：设计里说好的存在性校验走
 * `invoke('plugin:shell|path_exists')`，而这个命令在 src-tauri 里压根不存在，
 * 必然抛错走 catch 降级，所以正则匹配到什么就渲染什么，没有第二道闸。
 *
 * 结论：只认绝对路径，且宁可漏认不可错认——普通文本被改造成 chip 的代价，
 * 远高于少渲染一个路径。
 *
 * 注：这里不 import chat.js，而是从源码里抽出路径检测段来跑。chat.js 的模块顶层
 * 会立刻查询 DOM 元素、注册监听、拉取会话，在测试里 import 等于启动半个应用。
 */

let dom;
let renderPathsInText;

before(async () => {
  // 段内 classifyPath 调用的 isMarkdownPath 现住在 util.js（需求右栏也要用同一判据），
  // 抽出来的源码片段拿不到 import 绑定，只能作为形参注入
  const { isMarkdownPath } = await import('./util.js');
  const src = fs.readFileSync('public/js/chat.js', 'utf8');
  const start = src.indexOf('const PATH_SEP_HEAD');
  const tail = src.indexOf('* 显示图片灯箱');
  assert.ok(start > 0 && tail > start, 'chat.js 里的路径检测段没找到，源码结构可能变了');
  const segment = src.slice(start, src.lastIndexOf('/**', tail));

  dom = new JSDOM('<!doctype html><html><body></body></html>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.toast = () => {};
  globalThis.showLightbox = () => {};
  // 用 window.Function 编译，段内创建的节点才属于这个 jsdom 文档
  renderPathsInText = new dom.window.Function(
    'isMarkdownPath',
    `${segment}; return { renderPathsInText };`
  ).call(dom.window, isMarkdownPath).renderPathsInText;
});

after(() => {
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.toast;
  delete globalThis.showLightbox;
  dom?.window?.close();
});

/** 渲染后压成可读串：文本原样，chip 记为 [图标:路径] */
async function render(text) {
  const el = dom.window.document.createElement('div');
  await renderPathsInText(text, el);
  return [...el.childNodes]
    .map((n) => {
      if (n.nodeType === 3) return n.textContent;
      if (n.classList?.contains('path-chip')) {
        return `[${n.querySelector('.path-icon').textContent}:${n.dataset.path}]`;
      }
      if (n.tagName === 'IMG') return `[IMG:${n.dataset.path}]`;
      return `<${n.className}:${n.textContent}>`;
    })
    .join('');
}

/** 断言整段原样输出，一个 chip 都没有 */
async function assertPlain(text) {
  const el = dom.window.document.createElement('div');
  await renderPathsInText(text, el);
  assert.equal(el.querySelectorAll('.path-chip, img').length, 0,
    `不该识别出路径：${text} → ${await render(text)}`);
  assert.equal(el.textContent, text, '文本内容被改动了');
}

// ── 不该识别的：中文语境里的斜杠 ──────────────────────────────

test('中文里的「或」斜杠不是路径（线上误判的原始案例）', async () => {
  await assertPlain('是否有宠物/宝宝是2个不同的判断，');
  await assertPlain('是否有宠物/宝宝指的是前置信息收集环节中');
});

test('数字比例、英文 and/or 都不是路径', async () => {
  await assertPlain('读写比 3/7，QPS 约 1/2');
  await assertPlain('他说 and/or 都行');
});

// ── 不该识别的：相对路径 ────────────────────────────────────

test('相对路径一律不识别（无锚点，跟正常文本无法区分）', async () => {
  await assertPlain('src/main.js 改一下');
  await assertPlain('./scripts/build.sh 跑一下');
  await assertPlain('见 docs/spec.md');
  await assertPlain('a/b');
});

test('单级绝对路径不识别（/tmp 这种太容易跟句中斜杠撞车）', async () => {
  await assertPlain('/tmp');
});

// ── 该识别的 ────────────────────────────────────────────────

test('Windows 盘符路径（反斜杠与正斜杠）', async () => {
  assert.equal(await render('C:\\Users\\DELL\\file.txt'), '[📄:C:\\Users\\DELL\\file.txt]');
  assert.equal(await render('C:/Users/DELL/file.txt'), '[📄:C:/Users/DELL/file.txt]');
  assert.equal(await render('看下 C:\\a\\b.png 这张图'), '看下 [📄:C:\\a\\b.png] 这张图');
});

test('Unix 绝对路径与 UNC 路径', async () => {
  assert.equal(await render('/home/user/file.txt'), '[📄:/home/user/file.txt]');
  assert.equal(await render('\\\\server\\share\\f.txt'), '[📄:\\\\server\\share\\f.txt]');
});

test('同行多个路径都渲染', async () => {
  assert.equal(await render('C:\\a\\b.txt 和 D:\\c\\d.txt'),
    '[📄:C:\\a\\b.txt] 和 [📄:D:\\c\\d.txt]');
});

test('同一路径重复出现要各渲染各的（旧版按路径去重会吞掉第二个）', async () => {
  assert.equal(await render('C:\\a\\b.txt 又是 C:\\a\\b.txt'),
    '[📄:C:\\a\\b.txt] 又是 [📄:C:\\a\\b.txt]');
});

test('正斜杠 Windows 路径不被 Unix 规则重复命中（旧版会渲染两遍）', async () => {
  const el = dom.window.document.createElement('div');
  await renderPathsInText('C:/Users/DELL/file.txt', el);
  assert.equal(el.querySelectorAll('.path-chip').length, 1);
});

// ── 边界：尾部标点 ──────────────────────────────────────────

test('尾部粘连的标点剥回文本，不算进路径', async () => {
  assert.equal(await render('文件在 C:\\a\\b.txt。'), '文件在 [📄:C:\\a\\b.txt]。');
  assert.equal(await render('文件在 C:\\a\\b.txt，然后呢'), '文件在 [📄:C:\\a\\b.txt]，然后呢');
  assert.equal(await render('(见 C:\\a\\b.txt)'), '(见 [📄:C:\\a\\b.txt])');
  assert.equal(await render('See /home/user/a.txt.'), 'See [📄:/home/user/a.txt].');
});

test('Windows 路径允许中文文件名，但中文标点即截断', async () => {
  assert.equal(await render('路径是 C:\\Users\\DELL\\项目\\说明.md，看下'),
    '路径是 [📝:C:\\Users\\DELL\\项目\\说明.md]，看下'); // 📝 = markdown 分类，本例只验证截断边界
});

test('带空格的路径只认到第一段——刻意的保守取舍，不是漏洞', async () => {
  // C:\Program 末段没有扩展名，按目录渲染
  assert.equal(await render('C:\\Program Files\\app.exe'), '[📁:C:\\Program] Files\\app.exe');
});

test('扩展名后直接粘中文也要截断（中文输入里不打空格是常态）', async () => {
  assert.equal(await render('C:\\a\\b.png然后呢'), '[📄:C:\\a\\b.png]然后呢');
  assert.equal(await render('看下 C:\\a\\b.png这张图'), '看下 [📄:C:\\a\\b.png]这张图');
});

test('中文目录名/中文文件名本身不受扩展名截断影响', async () => {
  // 本例只关心路径边界不被中文吃掉；.md 归 markdown 分类故图标是 📝（chip 点击进查看器）
  assert.equal(await render('C:\\项目\\说明.md'), '[📝:C:\\项目\\说明.md]');
  assert.equal(await render('C:\\a\\项目文档\\b.png'), '[📄:C:\\a\\项目文档\\b.png]');
  // 目录路径没有扩展名，末尾中文段要完整保留（并被判成目录）
  assert.equal(await render('C:\\v1.2\\说明书'), '[📁:C:\\v1.2\\说明书]');
});

// ── 类型判断：改用扩展名，不再依赖不存在的 Tauri 命令 ──────────

test('末段有扩展名判文件，没有判目录', async () => {
  assert.equal(await render('C:\\a\\b.txt'), '[📄:C:\\a\\b.txt]');
  assert.equal(await render('C:\\Users\\DELL\\Desktop'), '[📁:C:\\Users\\DELL\\Desktop]');
  assert.equal(await render('/home/user/project'), '[📁:/home/user/project]');
});

test('点开头的隐藏目录不能当成文件（.uploads 的扩展名是假象）', async () => {
  assert.equal(await render('C:\\Users\\DELL\\.uploads'), '[📁:C:\\Users\\DELL\\.uploads]');
  assert.equal(await render('/home/user/.config'), '[📁:/home/user/.config]');
});

test('浏览器里没有 convertFileSrc，图片退回 chip 而不是挂破图', async () => {
  // jsdom 里 window.__TAURI__ 不存在，等价于纯 Web 模式
  const el = dom.window.document.createElement('div');
  await renderPathsInText('C:\\a\\b.png', el);
  assert.equal(el.querySelectorAll('img').length, 0, '不该渲染 img');
  assert.equal(el.querySelectorAll('.path-chip').length, 1);
});

test('Tauri 环境下图片渲染成缩略图，src 走 core.convertFileSrc', async () => {
  dom.window.__TAURI__ = { core: { convertFileSrc: (p) => `asset://localhost/${encodeURIComponent(p)}` } };
  try {
    const el = dom.window.document.createElement('div');
    await renderPathsInText('C:\\a\\b.png', el);
    const img = el.querySelector('img.path-img');
    assert.ok(img, '应该渲染缩略图');
    assert.match(img.src, /^asset:\/\/localhost\//);
    assert.equal(img.dataset.path, 'C:\\a\\b.png');
    // 非图片仍然是 chip
    const el2 = dom.window.document.createElement('div');
    await renderPathsInText('C:\\a\\b.txt', el2);
    assert.equal(el2.querySelectorAll('img').length, 0);
  } finally {
    delete dom.window.__TAURI__;
  }
});

test('图片加载失败时原地降级成 chip（没有 path_exists，onerror 是唯一存在性信号）', async () => {
  dom.window.__TAURI__ = { core: { convertFileSrc: (p) => `asset://localhost/${p}` } };
  try {
    const el = dom.window.document.createElement('div');
    await renderPathsInText('C:\\a\\missing.png', el);
    const img = el.querySelector('img.path-img');
    assert.ok(img);
    img.onerror();  // 模拟加载失败
    assert.equal(el.querySelectorAll('img').length, 0, 'img 应被替换掉');
    const chip = el.querySelector('.path-chip');
    assert.ok(chip, '应降级为 chip');
    assert.equal(chip.dataset.path, 'C:\\a\\missing.png');
  } finally {
    delete dom.window.__TAURI__;
  }
});

test('上传图片的完整路径后接中文说明（线上原始案例）', async () => {
  const p = 'C:\\Users\\DELL\\AppData\\Roaming\\com.principal.desktop\\.uploads\\a-screenshot-20260814.png';
  assert.equal(await render(`${p}   路径的判断有问题, 仅判断绝对路径吧`),
    `[📄:${p}]   路径的判断有问题, 仅判断绝对路径吧`);
});
