import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { toCssPoint, hitZone, registerDropZone, attachDragBus } from './drag-bus.js';

/**
 * 装一套假的 window/document 全局。
 * attachDragBus 直接读全局 window/document（浏览器里理所当然），node 里没有，
 * 只能临时注入再还原，否则测试之间会互相污染。
 */
function withFakeTauri({ label = 'main', dpr = 1, html = '<!doctype html><body></body>' } = {}) {
  const dom = new JSDOM(html);
  const win = dom.window;
  Object.defineProperty(win, 'devicePixelRatio', { value: dpr, configurable: true });
  if (label) win.__TAURI_INTERNALS__ = { metadata: { currentWebview: { label } } };
  const prevWin = globalThis.window;
  const prevDoc = globalThis.document;
  globalThis.window = win;
  globalThis.document = win.document;
  return {
    doc: win.document,
    restore() { globalThis.window = prevWin; globalThis.document = prevDoc; },
  };
}

/** 记录所有 listen 调用的假 Tauri event 模块 */
function fakeEv() {
  const calls = [];
  const unlistened = [];
  return {
    calls,
    unlistened,
    listen(name, handler, options) {
      calls.push({ name, handler, options });
      return Promise.resolve(() => unlistened.push(name));
    },
    handlerFor(name) {
      return calls.find((c) => c.name === name)?.handler;
    },
  };
}

/** 吞掉并收集 console 输出，避免噪声，同时可断言确实报了错 */
function captureConsole(level, fn) {
  const lines = [];
  const orig = console[level];
  console[level] = (...args) => lines.push(args.join(' '));
  try { return { result: fn(), lines }; } finally { console[level] = orig; }
}

test('toCssPoint 按 devicePixelRatio 换算物理像素', () => {
  // Windows 150% 缩放：物理 (300,150) 对应 CSS (200,100)。
  // 不换算的话 elementFromPoint 会取到右下方完全不同的元素
  assert.deepEqual(toCssPoint({ x: 300, y: 150 }, 1.5), { x: 200, y: 100 });
  assert.deepEqual(toCssPoint({ x: 10, y: 20 }, 1), { x: 10, y: 20 });
});

test('toCssPoint 对缺失 position 与 dpr=0 不产生 NaN/Infinity', () => {
  assert.deepEqual(toCssPoint(undefined, 0), { x: 0, y: 0 });
  assert.deepEqual(toCssPoint({}, undefined), { x: 0, y: 0 });
});

test('hitZone 命中子元素时归属其所在拖拽区', () => {
  const dom = new JSDOM('<!doctype html><body><div id="zone"><span id="kid">x</span></div></body>');
  const doc = dom.window.document;
  const zoneEl = doc.getElementById('zone');
  const kid = doc.getElementById('kid');
  doc.elementFromPoint = () => kid; // jsdom 不做布局，直接桩掉

  const zone = { el: zoneEl };
  assert.equal(hitZone(doc, [zone], { x: 1, y: 1 }), zone);
});

test('hitZone 落在任何拖拽区之外返回 null', () => {
  const dom = new JSDOM('<!doctype html><body><div id="zone"></div><div id="other"></div></body>');
  const doc = dom.window.document;
  doc.elementFromPoint = () => doc.getElementById('other');
  assert.equal(hitZone(doc, [{ el: doc.getElementById('zone') }], { x: 1, y: 1 }), null);
});

test('hitZone 在 elementFromPoint 返回 null 时不抛异常', () => {
  const dom = new JSDOM('<!doctype html><body><div id="zone"></div></body>');
  const doc = dom.window.document;
  doc.elementFromPoint = () => null; // 拖到窗口空白处
  assert.equal(hitZone(doc, [{ el: doc.getElementById('zone') }], { x: 0, y: 0 }), null);
});

test('hitZone 嵌套拖拽区取最内层，而不是按注册顺序取第一个', () => {
  const dom = new JSDOM(
    '<!doctype html><body><div id="outer"><div id="inner"><span id="kid">x</span></div></div></body>',
  );
  const doc = dom.window.document;
  doc.elementFromPoint = () => doc.getElementById('kid');
  const outer = { el: doc.getElementById('outer') };
  const inner = { el: doc.getElementById('inner') };
  // 故意把外层排在前面：按注册顺序 find 的旧实现会错误地返回 outer
  assert.equal(hitZone(doc, [outer, inner], { x: 1, y: 1 }), inner);
});

