import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSidePrompt,
  buildAssetOnlyPrompt,
  parseSideJson,
  resolveBackendAssignees,
  buildAssigneePatch,
} from './side-review.logic.js';

test('buildSidePrompt：带上前后端目录与记录详情，要求单行 JSON', () => {
  const p = buildSidePrompt(
    { title: '分页错乱', detail: 'total 对不上' },
    { frontendDir: 'C:/fe', backendDir: 'C:/be' },
  );
  assert.match(p, /C:\/fe/);
  assert.match(p, /C:\/be/);
  assert.match(p, /分页错乱/);
  assert.match(p, /total 对不上/);
  assert.match(p, /"side"/);
  assert.match(p, /只读/);
});

test('buildSidePrompt：目录缺失时给占位而非 undefined', () => {
  const p = buildSidePrompt({ title: 'x' }, {});
  assert.match(p, /（未配置）/);
  assert.doesNotMatch(p, /undefined/);
});

test('parseSideJson：正常解析三种 side', () => {
  assert.equal(parseSideJson('{"side":"backend","evidence":"e","advice":"a"}').side, 'backend');
  assert.equal(parseSideJson('前言\n{"side":"frontend","evidence":"e"}').side, 'frontend');
  assert.equal(parseSideJson('{"side":"unknown"}').side, 'unknown');
});

test('parseSideJson：畸形/非法 side 一律落 unknown（绝不误判成 backend 去打扰同事）', () => {
  assert.equal(parseSideJson('').side, 'unknown');
  assert.equal(parseSideJson('not json').side, 'unknown');
  assert.equal(parseSideJson('{"side":"both"}').side, 'unknown');
  assert.equal(parseSideJson('{"side":123}').side, 'unknown');
  assert.equal(parseSideJson(null).side, 'unknown');
  assert.equal(parseSideJson('{坏的 JSON').side, 'unknown');
});

test('parseSideJson：取最后一个合法 JSON（模型爱在思考里先写一版）', () => {
  const t = '先想想 {"side":"frontend"} ……最终 {"side":"backend","advice":"查 count"}';
  const r = parseSideJson(t);
  assert.equal(r.side, 'backend');
  assert.equal(r.advice, '查 count');
});

test('parseSideJson：字段缺失/类型错补空串，不返回 undefined', () => {
  const r = parseSideJson('{"side":"backend","advice":42}');
  assert.equal(r.advice, '');
  assert.equal(r.evidence, '');
});

test('parseSideJson：解析 blocked / blockReason', () => {
  const r = parseSideJson('{"side":"frontend","evidence":"e","advice":"","blocked":"need-assets","blockReason":"要新增空状态插画，附件里没有切图"}');
  assert.equal(r.blocked, 'need-assets');
  assert.equal(r.blockReason, '要新增空状态插画，附件里没有切图');
});

test('parseSideJson：非法 blocked 值归空（判不准不拦截，照常修）', () => {
  assert.equal(parseSideJson('{"side":"frontend","blocked":"whatever"}').blocked, '');
  assert.equal(parseSideJson('{"side":"frontend","blocked":123}').blocked, '');
  assert.equal(parseSideJson('{"side":"frontend"}').blocked, '', '缺字段视为不拦截');
});

test('parseSideJson：完全解析失败时 blocked 也有默认值，不得 undefined', () => {
  const r = parseSideJson('模型今天不讲 JSON');
  assert.equal(r.side, 'unknown');
  assert.equal(r.blocked, '');
  assert.equal(r.blockReason, '');
});

test('buildSidePrompt：包含缺图判定维度与输出字段', () => {
  const p = buildSidePrompt({ title: 't', detail: 'd' }, { frontendDir: 'C:/fe', backendDir: 'C:/be' });
  assert.match(p, /blocked/, '输出 schema 必须含 blocked');
  assert.match(p, /need-assets/);
  assert.match(p, /切图|设计稿|图片/, '必须说清什么叫「资源拿不到」');
});

test('buildAssetOnlyPrompt：只问缺图，不提前后端归属', () => {
  const p = buildAssetOnlyPrompt({ title: 't', detail: 'd' }, { frontendDir: 'C:/fe' });
  assert.match(p, /blocked/);
  assert.match(p, /need-assets/);
  assert.doesNotMatch(p, /"side"/, '精简路径不判前后端，别让模型分心也别浪费 token');
  assert.match(p, /C:\/fe/);
});

