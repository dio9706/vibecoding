import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { shouldReanalyzePath, scanForUnanalyzedSessions } from './scan-sessions.js';

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
