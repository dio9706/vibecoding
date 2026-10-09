/**
 * 只读子代理纯函数层单测：工具子集过滤（含禁递归）/ system prompt / 工具定义形状。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  READONLY_SUBAGENT_TOOL_NAMES,
  pickReadonlyToolDefs,
  buildSubagentSystemPrompt,
  SUBAGENT_TOOL_DEF,
} from './subagent.logic.js';

test('pickReadonlyToolDefs：只挑只读子集；写/命令/清单/Task 一律剥掉', () => {
  const defs = {
    Read: 1,
    Write: 1,
    Edit: 1,
    Bash: 1,
    Glob: 1,
    Grep: 1,
    WebFetch: 1,
    WebSearch: 1,
    RepoMap: 1,
    Task: 1,
    TodoWrite: 1,
    AskColleague: 1,
  };
  const out = pickReadonlyToolDefs(defs);
  assert.deepEqual(Object.keys(out).sort(), ['Glob', 'Grep', 'Read', 'RepoMap', 'WebFetch', 'WebSearch']);
  assert.equal('Task' in out, false, '子集不含 Task → 天然禁递归');
  assert.deepEqual(pickReadonlyToolDefs(null), {});
  assert.deepEqual(pickReadonlyToolDefs({ Write: 1 }), {});
});

test('READONLY_SUBAGENT_TOOL_NAMES：白名单与拍板一致（写/命令不在内）', () => {
  for (const bad of ['Write', 'Edit', 'Bash', 'Task', 'TodoWrite']) {
    assert.equal(READONLY_SUBAGENT_TOOL_NAMES.includes(bad), false, `${bad} 不应在只读子集`);
  }
});

test('buildSubagentSystemPrompt：含只读角色与 cwd；无 cwd 也不炸', () => {
  const p = buildSubagentSystemPrompt({ cwd: 'C:/proj' });
  assert.match(p, /只读探查子代理/);
  assert.match(p, /C:\/proj/);
  assert.match(p, /不能写文件或执行命令/);
  assert.doesNotMatch(buildSubagentSystemPrompt({}), /工作目录/);
});

test('SUBAGENT_TOOL_DEF：description 完整、inputSchema 在场（description + prompt）', () => {
  assert.ok(SUBAGENT_TOOL_DEF.description.includes('只读'));
  assert.ok(SUBAGENT_TOOL_DEF.inputSchema, 'schema 必须在场（AI SDK 需要）');
});
