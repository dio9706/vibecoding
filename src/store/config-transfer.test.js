/**
 * 配置导入导出纯函数单测。
 * buildExport：把 settings + 托管配置包成带类型/版本标记的导出对象。
 * parseImport：校验导入对象的类型/版本/结构，返回 {ok, settings, actionConfigs} | {ok:false, error}。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIG_TYPE,
  CONFIG_VERSION,
  buildExport,
  parseImport,
} from './config-transfer.js';

test('buildExport：包上类型/版本/时间戳，原样带上 settings 与 actionConfigs', () => {
  const settings = { lark: { appId: 'cli_x' }, tokens: [{ id: 't1' }] };
  const actionConfigs = [{ id: 'ac_1', name: '清理账号数据' }];
  const out = buildExport(settings, actionConfigs, '2026-07-21T00:00:00.000Z');
  assert.equal(out.__type, CONFIG_TYPE);
  assert.equal(out.version, CONFIG_VERSION);
  assert.equal(out.exportedAt, '2026-07-21T00:00:00.000Z');
  assert.deepEqual(out.settings, settings);
  assert.deepEqual(out.actionConfigs, actionConfigs);
});

test('buildExport：缺省时间戳/settings/actionConfigs 有安全默认', () => {
  const out = buildExport();
  assert.equal(out.exportedAt, null);
  assert.deepEqual(out.settings, {});
  assert.deepEqual(out.actionConfigs, []);
});

// 非数组归一为 []：导出侧宁可写个空数组，也不要往包里塞一个字符串
// 让导入侧的 Array.isArray 判成 null（那会被当成「旧版包」而跳过写盘）
test('buildExport：actionConfigs 非数组 → 归一为空数组', () => {
  assert.deepEqual(buildExport({}, 'not-an-array').actionConfigs, []);
  assert.deepEqual(buildExport({}, null).actionConfigs, []);
  assert.deepEqual(buildExport({}, { a: 1 }).actionConfigs, []);
});

test('CONFIG_VERSION 已升到 2', () => {
  assert.equal(CONFIG_VERSION, 2);
});

test('parseImport：v2 合法对象通过，回传 settings 与 actionConfigs', () => {
  const raw = {
    __type: CONFIG_TYPE,
    version: 2,
    settings: { tokens: [] },
    actionConfigs: [{ id: 'ac_1' }],
  };
  const r = parseImport(raw);
  assert.equal(r.ok, true);
  assert.deepEqual(r.settings, { tokens: [] });
  assert.deepEqual(r.actionConfigs, [{ id: 'ac_1' }]);
});

test('parseImport：v2 往返（buildExport → parseImport）', () => {
  const settings = { tokens: [{ id: 't1' }], bots: [{ id: 'b1' }] };
  const actionConfigs = [{ id: 'ac_1', botId: 'b1' }];
  const r = parseImport(buildExport(settings, actionConfigs, null));
  assert.equal(r.ok, true);
  assert.deepEqual(r.settings, settings);
  assert.deepEqual(r.actionConfigs, actionConfigs);
});

// v1 包没有 actionConfigs 字段。回 null 而不是 [] —— 语义是「本次导入不涉及托管配置」，
// 调用方据此跳过写 action-configs.json。回 [] 会把用户现有的动作全清空。
test('parseImport：v1 旧包仍可导入，actionConfigs 为 null（不涉及）', () => {
  const raw = { __type: CONFIG_TYPE, version: 1, settings: { tokens: [] } };
  const r = parseImport(raw);
  assert.equal(r.ok, true);
  assert.deepEqual(r.settings, { tokens: [] });
  assert.equal(r.actionConfigs, null);
});

test('parseImport：v2 包但 actionConfigs 非数组 → null（按不涉及处理，不清空用户数据）', () => {
  const base = { __type: CONFIG_TYPE, version: 2, settings: {} };
  assert.equal(parseImport({ ...base, actionConfigs: 'x' }).actionConfigs, null);
  assert.equal(parseImport({ ...base, actionConfigs: { a: 1 } }).actionConfigs, null);
  assert.equal(parseImport(base).actionConfigs, null);
});

test('parseImport：类型不符 → ok:false', () => {
  const r = parseImport({ __type: 'other', version: 1, settings: {} });
  assert.equal(r.ok, false);
  assert.match(r.error, /类型/);
});

test('parseImport：不支持的版本 → ok:false', () => {
  assert.equal(parseImport({ __type: CONFIG_TYPE, version: 3, settings: {} }).ok, false);
  assert.equal(parseImport({ __type: CONFIG_TYPE, version: 999, settings: {} }).ok, false);
  assert.equal(parseImport({ __type: CONFIG_TYPE, version: 0, settings: {} }).ok, false);
  assert.match(parseImport({ __type: CONFIG_TYPE, version: 3, settings: {} }).error, /版本/);
});

test('parseImport：settings 缺失/非对象 → ok:false', () => {
  assert.equal(parseImport({ __type: CONFIG_TYPE, version: CONFIG_VERSION }).ok, false);
  assert.equal(parseImport({ __type: CONFIG_TYPE, version: CONFIG_VERSION, settings: [] }).ok, false);
});

test('parseImport：非对象/null/数组入参 → ok:false，不抛', () => {
  assert.equal(parseImport(null).ok, false);
  assert.equal(parseImport('x').ok, false);
  assert.equal(parseImport([]).ok, false);
});
