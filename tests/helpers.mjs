/**
 * e2e 共用辅助。
 *
 * 文件名刻意不以 `e2e-` 开头 —— `scripts/run-e2e.mjs` 是按该前缀收集用例的，
 * 叫 `e2e-helpers.mjs` 会被当成一个测试去跑。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * 往临时 APP_DATA_DIR 预置一份「已配置用户」的 settings.json。
 * **自起独立 server 的 e2e 必须在启动 server 前调用它。**
 *
 * ## 为什么必须有
 *
 * onboarding 的 `isNewUser(settings)` 判据就一条：`settings.tokens` 为空数组或不存在。
 * 而自起 server 的 e2e 用的是 `mkdtemp` 出来的**空数据目录** —— 必然判为新用户，
 * 于是引导罩接管启动罩（`#bootOverlay` 带上 `ob-arm ob-open`）并覆盖全屏，
 * 此后**所有点击都被它拦截**。
 *
 * 症状极具迷惑性：报的是一连串「element is not visible」或
 * 「<div class="ob-titlebar-drag"> ... intercepts pointer events」超时，
 * 元素明明在 DOM 里、也确实可见，而且**没有任何 pageerror**可查 ——
 * 很容易误判成「被测功能坏了」或「时序不够」。
 *
 * 这是 2026-08-26 上线 onboarding 引入的，四个自起 server 的 e2e
 * （conv-notify / no-auto-switch / req-review / retro-summary）全部中招；
 * 而它们当时不在任何一条可执行的流程里，于是长期无人发现。
 *
 * token 是占位值：这些用例都声明「零 Claude 调用」，不会真的拿它发请求。
 *
 * @param {string} dataDir 传给 server 的 APP_DATA_DIR
 * @returns {string} 写入的文件路径
 */
export const E2E_TOKENS = [
  {
    id: 'e2e-placeholder',
    label: 'e2e 占位（不会真的发起调用）',
    token: 'sk-ant-e2e-placeholder-not-a-real-key',
    status: 'healthy',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

export function seedConfiguredSettings(dataDir, extra = {}) {
  const file = path.join(dataDir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ tokens: E2E_TOKENS, ...extra }, null, 2));
  return file;
}

/**
 * 用例中途**覆写** settings.json 时用这个，别手写整个对象。
 *
 * 覆写是整体替换（`getSettings()` 每次读盘、无合并），漏掉 `tokens` 就等于
 * 把用例打回「新用户」状态 —— 后续任何一次开页面都会被引导罩接管，
 * 而症状只是「点击被 intercepts pointer events 挡住」，极难联想到是这一行造成的。
 *
 * @param {string} file settings.json 路径
 * @param {object} patch 本次要写入的字段（tokens 会自动补上）
 */
export function writeSettings(file, patch) {
  fs.writeFileSync(file, JSON.stringify({ tokens: E2E_TOKENS, ...patch }, null, 2));
}
