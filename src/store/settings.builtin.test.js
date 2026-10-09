/**
 * 内置能力开关的真落盘读写回归。
 *
 * 与 settings.test.js（纯函数）分开的原因：本组会写 settings.json，
 * 必须先把 APP_DATA_DIR 指到临时目录，不能污染开发者本机的真实设置。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-builtin-'));

const { setBuiltinMcp, getBuiltinMcp, setBuiltinSkill, setBuiltinSkillItem, getBuiltinSkills } = await import('./settings.js');

test('setBuiltinMcp：写入、局部更新不动密钥、空串清密钥、未知 id 抛错', () => {
  setBuiltinMcp('context7', { enabled: false, apiKey: ' k1 ' });
  assert.deepEqual(getBuiltinMcp().context7, { enabled: false, apiKey: 'k1' });

  setBuiltinMcp('context7', { enabled: true });
  assert.deepEqual(getBuiltinMcp().context7, { enabled: true, apiKey: 'k1' }, '只改 enabled 不得动密钥');

  setBuiltinMcp('context7', { apiKey: '' });
  assert.deepEqual(getBuiltinMcp().context7, { enabled: true }, '空串 = 清除密钥（不留空值）');

  assert.throws(() => setBuiltinMcp('nope', { enabled: true }), /未知的内置 MCP/);
});

test('setBuiltinSkill：写入与未知 id 抛错', () => {
  setBuiltinSkill('superpowers', true);
  assert.deepEqual(getBuiltinSkills().superpowers, { enabled: true });
  setBuiltinSkill('superpowers', false);
  assert.deepEqual(getBuiltinSkills().superpowers, { enabled: false });
  assert.throws(() => setBuiltinSkill('nope', true), /未知的内置 Skill/);
});

test('setBuiltinSkillItem：只维护停用清单、恢复后清理空数组、未知技能抛错', () => {
  setBuiltinSkillItem('superpowers', 'brainstorming', false);
  setBuiltinSkillItem('superpowers', 'using-superpowers', false);
  assert.deepEqual(getBuiltinSkills().superpowers.disabledSkills, ['brainstorming', 'using-superpowers'], '稳定排序');
  assert.equal(getBuiltinSkills().superpowers.enabled, false, 'per-skill 更新不动包总开关');

  setBuiltinSkillItem('superpowers', 'brainstorming', true);
  assert.deepEqual(getBuiltinSkills().superpowers.disabledSkills, ['using-superpowers']);
  setBuiltinSkillItem('superpowers', 'using-superpowers', true);
  assert.equal('disabledSkills' in getBuiltinSkills().superpowers, false, '全恢复启用后不留空数组');

  assert.throws(() => setBuiltinSkillItem('superpowers', 'nope', false), /未知的技能项/);
  assert.throws(() => setBuiltinSkillItem('ghost', 'brainstorming', false), /未知的内置 Skill/);
});
