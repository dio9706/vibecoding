/**
 * 分支选择器的显隐与陈旧态回归测试。
 *
 * 背景（2026-09-21）：用户反馈两个症状——
 *   ①「右侧的选择分支功能有时会消失」：老实现在 chat.js 模块顶层就 queueMicrotask 探测，
 *     跑在 whenBackendReady() 闸门之前。桌面版页面秒开而 Node 后端要冷启动数秒，
 *     这一探必然失败，而 catch 分支是无条件 `btn.hidden = true` 且**没有任何重试**，
 *     于是按钮一整个会话都不再出现。
 *   ②「有时候获取到的分支不对，重新打开项目就正常」：_currentBranch 是模块级状态，
 *     切项目（openConv 改 cwd）时没人重扫，标签就停在上一个项目的分支上；
 *     「重开项目」是开新窗口、模块状态全新，所以看着像自愈。
 *
 * 因此本测试锁三件事：探测失败要重试而不是永久隐藏；后端明确说「非 git」才隐藏；
 * 重扫期间绝不留着上一个项目的分支名。
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

let dom;
let doc;
let bindGitSelector;
let reinitializeGitSelector;

/** 当前的 /api/git/status 应答器，每个用例自己换 */
let statusResponder = async () => ({ isGit: false });
let statusCalls = 0;
let cwd = 'C:/proj/alpha';

