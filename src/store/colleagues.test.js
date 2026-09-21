import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 隔离数据目录：store/index.js 按 APP_DATA_DIR 定位，须在 import store 之前设置
process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'colleagues-store-'));
const {
  ROLES,
  normalizeColleagues,
  validateColleagueInput,
  getColleagues,
  getColleague,
  getColleaguesByRole,
  addColleague,
  addColleaguesBatch,
  updateColleague,
  removeColleague,
} = await import('./colleagues.js');

test('ROLES：6 个固定职位，顺序与 id 唯一性钉住', () => {
  // 顺序也断言：它就是设置页与选人弹窗的分组顺序，新职位只能追加到末尾
  assert.deepEqual(
    ROLES.map((r) => r.id),
    ['ops', 'frontend', 'backend', 'design', 'product', 'qa'],
  );
  assert.equal(new Set(ROLES.map((r) => r.id)).size, ROLES.length);
  assert.ok(ROLES.every((r) => r.label), '每个职位都要有 label（UI 直接渲染它）');
});

test('normalizeColleagues：非数组归空；缺字段补空串', () => {
  assert.deepEqual(normalizeColleagues(null), []);
  assert.deepEqual(normalizeColleagues({}), []);
  const out = normalizeColleagues([{ id: 'cl_x' }]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { id: 'cl_x', role: '', name: '', note: '', feishuOpenId: '', updatedAt: '' });
});

test('normalizeColleagues：无 id 的条目补发 id，而不是丢弃', () => {
  const out = normalizeColleagues([{ name: '手改进来的' }]);
  assert.equal(out.length, 1, '不该丢弃：丢了用户连它曾经存在都看不见');
  assert.match(out[0].id, /^cl_/);
  assert.equal(out[0].name, '手改进来的');
});

test('normalizeColleagues：非法 role 原样保留，不静默改写', () => {
  const out = normalizeColleagues([{ id: 'cl_y', role: 'not-a-role', name: '张三' }]);
  assert.equal(out[0].role, 'not-a-role', '归一到合法值 = 静默改数据，UI 靠「未知职位」兜底分组显示');
});

test('validateColleagueInput：姓名必填', () => {
  assert.match(validateColleagueInput({ role: 'frontend', name: '   ' }).error, /姓名/);
  assert.match(validateColleagueInput({ role: 'frontend' }).error, /姓名/);
});

test('validateColleagueInput：role 必须在枚举内', () => {
  assert.match(validateColleagueInput({ role: 'not-a-role', name: '张三' }).error, /未知职位/);
  assert.match(validateColleagueInput({ name: '张三' }).error, /未知职位/);
  assert.equal(validateColleagueInput({ role: 'frontend', name: '张三' }).error, undefined);
});

test('validateColleagueInput：open_id 可空；非空必须 ou_ 前缀', () => {
  assert.equal(validateColleagueInput({ role: 'ops', name: '李四' }).value.feishuOpenId, '');
  assert.match(validateColleagueInput({ role: 'ops', name: '李四', feishuOpenId: 'abc' }).error, /ou_/);
  assert.equal(
    validateColleagueInput({ role: 'ops', name: '李四', feishuOpenId: 'ou_123' }).value.feishuOpenId,
    'ou_123',
  );
});

test('validateColleagueInput：姓名 40 字 / 备注 100 字截断', () => {
  const v = validateColleagueInput({ role: 'ops', name: 'a'.repeat(60), note: 'b'.repeat(200) });
  assert.equal(v.value.name.length, 40);
  assert.equal(v.value.note.length, 100);
});

test('addColleague → getColleague / getColleaguesByRole 回读', () => {
  const c = addColleague({ role: 'frontend', name: '王五', note: '活动页', feishuOpenId: 'ou_w5' });
  assert.match(c.id, /^cl_/);
  assert.equal(c.role, 'frontend');
  assert.ok(c.updatedAt);
  assert.equal(getColleague(c.id).name, '王五');
  assert.ok(getColleaguesByRole('frontend').some((x) => x.id === c.id));
  assert.deepEqual(getColleaguesByRole('not-a-role'), [], '非法 roleId 返回空数组而非抛错');
  assert.ok(getColleagues().some((x) => x.id === c.id));
});

