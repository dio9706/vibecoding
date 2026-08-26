import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { checkPrompts } from './check-prompts.js';

/**
 * 提示词维度的「无数据」口径。
 *
 * 背景：此前只要候选为 0 就给 100 分 done，而候选为 0 有两种完全不同的成因——
 * ① 项目压根没有提示词文件；② 有文件且都很干净。第①种被当成满分，实测本仓库
 * （无 CLAUDE.md、无 .claude/rules）因此拿到 prompts=100，30 点权重把总分从 0 抬到 46。
 * comments 维度早已区分这两者（sampled===0 → na），本维度对齐它。
 *
 * 这两个用例都不会触发 LLM 调用（候选为 0 时直接定论），跑起来没有额度开销。
 */
function tmpProject(t, name) {
  const dir = path.join(os.tmpdir(), `cad-prompts-fs-${name}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('没有任何提示词文件 → na 不计入总分（而不是满分）', async (t) => {
  const dir = tmpProject(t, 'empty');
  fs.writeFileSync(path.join(dir, 'index.js'), 'export const a = 1;\n'); // 只有代码，没有提示词

  const r = await checkPrompts(dir);
  assert.equal(r.status, 'na', '无提示词文件应判 na');
  assert.equal(r.score, null, 'na 不该带分数');
  assert.deepStrictEqual(r.issues, []);
  assert.match(r.reason, /没有|提示词/, '应说明为何无法判断');
});

test('有提示词文件且无可疑条目 → 100 分 done（这才是真正的满分场景）', async (t) => {
  const dir = tmpProject(t, 'clean');
  fs.writeFileSync(
    path.join(dir, 'CLAUDE.md'),
    '# 示例项目\n\n## 模块\n\n- src/store：数据读写\n',
  );

  const r = await checkPrompts(dir);
  assert.equal(r.status, 'done');
  assert.equal(r.score, 100);
});

test('测试夹具目录不参与提示词收集（fixtures 是刻意写坏的假配置）', async (t) => {
  const dir = tmpProject(t, 'fixtures');
  const fx = path.join(dir, 'tests', 'fixtures', 'projects', 'demote-target');
  fs.mkdirSync(fx, { recursive: true });
  fs.writeFileSync(path.join(fx, 'CLAUDE.md'), '# 夹具\n\n永远不要使用 any。\n');
  fs.writeFileSync(path.join(dir, 'index.js'), 'export const a = 1;\n');

  const r = await checkPrompts(dir);
  assert.equal(r.status, 'na', '夹具里的 CLAUDE.md 不该让本维度变成「有数据」');
});
