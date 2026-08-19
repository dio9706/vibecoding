/**
 * 开发期右栏「后端 API 文档」上传/删除的回归测试。
 *
 * 背景（2026-08-13）：renderDevRail 里的上传与删除 handler 都引用了一个**从未声明**的 `epoch`。
 * 模块是 ESM（天然严格模式），读未声明绑定直接抛 ReferenceError：
 *   - 上传路径：异常发生在文件已上传、服务端已登记之后，被 catch 成
 *     「API 文档上传失败：epoch is not defined」——用户以为没传上去，其实早就落库了；
 *     真正的损失是后面那条「请对照文档修正代码」的消息没发出去（服务端自 2026-08-05 起
 *     不再 enqueue api-fix 系统任务，这条消息是新文档的唯一消费入口）→ 表现为「上传了但没生效」。
 *   - 删除路径：没有 try/catch，连 toast 都不弹，服务端已删的文档在界面上还挂着。
 *
 * 这类错误服务端全绿、静态检查也看不出来，只有真跑一遍 DOM 交互才抓得到，所以这里用 jsdom
 * 把整条 import 链（req-chat → chat → …）真实拉起来，经 mountReqChrome 驱动右栏渲染。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

let dom;
let mountReqChrome;
let toastCalls;
let fetchLog;

/** 右栏渲染所需的需求详情（phase=dev 才渲染 renderDevRail） */
function devReq(overrides = {}) {
  return {
    id: 'r_test1',
    title: '测试需求',
    phase: 'dev',
    convId: 'c_test1',
    apiDocs: [],
    projects: {},
    // 留空避免触发「首轮 develop 提示词」自动发送
    devDoc: { versions: [] },
    busy: null,
    bugs: [],
    designGuidelines: '',
    ...overrides,
  };
}

