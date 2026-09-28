import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, formatRequirementLine } from './prompt.js';

test('formatRequirementLine：带 id / 标题 / 阶段', () => {
  const line = formatRequirementLine({ id: 'r_a1', title: '订单列表改版', phase: 'dev' });
  assert.match(line, /r_a1/);
  assert.match(line, /订单列表改版/);
  assert.match(line, /开发期/);
});

test('buildSystemPrompt：写明对方是谁、什么职位', () => {
  const p = buildSystemPrompt({
    colleague: { id: 'cl_1', name: '张三' },
    roleLabel: '后端',
    requirements: [],
  });
  assert.match(p, /张三/);
  assert.match(p, /后端/);
});

test('buildSystemPrompt：列出他参与的需求，便于 agent 判归属', () => {
  const p = buildSystemPrompt({
    colleague: { id: 'cl_1', name: '张三' },
    roleLabel: '后端',
    requirements: [{ id: 'r_a1', title: '订单列表改版', phase: 'dev' }],
  });
  assert.match(p, /r_a1/);
  assert.match(p, /订单列表改版/);
});

test('buildSystemPrompt：没有需求时给出明确说明，不留空白让模型瞎编', () => {
  const p = buildSystemPrompt({ colleague: { id: 'cl_1', name: '张三' }, roleLabel: '后端', requirements: [] });
  assert.match(p, /暂时没有/);
});

// —— 这条 policy 是整个 2.0 相对旧分类器管线的核心增量：
// 没有它，agent 说「你这份文档和代码对不上」只能是瞎猜。
test('buildSystemPrompt：含「先查证再质疑」硬约束', () => {
  const p = buildSystemPrompt({ colleague: { id: 'cl_1', name: '张三' }, roleLabel: '后端', requirements: [] });
  assert.match(p, /查证/);
  assert.match(p, /read_project_code/);
});

test('buildSystemPrompt：含「不替主机做承诺」与「阶段流转不归你管」两条边界', () => {
  const p = buildSystemPrompt({ colleague: { id: 'cl_1', name: '张三' }, roleLabel: '后端', requirements: [] });
  assert.match(p, /排期|优先级|承诺/);
  assert.match(p, /阶段/);
});