const btn = () => doc.querySelector('#gitBtn');
const label = () => doc.querySelector('#gitLabel');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  const html = fs.readFileSync('public/index.html', 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  dom = new JSDOM(html, { url: 'http://localhost/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.CustomEvent = dom.window.CustomEvent;
  globalThis.getComputedStyle = dom.window.getComputedStyle;
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  // 必须用 jsdom 自己的 AbortController：attachListeners 把 signal 传给 addEventListener，
  // 而 jsdom 只认自家的 AbortSignal，拿 Node 全局那个会被 IDL 校验挡下来。
  globalThis.AbortController = dom.window.AbortController;
  doc = dom.window.document;

  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/git/status')) {
      statusCalls += 1;
      const body = await statusResponder(String(url));
      if (body instanceof Error) throw body;
      const status = body.__status || 200;
      return { ok: status < 400, status, json: async () => body };
    }
    if (String(url).includes('/api/git/branches')) {
      return { ok: true, status: 200, json: async () => ({ local: ['main', 'v1.0.0'], remote: [], current: 'v1.0.0' }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  ({ bindGitSelector, reinitializeGitSelector } = await import('./git-selector.js'));
  bindGitSelector({ getCwd: () => cwd });
});

after(() => dom?.window?.close());

beforeEach(() => {
  statusCalls = 0;
  cwd = 'C:/proj/alpha';
});

test('bindGitSelector 只注入不探测：首探必须由调用方在后端就绪后发起', async () => {
  const before = statusCalls;
  bindGitSelector({ getCwd: () => cwd });
  await sleep(30); // 给微任务/宏任务留足窗口——老实现在这里已经打过一次请求了
  assert.equal(statusCalls, before, '注入阶段不得访问后端，否则必然踩桌面版后端冷启动');
});

test('探测请求失败：退避重试而非永久隐藏（症状①的直接回归）', async () => {
  let attempt = 0;
  statusResponder = async () => {
    attempt += 1;
    // 前两次模拟后端尚未就绪（fetch 直接抛），第三次成功
    if (attempt <= 2) return new Error('Failed to fetch');
    return { isGit: true, currentBranch: 'v1.0.0' };
  };

  reinitializeGitSelector();
  await sleep(50);
  assert.equal(btn().hidden, true, '首探失败时先藏着，但不是终局');

  // 重试节奏是 1s / 3s / 6s，等过第二拍
  await sleep(4200);
  assert.ok(attempt >= 3, `应当重试，实际只探测了 ${attempt} 次`);
  assert.equal(btn().hidden, false, '后端起来后按钮必须自己回来——老实现永远不会');
  assert.equal(label().textContent, 'v1.0.0');
});

test('后端明确答复非 git 仓库：直接隐藏且不重试（这是确定结论）', async () => {
  statusResponder = async () => ({ isGit: false });
  reinitializeGitSelector();
  await sleep(50);
  const callsAfterFirst = statusCalls;
  assert.equal(btn().hidden, true);
  await sleep(1500); // 跨过第一拍重试间隔
  assert.equal(statusCalls, callsAfterFirst, '确定结论不该触发重试，白烧请求');
});

test('切项目：重扫期间不得留着上一个项目的分支（症状②的直接回归）', async () => {
  statusResponder = async () => ({ isGit: true, currentBranch: 'v1.0.0' });
  reinitializeGitSelector();
  await sleep(50);
  assert.equal(label().textContent, 'v1.0.0');

  // 切到另一个项目，后端这次慢半拍
  cwd = 'C:/proj/beta';
  statusResponder = async () => {
    await sleep(80);
    return { isGit: true, currentBranch: 'main' };
  };
  reinitializeGitSelector();
  assert.equal(btn().hidden, true, '重扫一开始就要把按钮藏起来，否则显示的是上一个项目的分支');

  await sleep(200);
  assert.equal(label().textContent, 'main');
  assert.equal(btn().hidden, false);
});

test('过期响应被丢弃：慢的旧项目响应不得覆盖新项目的分支', async () => {
  // 旧项目响应慢（150ms），新项目响应快（10ms）——若无世代号，旧的后到会把标签改回 old-branch
  statusResponder = async () => {
    await sleep(150);
    return { isGit: true, currentBranch: 'old-branch' };
  };
  reinitializeGitSelector();

  await sleep(20);
  cwd = 'C:/proj/gamma';
  statusResponder = async () => {
    await sleep(10);
    return { isGit: true, currentBranch: 'new-branch' };
  };
  reinitializeGitSelector();

  await sleep(300); // 等旧项目那条响应也落地
  assert.equal(label().textContent, 'new-branch', '旧世代的迟到响应必须被丢弃');
});

test('cwd 为空：直接隐藏，不打后端', async () => {
  cwd = '';
  const before = statusCalls;
  reinitializeGitSelector();
  await sleep(50);
  assert.equal(btn().hidden, true);
  assert.equal(statusCalls, before, '没有工作目录时无从探测，不该发请求');
});

test('打开浮层：节点必须被挪到 body 下，逃出 .topbar 的层叠上下文', async () => {
  statusResponder = async () => ({ isGit: true, currentBranch: 'v1.0.0' });
  reinitializeGitSelector();
  await sleep(50);

  const dropdown = doc.querySelector('#gitDropdown');
  assert.ok(
    dropdown.closest('.topbar'),
    '前置：静态 HTML 里浮层确实在 topbar 内（这正是要逃离的地方）',
  );

  btn().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await sleep(80);

  assert.equal(dropdown.hidden, false, '点击后浮层应打开');
  assert.equal(
    dropdown.parentElement,
    doc.body,
    '.topbar 有 backdrop-filter（层叠上下文 + fixed 包含块），留在里面时 z-index 再大也会被 ' +
      'topbar 外 z-index>0 的定位元素盖住——必须挪到 body 下',
  );
  assert.equal(dropdown.closest('.topbar'), null);
  // 定位改由 JS 下发：fixed 相对视口，两个坐标都得写上，否则浮层会贴到左上角
  assert.ok(dropdown.style.left.endsWith('px'), 'left 应由 positionDropdown 下发');
  assert.ok(dropdown.style.top.endsWith('px'), 'top 应由 positionDropdown 下发');

  // 列表照常渲染（搬家后 #gitBranches 仍能被 $ 找到）
  assert.ok(doc.querySelectorAll('#gitBranches .git-branch-item').length >= 2, '分支列表应渲染');
});

test('浮层样式契约：fixed 定位 + 不透明背景 + 压过 toast/右键菜单但低于系统级罩层', async () => {
  const css = fs.readFileSync('public/app.css', 'utf8');
  const block = css.slice(css.indexOf('.git-dropdown {'));
  const rule = block.slice(0, block.indexOf('}'));

  assert.match(rule, /position:\s*fixed/, '必须 fixed —— absolute 会被 topbar 的包含块困住');
  const z = Number(/z-index:\s*(\d+)/.exec(rule)?.[1]);
  assert.ok(z > 9999, `应压过 toast 与两个右键菜单（均 9999），实际 ${z}`);
  assert.ok(z < 99999, `不得压过启动错误条/启动罩/掉线罩这些系统级阻断层，实际 ${z}`);

  // 背景必须是实色。--panel-2 是 #1d1e28（不含 alpha），rgba()/transparent 一律不接受
  const bg = /background:\s*([^;]+);/.exec(rule)?.[1] || '';
  assert.ok(bg, '必须显式给背景');
  assert.doesNotMatch(bg, /transparent|rgba\(|hsla\(/, `背景不得半透明，实际：${bg}`);
});
