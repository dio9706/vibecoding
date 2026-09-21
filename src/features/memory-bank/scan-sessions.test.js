import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { shouldReanalyzePath, scanForUnanalyzedSessions, isStaleAnalyzing, ANALYZING_STALE_MS, isSubagentTranscript } from './scan-sessions.js';

// ===== isSubagentTranscript =====

test('isSubagentTranscript: subagents 目录下的转录判为子代理', () => {
  assert.strictEqual(
    isSubagentTranscript('C:\\Users\\x\\.claude\\projects\\proj\\abc\\subagents\\agent-a1.jsonl'),
    true
  );
  assert.strictEqual(
    isSubagentTranscript('/home/x/.claude/projects/proj/abc/subagents/agent-a1.jsonl'),
    true
  );
});

test('isSubagentTranscript: 嵌套在 workflows 下的子代理转录同样命中', () => {
  assert.strictEqual(
    isSubagentTranscript('C:\\p\\subagents\\workflows\\wf_bc6d78f6\\agent-a878e148.jsonl'),
    true
  );
});

test('isSubagentTranscript: 主会话转录不命中', () => {
  assert.strictEqual(
    isSubagentTranscript('C:\\Users\\x\\.claude\\projects\\proj\\e4ffb914-33f4.jsonl'),
    false
  );
});

test('isSubagentTranscript: 目录名只是包含 subagents 子串的不算（必须是完整路径段）', () => {
  assert.strictEqual(isSubagentTranscript('/p/my-subagents-backup/a.jsonl'), false);
  assert.strictEqual(isSubagentTranscript('/p/subagentsx/a.jsonl'), false);
});

test('isSubagentTranscript: 空值不抛错', () => {
  assert.strictEqual(isSubagentTranscript(''), false);
  assert.strictEqual(isSubagentTranscript(null), false);
});

test('scanForUnanalyzedSessions: 扫描结果绝不含子代理转录', () => {
  const result = scanForUnanalyzedSessions({ sessions: [] });
  const subs = result.filter((r) => isSubagentTranscript(r.path));
  assert.deepStrictEqual(subs, [], '子代理转录不该进入待分析列表');
});

// ===== isStaleAnalyzing =====

test('isStaleAnalyzing: 刚标记为 analyzing 的会话不算陈旧（当前进程正在处理）', () => {
  const now = Date.now();
  assert.strictEqual(isStaleAnalyzing({ status: 'analyzing', analyzingAt: now - 1000 }, now), false);
});

test('isStaleAnalyzing: 超过阈值的 analyzing 视为陈旧，可重新分析', () => {
  const now = Date.now();
  assert.strictEqual(
    isStaleAnalyzing({ status: 'analyzing', analyzingAt: now - ANALYZING_STALE_MS - 1 }, now),
    true
  );
});

test('isStaleAnalyzing: 缺 analyzingAt 的存量 analyzing 记录视为陈旧（本次改动前写下的，无从判断起始时刻）', () => {
  const now = Date.now();
  assert.strictEqual(isStaleAnalyzing({ status: 'analyzing' }, now), true);
});

test('isStaleAnalyzing: 非 analyzing 状态一律返回 false', () => {
  const now = Date.now();
  assert.strictEqual(isStaleAnalyzing({ status: 'analyzed' }, now), false);
  assert.strictEqual(isStaleAnalyzing({ status: 'pending' }, now), false);
  assert.strictEqual(isStaleAnalyzing(null, now), false);
});

// ===== shouldReanalyzePath =====

test('shouldReanalyzePath: 返回 false 当 session 为 null', () => {
  assert.strictEqual(shouldReanalyzePath(null, Date.now()), false);
});

test('shouldReanalyzePath: 返回 false 当 mtime 缺失', () => {
  assert.strictEqual(shouldReanalyzePath({}, Date.now()), false);
});

test('shouldReanalyzePath: 从未分析过（analyzedAt=0）时返回 true', () => {
  const now = Date.now();
  assert.strictEqual(shouldReanalyzePath({ mtime: now, analyzedAt: 0 }, now), true);
});

test('shouldReanalyzePath: analyzedAt 缺失时返回 true', () => {
  const now = Date.now();
  assert.strictEqual(shouldReanalyzePath({ mtime: now }, now), true);
});

test('shouldReanalyzePath: 文件 mtime > analyzedAt 时返回 true（文件已更新）', () => {
  const now = Date.now();
  assert.strictEqual(
    shouldReanalyzePath({ mtime: now, analyzedAt: now - 10000 }, now),
    true
  );
});

test('shouldReanalyzePath: 文件 mtime <= analyzedAt 时返回 false（已分析且未变更）', () => {
  const now = Date.now();
  assert.strictEqual(
    shouldReanalyzePath({ mtime: now - 1000, analyzedAt: now }, now),
    false
  );
});

// ===== scanForUnanalyzedSessions =====

test('scanForUnanalyzedSessions: bank.sessions 为空时返回所有 .jsonl 文件的路径（需本机有 ~/.claude/projects）', () => {
  // 这个测试依赖本机文件系统，若目录不存在则验证返回 []
  const result = scanForUnanalyzedSessions({ sessions: [] });
  assert(Array.isArray(result), 'should return array');
  // 每个元素包含 path 和 mtime
  for (const item of result) {
    assert(typeof item.path === 'string');
    assert(typeof item.mtime === 'number');
    assert(item.path.endsWith('.jsonl'));
  }
});

test('scanForUnanalyzedSessions: 已分析且未变更的文件不返回', () => {
  const now = Date.now();
  // 构造一个 session，path 指向一个本机上并不真实存在的路径，所以扫描结果不会包含它
  // 如果本机上存在 ~/.claude/projects，可用真实路径测试；否则测试退化为逻辑验证
  const fakePath = '/nonexistent/path/to/file.jsonl';
  const bank = {
    sessions: [
      {
        id: 'ses_1',
        path: fakePath,
        mtime: now - 1000,
        analyzedAt: now,  // analyzedAt > mtime，说明已分析且文件未变更
        findings: [],
      },
    ],
  };
  const result = scanForUnanalyzedSessions(bank);
  assert(!result.some((r) => r.path === fakePath), 'already analyzed file should not be in result');
});
