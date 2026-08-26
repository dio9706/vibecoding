import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBotLogEntry, botLabel, userLabel } from './logs-panel.logic.js';

test('动作执行：成功文案', () => {
  const r = formatBotLogEntry({
    kind: 'action', botName: '机器人 1', userName: '申孟涛',
    detail: '获取小程序二维码', ok: true, code: 0,
  });
  assert.equal(r.ok, true);
  assert.equal(r.text, '机器人 1 为 申孟涛 执行了「获取小程序二维码」· 成功');
});

test('动作执行：失败带 code', () => {
  const r = formatBotLogEntry({
    kind: 'action', botName: '机器人 1', userName: '申孟涛',
    detail: '清理账号数据', ok: false, code: 1,
  });
  assert.equal(r.ok, false);
  assert.equal(r.text, '机器人 1 为 申孟涛 执行了「清理账号数据」· 失败(code 1)');
});

test('动作执行：失败但无 code → 占位符不显示 undefined', () => {
  const r = formatBotLogEntry({ kind: 'action', botName: 'B', userName: 'U', detail: 'X', ok: false });
  assert.equal(r.text, 'B 为 U 执行了「X」· 失败(code -)');
});

test('飞书对话文案（引号内是用户原话，不带成功后缀）', () => {
  const r = formatBotLogEntry({
    kind: 'chat', botName: '机器人 1', userName: '申孟涛',
    detail: '帮我看下登录接口报错', ok: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.text, '机器人 1 回复了 申孟涛：「帮我看下登录接口报错」');
});

test('飞书对话：处理失败时标记为失败', () => {
  const r = formatBotLogEntry({ kind: 'chat', botName: 'B', userName: 'U', detail: 'X', ok: false });
  assert.equal(r.ok, false);
  assert.equal(r.text, 'B 回复了 U：「X」· 处理失败');
});

test('userName 缺失 → 回退 openId 尾 6 位', () => {
  assert.equal(userLabel({ userId: 'ou_0af8c9b5bfeb7c667c963c3d08a774fd' }), '用户 …a774fd');
  assert.equal(userLabel({ userName: '申孟涛', userId: 'ou_x' }), '申孟涛', '有姓名时优先用姓名');
  assert.equal(userLabel({}), '用户 —', 'userId 也缺失');
});

test('botName 缺失 → 机器人 —', () => {
  assert.equal(botLabel({ botName: '机器人 1' }), '机器人 1');
  assert.equal(botLabel({}), '机器人 —');
});

test('detail 缺失不渲染 undefined', () => {
  const r = formatBotLogEntry({ kind: 'action', botName: 'B', userName: 'U', ok: true });
  assert.equal(r.text, 'B 为 U 执行了「—」· 成功');
});

test('ok 字段缺失时按成功处理（旧条目容错）', () => {
  assert.equal(formatBotLogEntry({ kind: 'action', detail: 'X' }).ok, true);
});

test('未知 kind 按 action 文案兜底，不返回空白行', () => {
  const r = formatBotLogEntry({ kind: 'weird', botName: 'B', userName: 'U', detail: 'X', ok: true });
  assert.equal(r.text, 'B 为 U 执行了「X」· 成功');
});

test('entry 为 null/undefined 不抛错', () => {
  assert.doesNotThrow(() => formatBotLogEntry(null));
  assert.doesNotThrow(() => formatBotLogEntry(undefined));
});
