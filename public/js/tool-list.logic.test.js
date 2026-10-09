/**
 * 工具清单分叉单测：两家工具集互不串台、id 唯一、openai 不得出现 Claude 专属工具。
 * 这里的错配是「UI 显示的工具根本不是那条路径跑的」——用户关了没反应、真工具关不掉。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_BUILTIN_TOOLS, OPENAI_BUILTIN_TOOLS, builtinToolsFor } from './tool-list.logic.js';

test('builtinToolsFor：openai-compat 走 openai 清单；其它（含未知/缺省）走 Claude 清单', () => {
  assert.equal(builtinToolsFor('openai-compat'), OPENAI_BUILTIN_TOOLS);
  assert.equal(builtinToolsFor('claude-agent'), CLAUDE_BUILTIN_TOOLS);
  assert.equal(builtinToolsFor(undefined), CLAUDE_BUILTIN_TOOLS);
  assert.equal(builtinToolsFor('weird'), CLAUDE_BUILTIN_TOOLS);
});

test('openai 清单 = 真实装配的工具集；不得含 Claude 专属的 Workflow', () => {
  const ids = OPENAI_BUILTIN_TOOLS.map((t) => t.id);
  for (const id of ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'RepoMap', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task', 'AskColleague', 'WaitColleagueReply']) {
    assert.ok(ids.includes(id), `openai 清单缺 ${id}`);
  }
  // Workflow（多智能体编排）openai 侧暂缓实现，仍是 Claude 专属
  assert.equal(ids.includes('Workflow'), false, 'openai 清单不应含 Workflow（暂缓）');
});

test('Claude 清单保持原样：含 SDK 全套、不含 openai 专属项', () => {
  const ids = CLAUDE_BUILTIN_TOOLS.map((t) => t.id);
  for (const id of ['Bash', 'Write', 'Edit', 'Read', 'Grep', 'WebSearch', 'WebFetch', 'Task', 'Workflow', 'TodoWrite']) {
    assert.ok(ids.includes(id), `Claude 清单缺 ${id}`);
  }
  for (const id of ['Glob', 'RepoMap', 'AskColleague', 'WaitColleagueReply']) {
    assert.equal(ids.includes(id), false, `Claude 清单不应含 ${id}（其 Glob/LS 已并入 Grep 行）`);
  }
});

test('两份清单：条目形状完整（id/label/desc）、id 各自唯一', () => {
  for (const list of [CLAUDE_BUILTIN_TOOLS, OPENAI_BUILTIN_TOOLS]) {
    const seen = new Set();
    for (const t of list) {
      assert.ok(t.id && typeof t.id === 'string');
      assert.ok(t.label && typeof t.label === 'string');
      assert.ok(t.desc && typeof t.desc === 'string');
      assert.equal(seen.has(t.id), false, `重复 id：${t.id}`);
      seen.add(t.id);
    }
  }
});