test('attachDragBus 必须把 target 锁定到当前 webview，否则 Rust 端 emit_filter 会丢弃事件', async () => {
  const env = withFakeTauri({ label: 'win-2' });
  const ev = fakeEv();
  try {
    const detach = attachDragBus(ev);
    assert.deepEqual(
      ev.calls.map((c) => c.name),
      ['tauri://drag-enter', 'tauri://drag-over', 'tauri://drag-leave', 'tauri://drag-drop'],
    );
    // 默认 target 是 { kind: 'Any' }，会被 emit_to_webview 的 `_ => false` 挡掉，
    // 表现为四个监听器永不触发且无任何报错。这条断言就是防止有人改回默认值。
    for (const c of ev.calls) {
      assert.deepEqual(c.options?.target, { kind: 'Webview', label: 'win-2' });
    }
    await detach();
    assert.equal(ev.unlistened.length, 4, 'detach 应当反注册全部四个监听');
  } finally {
    env.restore();
  }
});

test('attachDragBus 取不到 webview label 时明确报错并放弃订阅，不退回默认 target', () => {
  const env = withFakeTauri({ label: null });
  const ev = fakeEv();
  try {
    const { result, lines } = captureConsole('error', () => attachDragBus(ev));
    assert.equal(result, null);
    assert.equal(ev.calls.length, 0, '拿不到 label 就不该订阅');
    assert.equal(lines.length, 1, '必须留下明确错误，不能静默失败');
  } finally {
    env.restore();
  }
});

test('attachDragBus 重复调用不叠加监听', async () => {
  const env = withFakeTauri();
  const ev = fakeEv();
  try {
    const detach = attachDragBus(ev);
    assert.equal(ev.calls.length, 4);

    const { result, lines } = captureConsole('warn', () => attachDragBus(ev));
    assert.equal(result, null);
    assert.equal(ev.calls.length, 4, '第二次调用不应再产生监听');
    assert.equal(lines.length, 1);

    // detach 之后允许重新挂载，否则热重载场景会永久失效
    await detach();
    const again = attachDragBus(ev);
    assert.equal(ev.calls.length, 8);
    await again();
  } finally {
    env.restore();
  }
});

test('drag-drop 按落点分派，坐标已换算，且未提供 onDrop 的区不抛异常', async () => {
  const env = withFakeTauri({
    dpr: 1.5,
    html: '<!doctype html><body><div id="a"></div><div id="b"></div></body>',
  });
  const doc = env.doc;
  const a = doc.getElementById('a');
  const b = doc.getElementById('b');
  const got = [];
  const unregA = registerDropZone({ el: a, onDrop: (paths, pt) => got.push({ paths, pt }) });
  const unregB = registerDropZone({ el: b }); // 故意不给 onDrop
  const ev = fakeEv();
  try {
    const detach = attachDragBus(ev);
    const onDrop = ev.handlerFor('tauri://drag-drop');

    doc.elementFromPoint = () => a;
    onDrop({ payload: { paths: ['C:\\tmp\\x.md'], position: { x: 300, y: 150 } } });
    assert.deepEqual(got, [{ paths: ['C:\\tmp\\x.md'], pt: { x: 200, y: 100 } }]);

    // 落在没有 onDrop 的区：应当安静跳过而不是 TypeError
    doc.elementFromPoint = () => b;
    onDrop({ payload: { paths: ['C:\\tmp\\y.md'], position: { x: 0, y: 0 } } });
    assert.equal(got.length, 1);

    // 落在任何区之外：什么都不做
    doc.elementFromPoint = () => null;
    onDrop({ payload: { paths: ['C:\\tmp\\z.md'], position: { x: 0, y: 0 } } });
    assert.equal(got.length, 1);

    await detach();
  } finally {
    unregA();
    unregB();
    env.restore();
  }
});