test('addColleague：非法 role 抛错（挡住非 HTTP 调用方写脏数据）', () => {
  assert.throws(() => addColleague({ role: 'not-a-role', name: '赵六' }), /未知职位/);
});

test('updateColleague：局部更新；未知 id 返回 null', () => {
  const c = addColleague({ role: 'backend', name: '钱七' });
  const u = updateColleague(c.id, { role: 'backend', name: '钱七七', note: '改了备注' });
  assert.equal(u.name, '钱七七');
  assert.equal(u.note, '改了备注');
  assert.equal(u.id, c.id, 'id 不可被 patch 覆盖');
  assert.equal(updateColleague('cl_none', { role: 'ops', name: 'X' }), null);
});

test('removeColleague：删除返回 true；未知 id 返回 false', () => {
  const c = addColleague({ role: 'design', name: '孙八' });
  assert.equal(removeColleague(c.id), true);
  assert.equal(getColleague(c.id), null);
  assert.equal(removeColleague('cl_none'), false);
});

// ==== 批量导入（从飞书群） ====

test('addColleaguesBatch：按 feishuOpenId 跳过已存在，不覆盖已有备注/职位', () => {
  const exist = addColleague({ role: 'frontend', name: '老王', note: '我手填的备注', feishuOpenId: 'ou_dup' });
  const r = addColleaguesBatch([
    { role: 'backend', name: '老王(飞书名)', feishuOpenId: 'ou_dup' }, // 撞号 → 跳过
    { role: 'ops', name: '新人甲', feishuOpenId: 'ou_new1' },
  ]);
  assert.equal(r.added.length, 1);
  assert.equal(r.added[0].name, '新人甲');
  assert.deepEqual(r.skipped, ['ou_dup']);
  // 已存在那条必须原封不动：覆盖会抹掉用户手改的职位与备注
  const kept = getColleague(exist.id);
  assert.equal(kept.role, 'frontend');
  assert.equal(kept.note, '我手填的备注');
  assert.equal(kept.name, '老王');
});

test('addColleaguesBatch：同一批内部也去重（同一人被勾两次）', () => {
  const r = addColleaguesBatch([
    { role: 'ops', name: 'A', feishuOpenId: 'ou_same' },
    { role: 'backend', name: 'A 重复', feishuOpenId: 'ou_same' },
  ]);
  assert.equal(r.added.length, 1);
  assert.deepEqual(r.skipped, ['ou_same']);
});

test('addColleaguesBatch：整批原子校验——任一条非法则整批不写入', () => {
  const before = getColleagues().length;
  assert.throws(
    () => addColleaguesBatch([
      { role: 'ops', name: '合法的', feishuOpenId: 'ou_ok' },
      { role: 'not-a-role', name: '非法职位' },
    ]),
    /未知职位/,
  );
  assert.equal(getColleagues().length, before, '半批写入会让用户看到一份残缺名册且不知道断在哪');
});

test('addColleaguesBatch：空数组与非数组不炸，返回空结果', () => {
  assert.deepEqual(addColleaguesBatch([]), { added: [], skipped: [] });
  assert.deepEqual(addColleaguesBatch(null), { added: [], skipped: [] });
});

test('addColleaguesBatch：无 feishuOpenId 的条目不参与去重，照常写入', () => {
  const r = addColleaguesBatch([
    { role: 'product', name: '无号甲' },
    { role: 'product', name: '无号乙' },
  ]);
  assert.equal(r.added.length, 2, '空 open_id 不能被当成「同一个人」折叠掉');
  assert.deepEqual(r.skipped, []);
});
