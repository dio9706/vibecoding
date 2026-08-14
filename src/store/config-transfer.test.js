/**
 * 配置导入导出纯函数单测。
 * buildExport：把 settings 包成带类型/版本标记的导出对象。
 * parseImport：校验导入对象的类型/版本/结构，返回 {ok, settings} | {ok:false, error}。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIG_TYPE,
  CONFIG_VERSION,
  buildExport,
  parseImport,
} from './config-transfer.js';

test('buildExport：包上类型/版本/时间戳，原样带上 settings', () => {
  const settings = { lark: { appId: 'cli_x' }, tokens: [{ id: 't1' }] };
  const out = buildExport(settings, '2026-07-21T00:00:00.000Z');
  assert.equal(out.__type, CONFIG_TYPE);
  assert.equal(out.version, CONFIG_VERSION);
  assert.equal(out.exportedAt, '2026-07-21T00:00:00.000Z');
  assert.deepEqual(out.settings, settings);
});

test('buildExport：缺省时间戳/缺省 settings 有安全默认', () => {
  const out = buildExport();
  assert.equal(out.exportedAt, null);
  assert.deepEqual(out.settings, {});
});

test('parseImport：合法对象通过并回传 settings', () => {
  const raw = { __type: CONFIG_TYPE, version: CONFIG_VERSION, settings: { tokens: [] } };
  const r = parseImport(raw);
  assert.equal(r.ok, true);
  assert.deepEqual(r.settings, { tokens: [] });
});

test('parseImport：类型不符 → ok:false', () => {
  const r = parseImport({ __type: 'other', version: 1, settings: {} });
  assert.equal(r.ok, false);
  assert.match(r.error, /类型/);
});

test('parseImport：版本不符 → ok:false', () => {
  const r = parseImport({ __type: CONFIG_TYPE, version: 999, settings: {} });
  assert.equal(r.ok, false);
  assert.match(r.error, /版本/);
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
