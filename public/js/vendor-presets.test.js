import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VENDOR_PRESETS, BASEURL_TO_VENDOR } from './vendor-presets.js';

/**
 * 自定义模型凭证的厂商预设与反查表。
 *
 * 背景：凭证列表一直显示「—」——前端 addCredentialUI 在 POST body 里传了 vendor，
 * 但后端 handleCredentialsAdd 只取 apiKey/baseURL/model/label 就把它丢了，
 * 而 renderCredList 又去读 c.vendor，于是那一列从上线起就没亮过。
 *
 * 补上存字段只能救新凭证，存量的仍然没有 vendor。BASEURL_TO_VENDOR 用 baseURL
 * 把厂商推回来，省掉一次数据迁移——预设的 baseURL 本来就是各厂商唯一的。
 *
 * 注：本测试原名 settings-panel.vendor.test.js，靠 fs 读源码 + new Function
 * 切一段文本来跑，因为常量埋在 settings-panel.js 里而那个文件顶层 import 了
 * util/ui（在 node 里等于启动半个前端）。常量抽成纯数据模块后可以直接 import，
 * 不必再依赖「源码里有 const VENDOR_PRESETS 这一行」这种脆弱前提。
 */

test('反查表：预设 baseURL 能推回厂商 key', () => {
  assert.equal(BASEURL_TO_VENDOR['https://api.deepseek.com/v1'], 'deepseek');
  assert.equal(BASEURL_TO_VENDOR['https://api.openai.com/v1'], 'openai');
  assert.equal(BASEURL_TO_VENDOR['https://open.bigmodel.cn/api/paas/v4'], 'zhipu');
});

// custom 的 baseURL 是空串。不过滤的话它会在表里占住 '' 这个键，
// 于是任何缺 baseURL 的凭证都会被误判成「其他（自定义）」。
test('反查表：custom 预设（空 baseURL）不进表', () => {
  assert.equal('' in BASEURL_TO_VENDOR, false);
  assert.equal(Object.values(BASEURL_TO_VENDOR).includes('custom'), false);
});

test('反查表：未知 baseURL 查不到（调用方据此显示「—」）', () => {
  assert.equal(BASEURL_TO_VENDOR['https://api.unknown-vendor.com/v1'], undefined);
  assert.equal(BASEURL_TO_VENDOR[undefined], undefined);
});

test('反查表：每个 value 都是 VENDOR_PRESETS 的合法 key', () => {
  for (const [baseURL, key] of Object.entries(BASEURL_TO_VENDOR)) {
    assert.ok(VENDOR_PRESETS[key], `${key} 不是合法厂商 key`);
    assert.equal(VENDOR_PRESETS[key].baseURL, baseURL, `${key} 的 baseURL 与反查表不一致`);
  }
});

// 反查靠 baseURL 唯一——两个厂商共用同一个 baseURL 会让后者覆盖前者，静默推错厂商
test('反查表：预设 baseURL 无重复（否则反查会覆盖）', () => {
  const urls = Object.values(VENDOR_PRESETS).map((p) => p.baseURL).filter(Boolean);
  assert.equal(new Set(urls).size, urls.length, '存在重复的预设 baseURL');
});

// 引导页的厂商下拉由 VENDOR_PRESETS 动态生成（不像设置页那样硬编码 option），
// 依赖每个预设都有 label 与 models 数组
test('每个预设都有 label 与 models 数组（引导页下拉生成依赖）', () => {
  for (const [key, p] of Object.entries(VENDOR_PRESETS)) {
    assert.equal(typeof p.label, 'string', `${key} 缺 label`);
    assert.ok(p.label.length > 0, `${key} 的 label 为空`);
    assert.ok(Array.isArray(p.models), `${key} 的 models 不是数组`);
  }
});