test('resolveBackendAssignees：返回 assignees 里的**全部**后端（不挑一个代表）', () => {
  const colleagues = [
    { id: 'c1', role: 'frontend', name: '小前', feishuOpenId: 'ou_fe' },
    { id: 'c2', role: 'backend', name: '李四', feishuOpenId: 'ou_be' },
    { id: 'c3', role: 'backend', name: '王五', feishuOpenId: 'ou_be2' },
    { id: 'c4', role: 'backend', name: '没被指派', feishuOpenId: 'ou_be3' },
  ];
  assert.deepEqual(resolveBackendAssignees({ assignees: ['c1', 'c2', 'c3'], colleagues }), [
    { openId: 'ou_be', name: '李四' },
    { openId: 'ou_be2', name: '王五' },
  ]);
});

test('resolveBackendAssignees：指派的后端里没配 open_id 的被跳过，其余照常返回', () => {
  const colleagues = [
    { id: 'c2', role: 'backend', name: '无号', feishuOpenId: '' },
    { id: 'c3', role: 'backend', name: '王五', feishuOpenId: 'ou_be2' },
  ];
  assert.deepEqual(resolveBackendAssignees({ assignees: ['c2', 'c3'], colleagues }), [
    { openId: 'ou_be2', name: '王五' },
  ]);
});

test('resolveBackendAssignees：assignees 无后端但名册**恰好一位** → 回退用它（无歧义）', () => {
  const colleagues = [
    { id: 'c1', role: 'frontend', name: '小前', feishuOpenId: 'ou_fe' },
    { id: 'c3', role: 'backend', name: '王五', feishuOpenId: 'ou_be2' },
  ];
  assert.deepEqual(resolveBackendAssignees({ assignees: ['c1'], colleagues }), [
    { openId: 'ou_be2', name: '王五' },
  ]);
});

test('resolveBackendAssignees：assignees 无后端且名册有多位 → 空数组（宁可不 @ 也不 @ 错人）', () => {
  const colleagues = [
    { id: 'c2', role: 'backend', name: '李四', feishuOpenId: 'ou_be' },
    { id: 'c3', role: 'backend', name: '王五', feishuOpenId: 'ou_be2' },
  ];
  assert.deepEqual(resolveBackendAssignees({ assignees: [], colleagues }), []);
});

test('resolveBackendAssignees：全都没有 → 空数组（调用方降级为仅移除我）', () => {
  assert.deepEqual(resolveBackendAssignees({ assignees: [], colleagues: [] }), []);
  assert.deepEqual(resolveBackendAssignees({ assignees: [], colleagues: [{ role: 'backend', feishuOpenId: '' }] }), []);
  assert.deepEqual(resolveBackendAssignees({ assignees: [], colleagues: [{ role: 'frontend', feishuOpenId: 'ou_x' }] }), []);
  assert.deepEqual(resolveBackendAssignees({}), []);
});

test('resolveBackendAssignees：无名字时给「后端」占位，不返回空串', () => {
  const r = resolveBackendAssignees({ assignees: [], colleagues: [{ id: 'c', role: 'backend', feishuOpenId: 'ou_x' }] });
  assert.equal(r[0].name, '后端');
});

test('buildAssigneePatch：移除我 + 追加多位后端，保留其他人', () => {
  const cur = [{ id: 'ou_me' }, { id: 'ou_other' }];
  assert.deepEqual(buildAssigneePatch(cur, 'ou_me', ['ou_be', 'ou_be2']), [
    { id: 'ou_other' },
    { id: 'ou_be' },
    { id: 'ou_be2' },
  ]);
});

test('buildAssigneePatch：已在列表里的后端不重复追加', () => {
  const cur = [{ id: 'ou_me' }, { id: 'ou_be' }];
  assert.deepEqual(buildAssigneePatch(cur, 'ou_me', ['ou_be', 'ou_be2']), [{ id: 'ou_be' }, { id: 'ou_be2' }]);
});

test('buildAssigneePatch：后端列表为空 → 仅移除我（降级路径）', () => {
  const cur = [{ id: 'ou_me' }, { id: 'ou_other' }];
  assert.deepEqual(buildAssigneePatch(cur, 'ou_me', []), [{ id: 'ou_other' }]);
  assert.deepEqual(buildAssigneePatch(cur, 'ou_me'), [{ id: 'ou_other' }]);
});

test('buildAssigneePatch：非数组当前值 / 非数组后端列表 都不抛错', () => {
  assert.deepEqual(buildAssigneePatch(null, 'ou_me', ['ou_be']), [{ id: 'ou_be' }]);
  assert.deepEqual(buildAssigneePatch(undefined, 'ou_me', []), []);
  assert.deepEqual(buildAssigneePatch([{ id: 'ou_x' }], 'ou_me', 'bad'), [{ id: 'ou_x' }]);
});

test('buildAssigneePatch：只保留 id 字段（人员字段写入不接受 name 等多余键）', () => {
  const cur = [{ id: 'ou_other', name: '张三', en_name: 'Z' }];
  assert.deepEqual(buildAssigneePatch(cur, 'ou_me', []), [{ id: 'ou_other' }]);
});
