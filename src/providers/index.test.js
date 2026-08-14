import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, has, list } from './index.js';

test('默认注册表含内置 claude-agent', () => {
  assert.equal(has('claude-agent'), true);
  assert.equal(get('claude-agent').id, 'claude-agent');
});

test('claude-agent 能力全开且可 run', () => {
  const p = get('claude-agent');
  assert.equal(p.capabilities.agentic, true);
  assert.equal(typeof p.run, 'function');
});

test('list 至少含 claude-agent 一项', () => {
  assert.ok(list().some((e) => e.id === 'claude-agent'));
});
