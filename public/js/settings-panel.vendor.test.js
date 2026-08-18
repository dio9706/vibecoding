import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * 自定义模型凭证的厂商反查表。
 *
 * 背景：凭证列表一直显示「—」——前端 addCredentialUI 在 POST body 里传了 vendor，
 * 但后端 handleCredentialsAdd 只取 apiKey/baseURL/model/label 就把它丢了，
 * 而 renderCredList 又去读 c.vendor，于是那一列从上线起就没亮过。
 *
 * 补上存字段只能救新凭证，存量的仍然没有 vendor。BASEURL_TO_VENDOR 用 baseURL
 * 把厂商推回来，省掉一次数据迁移——预设的 baseURL 本来就是各厂商唯一的。
 *
 * 注：不 import settings-panel.js。它顶层 import 了 util/ui，在 node 里等于
 * 启动半个前端；照 chat.path.test.js 的做法从源码抽这一段来跑。
 */

let VENDOR_PRESETS;
let BASEURL_TO_VENDOR;

before(() => {
  const src = fs.readFileSync('public/js/settings-panel.js', 'utf8');
  const start = src.indexOf('const VENDOR_PRESETS');
  const end = src.indexOf('const SUBSCRIPTION_TYPES');
  assert.ok(start > 0 && end > start, 'settings-panel.js 里的厂商预设段没找到，源码结构可能变了');
  const segment = src.slice(start, end);
  ({ VENDOR_PRESETS, BASEURL_TO_VENDOR } = new Function(
    segment + '\nreturn { VENDOR_PRESETS, BASEURL_TO_VENDOR };',
  )());
});

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
