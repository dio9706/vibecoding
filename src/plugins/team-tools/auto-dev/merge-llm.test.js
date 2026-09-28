/**
 * 自动合并 LLM 兜底的单测：prompt 纯函数的硬纪律 + resolver 的成功/失败/超时三条出口。
 * 真实模型调用经 deps 注入桩替换——这里要钉的是「我们让模型做什么、它的回答怎么被解读」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMergeConflictPrompt, buildStashMergePrompt, MERGE_LLM_TIMEOUT_MS } from './merge-llm.logic.js';
import { createMergeResolver } from './merge-llm.js';

// ---- prompt：两条 prompt 共同的硬纪律 ----

test('两个 prompt 都禁止模型自己 commit —— 防谎报闸全靠调用方统一提交', () => {
  for (const p of [
    buildMergeConflictPrompt({ source: 'auto/t1', target: 'v6.2.0', files: ['a.vue'] }),
    buildStashMergePrompt({ source: 'auto/t1', target: 'v6.2.0', files: ['a.vue'] }),
  ]) {
    assert.match(p, /不要执行 git add \/ git commit/);
  }
});

test('两个 prompt 都限定只改冲突文件 —— 顺手重构会把无关改动卷进合并提交', () => {
  for (const p of [
    buildMergeConflictPrompt({ source: 'a', target: 'b', files: ['x.ts'] }),
    buildStashMergePrompt({ source: 'a', target: 'b', files: ['x.ts'] }),
  ]) {
    assert.match(p, /只改冲突文件|只改冲突文件/);
  }
});

// ---- buildMergeConflictPrompt ----

test('解冲突 prompt：带上分支名、冲突文件与任务意图', () => {
  const p = buildMergeConflictPrompt({
    source: 'auto/t_abc',
    target: 'v6.2.0',
    files: ['src/pages/chat/index.vue'],
    task: { title: '点头像没出系统行', detail: '详细描述若干' },
  });
  assert.match(p, /auto\/t_abc/);
  assert.match(p, /v6\.2\.0/);
  assert.match(p, /src\/pages\/chat\/index\.vue/);
  assert.match(p, /点头像没出系统行/);
  assert.match(p, /详细描述若干/);
});

test('解冲突 prompt：明令禁止整块选一边 —— 那会静默丢掉一侧的意图', () => {
  const p = buildMergeConflictPrompt({ source: 'a', target: 'b', files: ['x'] });
  assert.match(p, /不要简单地整块选一边/);
  assert.match(p, /--ours/);
  assert.match(p, /--theirs/);
});

test('解冲突 prompt：无 task 时不渲染空标题行', () => {
  const p = buildMergeConflictPrompt({ source: 'a', target: 'b', files: ['x'] });
  assert.doesNotMatch(p, /源分支要解决的问题：\s*\n/);
  assert.doesNotMatch(p, /详细描述：\s*\n/);
});

// ---- buildStashMergePrompt ----

test('融合 prompt：讲清两侧冲突标记的语义 —— 认反了就会把维护者的活当成旧代码删掉', () => {
  const p = buildStashMergePrompt({ source: 'auto/t1', target: 'v6.2.0', files: ['a.vue'] });
  assert.match(p, /Updated upstream/);
  assert.match(p, /Stashed changes/);
  assert.match(p, /刚合并进来的代码/);
  assert.match(p, /维护者本地未提交、正在写的代码/);
});

test('融合 prompt：要求两边都保留，且不许替维护者补全或删除半成品', () => {
  const p = buildStashMergePrompt({ source: 'a', target: 'b', files: ['x'] });
  assert.match(p, /两边都要保留/);
  assert.match(p, /半成品/);
  assert.match(p, /不要替他补全、不要替他删除/);
  assert.match(p, /没有任何备份/);
});

test('融合 prompt：禁止 git stash drop —— 那是改动的最后一份拷贝', () => {
  const p = buildStashMergePrompt({ source: 'a', target: 'b', files: ['x'] });
  assert.match(p, /git stash drop/);
});

// ---- 文件清单渲染 ----

test('冲突文件超过 30 个时截断并提示自查，不把清单铺满 prompt', () => {
  const files = Array.from({ length: 42 }, (_, i) => `src/f${i}.ts`);
  const p = buildMergeConflictPrompt({ source: 'a', target: 'b', files });
  assert.match(p, /另有 12 个文件/);
  assert.ok(!p.includes('src/f41.ts'), '第 31 个之后不该逐条列出');
  assert.match(p, /src\/f0\.ts/);
});

test('冲突文件清单为空时给出可操作的兜底话术，不留空白', () => {
  const p = buildStashMergePrompt({ source: 'a', target: 'b', files: [] });
  assert.match(p, /git status/);
});

// ---- resolver 三条出口 ----

test('resolveConflict：模型调用成功 → ok:true，且 prompt 带上了 task 上下文', async () => {
  let seen = null;
  const resolver = createMergeResolver(
    { task: { title: '某个BUG' } },
    { callLlm: async (prompt, dir) => ((seen = { prompt, dir }), { ok: true }) },
  );
  const r = await resolver.resolveConflict({ dir: 'D:/repo', source: 'auto/t1', target: 'main', files: ['a.ts'] });
  assert.equal(r.ok, true);
  assert.equal(seen.dir, 'D:/repo', '必须在合并所在目录执行，不是仓库根');
  assert.match(seen.prompt, /某个BUG/);
});

test('resolveConflict：模型调用失败 → ok:false 且错误可读', async () => {
  const resolver = createMergeResolver({}, { callLlm: async () => ({ ok: false, error: '额度耗尽' }) });
  const r = await resolver.resolveConflict({ dir: 'd', source: 's', target: 't', files: [] });
  assert.equal(r.ok, false);
  assert.match(r.error, /AI 解冲突失败/);
  assert.match(r.error, /额度耗尽/);
});

test('mergeStash：超时 → ok:false，措辞区分于解冲突（两者排查路径不同）', async () => {
  const resolver = createMergeResolver(
    {},
    { callLlm: () => new Promise(() => {}), timeoutMs: 20 }, // 永不 resolve
  );
  const r = await resolver.mergeStash({ dir: 'd', source: 's', target: 't', files: ['a'] });
  assert.equal(r.ok, false);
  assert.match(r.error, /融合本地改动/);
  assert.doesNotMatch(r.error, /解冲突/);
});

test('mergeStash：模型成功 → ok:true', async () => {
  const resolver = createMergeResolver({}, { callLlm: async () => ({ ok: true }) });
  assert.equal((await resolver.mergeStash({ dir: 'd', source: 's', target: 't', files: ['a'] })).ok, true);
});

test('超时常量为 5 分钟，与 revert / side-review 的兜底口径一致', () => {
  assert.equal(MERGE_LLM_TIMEOUT_MS, 5 * 60_000);
});