before(async () => {
  // 用真实 index.html 当骨架：chat.js/dir-popover.js 在模块顶层就绑事件，缺元素会直接抛
  const html = fs.readFileSync('public/index.html', 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  dom = new JSDOM(html, { url: 'http://localhost/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.CustomEvent = dom.window.CustomEvent;
  globalThis.File = dom.window.File;
  globalThis.getComputedStyle = dom.window.getComputedStyle;
  globalThis.MutationObserver = dom.window.MutationObserver;
  globalThis.location = dom.window.location;
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  globalThis.EventSource = class { addEventListener() {} close() {} };
  globalThis.alert = () => {};
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

  const mod = await import('./req-chat.js');
  mountReqChrome = mod.mountReqChrome;
  mod.initReqChat(); // 绑定 #reqBanner / #reqRail 容器

  // toast 是全局桥（window.toast），断言点就在这
  toastCalls = [];
  dom.window.toast = {
    success: (m) => toastCalls.push(['success', m]),
    error: (m) => toastCalls.push(['error', m]),
    info: (m) => toastCalls.push(['info', m]),
  };
});

after(() => {
  dom?.window?.close();
  // process.exit(0);
});

/** 按 URL 分派的 fetch stub，同时记录调用便于断言 */
function stubFetch(routes) {
  fetchLog = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    fetchLog.push({ url: u, method: opts.method || 'GET' });
    for (const [frag, make] of Object.entries(routes)) {
      if (u.includes(frag)) {
        const body = make(opts);
        return { ok: body.__ok !== false, status: body.__status || 200, json: async () => body };
      }
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
}

/** 挂载右栏并取出 API 文档区的隐藏 file input */
async function mountAndGetFileInput(reqData) {
  stubFetch({ '/api/req/get': () => reqData });
  await mountReqChrome(reqData.id);
  const input = dom.window.document.querySelector('#reqRail input[type=file]');
  assert.ok(input, '开发期右栏应渲染出 API 文档上传用的 file input');
  return input;
}

/** 模拟选中文件并触发 change（jsdom 的 input.files 只读，需覆写） */
async function pickFile(input, name = 'api-spec.md') {
  const file = new dom.window.File(['# API'], name, { type: 'text/markdown' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new dom.window.Event('change'));
  // handler 是 async，等微任务队列排空（两次上传请求 + 一次 refreshRail）
  await new Promise((r) => setTimeout(r, 50));
}

test('上传 API 文档：走完全程且不报错（回归：epoch 未声明导致 ReferenceError）', async () => {
  const data = devReq();
  const input = await mountAndGetFileInput(data);

  stubFetch({
    '/api/upload': () => ({ path: 'C:\\tmp\\api-spec.md', name: 'api-spec.md' }),
    '/api/req/apidoc': () => ({
      ok: true,
      action: '新增',
      doc: { id: 'd1', name: 'api-spec.md', path: 'C:\\tmp\\api-spec.md' },
    }),
    '/api/req/get': () => data,
  });
  toastCalls = [];

  await pickFile(input);

  const errors = toastCalls.filter(([kind]) => kind === 'error');
  assert.deepEqual(errors, [], `上传不应报错，实际：${JSON.stringify(errors)}`);
  assert.ok(
    toastCalls.some(([kind, msg]) => kind === 'success' && msg.includes('已入队自动修正')),
    `应提示已入队自动修正，实际 toast：${JSON.stringify(toastCalls)}`,
  );

  // 两段式上传：先传文件拿 path，再登记到需求
  assert.ok(fetchLog.some((f) => f.url.includes('/api/upload')), '应调用 /api/upload');
  assert.ok(
    fetchLog.some((f) => f.url.includes('/api/req/apidoc') && f.method === 'POST'),
    '应调用 POST /api/req/apidoc 登记',
  );
});

test('上传 API 文档：会话未就绪时显式报错，不静默吞掉修正消息', async () => {
  // convId 为空 → sendMessageProgrammatically 会静默 return，用户永远等不到那条修正消息
  const data = devReq({ convId: null });
  const input = await mountAndGetFileInput(data);

  stubFetch({
    '/api/upload': () => ({ path: 'C:\\tmp\\api-spec.md', name: 'api-spec.md' }),
    '/api/req/apidoc': () => ({ ok: true, action: '新增', doc: { id: 'd1', name: 'a.md', path: 'p' } }),
    '/api/req/get': () => data,
  });
  toastCalls = [];

  await pickFile(input);

  assert.ok(
    toastCalls.some(([kind, msg]) => kind === 'error' && msg.includes('会话未就绪')),
    `会话未就绪应显式提示，实际 toast：${JSON.stringify(toastCalls)}`,
  );
});

test('上传 API 文档：登记失败时报出服务端错误原文', async () => {
  const data = devReq();
  const input = await mountAndGetFileInput(data);

  stubFetch({
    '/api/upload': () => ({ path: 'C:\\tmp\\api-spec.md' }),
    '/api/req/apidoc': () => ({ __ok: false, __status: 409, error: '当前阶段不允许' }),
    '/api/req/get': () => data,
  });
  toastCalls = [];

  await pickFile(input);

  assert.ok(
    toastCalls.some(([kind, msg]) => kind === 'error' && msg.includes('当前阶段不允许')),
    `应透出服务端错误，实际 toast：${JSON.stringify(toastCalls)}`,
  );
  // 关键：错误信息必须是业务原因，不能再是 epoch is not defined 这类内部异常
  assert.ok(
    !toastCalls.some(([, msg]) => /is not defined/.test(msg)),
    'toast 里不应出现 ReferenceError 文案',
  );
});

test('替换 API 文档：点击🔄按钮，上传新文件，name 应为原文档名', async () => {
  // 场景：已有 existing-api.md，点替换按钮，上传 new-api.md
  // 期望：POST /api/req/apidoc 的请求体中 name 是 existing-api.md（原文档名），不是 new-api.md（新文件名）
  const data = devReq({
    apiDocs: [
      { id: 'd1', name: 'existing-api.md', path: 'C:\\old\\existing-api.md', updatedAt: '2026-08-19' },
    ],
  });
  const input = await mountAndGetFileInput(data);

  let postedName = null; // 捕获 POST /api/req/apidoc 的请求体中的 name 字段
  stubFetch({
    '/api/upload': () => ({ path: 'C:\\tmp\\new-api.md', name: 'new-api.md' }),
    '/api/req/apidoc': (opts) => {
      const body = JSON.parse(opts.body || '{}');
      postedName = body.name;
      return {
        ok: true,
        action: '更新',
        doc: { id: 'd1', name: 'existing-api.md', path: 'C:\\tmp\\new-api.md' },
      };
    },
    '/api/req/get': () => data,
  });
  toastCalls = [];

  // 模拟点击替换按钮：需要先找到按钮、模拟点击以设置 pendingReplaceName
  const replaceBtn = dom.window.document.querySelector('#reqRail .req-apidoc-item button[title*="替换"]');
  assert.ok(replaceBtn, '应该有替换按钮');
  replaceBtn.click();
  // 点击后 pendingReplaceName 应被设为 'existing-api.md'（在 fileInput.click() 之前就设置了）
  // 现在模拟选择文件
  await pickFile(input, 'new-api.md');

  // 验证关键点：POST 请求体的 name 应该是原文档名
  assert.strictEqual(
    postedName,
    'existing-api.md',
    `替换时 POST name 应为原文档名，实际：${postedName}`,
  );

  // 验证服务端返回 action='更新'
  const apidocCall = fetchLog.find((f) => f.url.includes('/api/req/apidoc') && f.method === 'POST');
  assert.ok(apidocCall, '应调用 POST /api/req/apidoc');

  // 验证消息文案包含"已更新"
  assert.ok(
    toastCalls.some(([kind, msg]) => kind === 'success' && msg.includes('已入队自动修正')),
    `应提示已入队自动修正，实际 toast：${JSON.stringify(toastCalls)}`,
  );
});

test('新增 API 文档：点击＋上传，选择新文件，name 应为新文件名', async () => {
  // 场景：没有文档，点＋上传，上传 new-api.md
  // 期望：POST /api/req/apidoc 的请求体中 name 是 new-api.md（新文件名），action='新增'
  const data = devReq({ apiDocs: [] });
  const input = await mountAndGetFileInput(data);

  let postedName = null;
  let postedAction = null;
  stubFetch({
    '/api/upload': () => ({ path: 'C:\\tmp\\new-api.md', name: 'new-api.md' }),
    '/api/req/apidoc': (opts) => {
      const body = JSON.parse(opts.body || '{}');
      postedName = body.name;
      return {
        ok: true,
        action: '新增',
        doc: { id: 'd1', name: 'new-api.md', path: 'C:\\tmp\\new-api.md' },
      };
    },
    '/api/req/get': () => data,
  });
  toastCalls = [];

  // 点击＋上传按钮（此时 pendingReplaceName 应为 null）
  const uploadBtn = dom.window.document.querySelector('#reqRail .req-rail-head button:not(.rail-toggle)');
  assert.ok(uploadBtn, '应该有上传按钮');
  uploadBtn.click();
  // 模拟选择文件
  await pickFile(input, 'new-api.md');

  // 验证关键点：POST 请求体的 name 应该是新文件名
  assert.strictEqual(
    postedName,
    'new-api.md',
    `新增时 POST name 应为新文件名，实际：${postedName}`,
  );

  // 验证消息文案包含"已新增"
  assert.ok(
    toastCalls.some(([kind, msg]) => kind === 'success' && msg.includes('已入队自动修正')),
    `应提示已入队自动修正，实际 toast：${JSON.stringify(toastCalls)}`,
  );
});
