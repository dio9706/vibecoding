import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldReanalyzeOnAttach } from './task-ops.js';

test('补材料重分析：仅 new/analyzed 触发', () => {
  assert.equal(shouldReanalyzeOnAttach('new'), true);
  assert.equal(shouldReanalyzeOnAttach('analyzed'), true);
});

test('补材料重分析：reviewing/challenged/analyzing 不触发（防冲掉评审态/质疑态）', () => {
  assert.equal(shouldReanalyzeOnAttach('reviewing'), false);
  assert.equal(shouldReanalyzeOnAttach('challenged'), false);
  assert.equal(shouldReanalyzeOnAttach('analyzing'), false);
});
